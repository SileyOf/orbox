import { Bot, InlineKeyboard } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Context } from 'grammy';
import { DateTime } from 'luxon';
import { APP_NAME, config } from '../config.js';
import { getUser } from '../auth.js';
import type { User } from '../auth.js';
import { exec, one, query } from '../db.js';
import type { AccountRow } from '../mail/manager.js';
import { moveMessages, setFlag } from '../routes/mail.js';
import { formatWhen, parseQuickTask } from '../tasks/parse.js';
import { completeTask, createTask, deleteTask, dueToday, skipTask, snoozeTask } from '../tasks/service.js';
import type { TaskRow } from '../tasks/service.js';

let bot: Bot | null = null;

export const telegramEnabled = () => !!bot;
export const botUsername = () => bot?.botInfo.username ?? null;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
// Telegram 的链接按钮不接受 localhost 之类的地址
const linkable = config.publicUrl.startsWith('https://');

export async function chatIdOf(userId: number): Promise<number | null> {
  const row = await one<{ chat_id: string }>('SELECT chat_id FROM tg_links WHERE user_id = ?', [userId]);
  return row ? Number(row.chat_id) : null;
}

async function userOfChat(chatId: number): Promise<User | undefined> {
  const row = await one<{ user_id: number }>('SELECT user_id FROM tg_links WHERE chat_id = ?', [chatId]);
  return row ? getUser(Number(row.user_id)) : undefined;
}

async function send(userId: number, html: string, keyboard?: InlineKeyboard): Promise<boolean> {
  if (!bot) return false;
  const chatId = await chatIdOf(userId);
  if (!chatId) return false;
  await bot.api.sendMessage(chatId, html, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
  return true;
}

function inQuietHours(user: User): boolean {
  const { quietStart, quietEnd } = user.settings;
  if (quietStart === quietEnd) return false;
  const now = DateTime.now().setZone(user.timezone).toFormat('HH:mm');
  return quietStart < quietEnd ? now >= quietStart && now < quietEnd : now >= quietStart || now < quietEnd;
}

export async function notifyNewMail(account: AccountRow, messageId: number): Promise<void> {
  if (!bot || !account.notify) return;
  const user = await getUser(account.user_id);
  if (!user || !user.settings.notifyMail || inQuietHours(user)) return;
  const m = await one('SELECT id, subject, from_name, from_addr, snippet FROM messages WHERE id = ?', [messageId]);
  if (!m) return;
  const kb = new InlineKeyboard()
    .text('标记已读', `m:r:${m.id}`)
    .text('归档', `m:a:${m.id}`)
    .row()
    .text('转为待办', `m:t:${m.id}`);
  if (linkable) kb.url('打开', `${config.publicUrl}/mail?open=${m.id}`);
  const from = m.from_name ? `<b>${esc(m.from_name)}</b> &lt;${esc(m.from_addr)}&gt;` : `<b>${esc(m.from_addr)}</b>`;
  await send(
    user.id,
    `📬 ${from}\n<b>${esc(m.subject || '(无主题)')}</b>\n\n${esc(clip(m.snippet, 280))}\n\n<i>${esc(account.name)}</i>`,
    kb,
  );
}

const taskKeyboard = (id: number) =>
  new InlineKeyboard()
    .text('✅ 完成', `t:d:${id}`)
    .text('跳过', `t:k:${id}`)
    .row()
    .text('10 分钟后', `t:s:${id}:10`)
    .text('1 小时后', `t:s:${id}:60`)
    .text('明天', `t:s:${id}:1440`);

function taskLine(task: TaskRow, tz: string): string {
  const when = task.due_at ? `\n🕐 ${formatWhen(task.due_at, tz)}` : '';
  const notes = task.notes ? `\n${esc(clip(task.notes, 300))}` : '';
  return `<b>${esc(task.title)}</b>${when}${notes}`;
}

export async function notifyTaskReminder(task: TaskRow, nth: number): Promise<boolean> {
  const user = await getUser(task.user_id);
  if (!user) return false;
  const head = nth > 0 ? `🔔 还没完成（第 ${nth + 1} 次提醒）` : '⏰ 提醒';
  return send(user.id, `${head}\n${taskLine(task, user.timezone)}`, taskKeyboard(task.id));
}

export async function sendDigest(user: User): Promise<boolean> {
  const tasks = await dueToday(user.id, user.timezone);
  const unread = (await one<{ n: number }>(
    `SELECT COALESCE(SUM(f.unread), 0) AS n FROM folders f JOIN accounts a ON a.id = f.account_id
     WHERE a.user_id = ? AND f.role = 'inbox'`,
    [user.id],
  ))!.n;
  const now = DateTime.now().setZone(user.timezone);
  const lines = tasks.map((t) => {
    const due = DateTime.fromJSDate(t.due_at!, { zone: user.timezone });
    const overdue = due < now.startOf('day');
    return `${overdue ? '⚠️' : '•'} ${overdue ? due.toFormat('M/d') : due.toFormat('HH:mm')}  ${esc(clip(t.title, 80))}`;
  });
  const body = lines.length ? lines.join('\n') : '今天没有安排，轻松一点。';
  return send(
    user.id,
    `☀️ <b>早上好，${esc(user.name)}</b>\n${now.setLocale('zh-CN').toFormat('M月d日 cccc')}\n\n` +
      `<b>今日计划（${tasks.length}）</b>\n${body}\n\n📬 收件箱未读 ${unread} 封`,
  );
}

export async function sendTest(userId: number) {
  return send(userId, `✅ ${APP_NAME} 通知已连通。\n直接发一句话给我就能创建待办，例如：<code>明天9点 交报告</code>`);
}

const HELP = `我是 ${APP_NAME} 的通知助手：

• 新邮件到达时推送，可直接标记已读 / 归档 / 转为待办
• 计划到点提醒，点按钮完成或稍后再提醒
• 直接发送一句话创建待办，例如 <code>明天9点 交报告</code>

/today 今日计划
/add 新建待办
/unlink 解除绑定`;

/** 处理完按钮后去掉键盘并在原消息末尾标注结果，避免重复点击 */
async function settle(ctx: Context, note: string) {
  await ctx.answerCallbackQuery({ text: note });
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  await ctx.api
    .editMessageText(msg.chat.id, msg.message_id, `${msg.text ?? ''}\n\n— ${note}`, {
      entities: msg.entities,
      link_preview_options: { is_disabled: true },
    })
    .catch(() => {});
}

async function quickAdd(ctx: Context, user: User, text: string) {
  if (!text.trim()) return ctx.reply('发送「/add 明天9点 交报告」这样的一句话即可。');
  const quick = parseQuickTask(text, user.timezone);
  const task = await createTask(user.id, user.timezone, {
    title: clip(quick.title, 480),
    dueAt: quick.dueAt,
    nagInterval: user.settings.nagInterval,
    source: 'telegram',
  });
  const when = quick.dueAt ? `🕐 ${formatWhen(quick.dueAt, user.timezone)}` : '未识别到时间，已作为无期限待办';
  return ctx.reply(`已添加：<b>${esc(task.title)}</b>\n${when}`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('撤销', `t:x:${task.id}`),
  });
}

function register(b: Bot) {
  b.command('start', async (ctx) => {
    const code = ctx.match.trim();
    if (!code) return ctx.reply(`请在 ${APP_NAME} 网页「设置 → 通知」里点击绑定 Telegram。`);
    const row = await one<{ user_id: number }>(
      'SELECT user_id FROM tg_link_codes WHERE code = ? AND expires_at > UTC_TIMESTAMP()',
      [code],
    );
    if (!row) return ctx.reply('绑定码无效或已过期，请回到网页重新生成。');
    await exec('DELETE FROM tg_link_codes WHERE user_id = ?', [row.user_id]);
    await exec('DELETE FROM tg_links WHERE chat_id = ? OR user_id = ?', [ctx.chat.id, row.user_id]);
    await exec('INSERT INTO tg_links (user_id, chat_id, username) VALUES (?, ?, ?)', [
      row.user_id,
      ctx.chat.id,
      ctx.from?.username || ctx.from?.first_name || '',
    ]);
    return ctx.reply(`绑定成功 🎉\n\n${HELP}`, { parse_mode: 'HTML' });
  });

  // 以下所有交互都要求聊天已绑定账号
  b.use(async (ctx, next) => {
    const user = ctx.chat && (await userOfChat(ctx.chat.id));
    if (!user) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '请先绑定账号' });
      else await ctx.reply(`尚未绑定。请在 ${APP_NAME} 网页「设置 → 通知」里点击绑定 Telegram。`);
      return;
    }
    (ctx as any).user = user;
    await next();
  });
  const userOf = (ctx: Context) => (ctx as any).user as User;

  b.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));
  b.command('add', (ctx) => quickAdd(ctx, userOf(ctx), ctx.match));
  b.command('unlink', async (ctx) => {
    await exec('DELETE FROM tg_links WHERE user_id = ?', [userOf(ctx).id]);
    return ctx.reply('已解除绑定，之后不会再收到通知。');
  });
  b.command('today', async (ctx) => {
    const user = userOf(ctx);
    const tasks = await dueToday(user.id, user.timezone);
    if (!tasks.length) return ctx.reply('今天没有待办 🎉');
    for (const t of tasks.slice(0, 15)) {
      await ctx.reply(taskLine(t, user.timezone), { parse_mode: 'HTML', reply_markup: taskKeyboard(t.id) });
    }
  });

  b.callbackQuery(/^m:([rat]):(\d+)$/, async (ctx) => {
    const user = userOf(ctx);
    const [, action, idStr] = ctx.match;
    const id = Number(idStr);
    const m = await one<{ subject: string; message_id: string | null }>(
      'SELECT subject, message_id FROM messages WHERE id = ? AND user_id = ?',
      [id, user.id],
    );
    if (!m) return settle(ctx, '邮件已被移动或删除');
    if (action === 'r') {
      await setFlag(user.id, [id], 'seen', true);
      return settle(ctx, '已标记已读');
    }
    if (action === 'a') {
      await setFlag(user.id, [id], 'seen', true);
      await moveMessages(user.id, [id], 'archive');
      return settle(ctx, '已归档');
    }
    await createTask(user.id, user.timezone, {
      title: clip(`处理邮件：${m.subject || '(无主题)'}`, 480),
      mailRef: m.message_id,
      mailSubject: m.subject,
      source: 'telegram',
    });
    return settle(ctx, '已加入待办');
  });

  b.callbackQuery(/^t:([dksx]):(\d+)(?::(\d+))?$/, async (ctx) => {
    const user = userOf(ctx);
    const [, action, idStr, minutes] = ctx.match;
    const id = Number(idStr);
    if (action === 'x') {
      await deleteTask(user.id, id);
      return settle(ctx, '已撤销');
    }
    if (action === 's') {
      const until = new Date(Date.now() + Number(minutes || 10) * 60_000);
      const task = await snoozeTask(user.id, id, until);
      return settle(ctx, task?.status === 'open' ? `${formatWhen(until, user.timezone)} 再提醒` : '任务已完成或不存在');
    }
    const task =
      action === 'd'
        ? await completeTask(user.id, user.timezone, id, 'telegram')
        : await skipTask(user.id, user.timezone, id, 'telegram');
    if (!task) return settle(ctx, '任务不存在');
    const next =
      task.status === 'open' && task.repeat_rule && task.due_at
        ? `，下次 ${formatWhen(task.due_at, user.timezone)}`
        : '';
    return settle(ctx, `${action === 'd' ? '✅ 已完成' : '已跳过'}${next}`);
  });

  b.on('message:text', (ctx) => quickAdd(ctx, userOf(ctx), ctx.message.text));

  b.catch((err) => console.error('[telegram]', err.error));
}

/** 在后台启动：连不上 Telegram 时不阻塞整个服务，过一会儿自动重试 */
export async function startTelegram(): Promise<void> {
  if (!config.telegramToken) {
    console.log('[telegram] 未配置 TELEGRAM_BOT_TOKEN，通知功能未启用');
    return;
  }
  // 服务器直连不了 Telegram 时（例如在国内开发）可通过 TELEGRAM_PROXY 走 HTTP 代理
  const agent = config.telegramProxy ? new HttpsProxyAgent(config.telegramProxy) : undefined;
  const b = new Bot(config.telegramToken, { client: { baseFetchConfig: { agent, compress: true } } });
  for (let delay = 5_000; ; delay = Math.min(delay * 2, 5 * 60_000)) {
    try {
      await b.init();
      break;
    } catch (e: any) {
      // Token 无效重试也没用，其余情况（网络不通）稍后再试
      if (e?.error_code === 401 || e?.error_code === 404) {
        console.error('[telegram] Token 无效，通知功能未启用');
        return;
      }
      console.error(`[telegram] 连接失败（${e.message}），${delay / 1000}s 后重试`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  register(b);
  await b.api
    .setMyCommands([
      { command: 'today', description: '今日计划' },
      { command: 'add', description: '新建待办，如 /add 明天9点 交报告' },
      { command: 'help', description: '使用说明' },
    ])
    .catch(() => {});
  bot = b;
  console.log(`[telegram] @${b.botInfo.username} 已启动`);
  void poll(b);
}

/** 长轮询被打断（网络抖动，或同一个 Token 被别处占用）时不能拖垮进程，等一会儿重新接上 */
async function poll(b: Bot) {
  while (bot === b) {
    try {
      await b.start();
      return; // stop() 正常结束
    } catch (e: any) {
      const hint = e?.error_code === 409 ? '：这个 Token 正被另一个程序轮询，同一个机器人只能有一个实例' : '';
      console.error(`[telegram] 轮询中断（${e?.description || e?.message}）${hint}，15s 后重试`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

export async function stopTelegram() {
  const b = bot;
  bot = null;
  await b?.stop();
}

/** 每日早报：到点后一小时内补发，每个用户每天只发一次 */
export async function runDigests(): Promise<void> {
  if (!bot) return;
  const rows = await query<{ user_id: number; digest_last: string | null }>(
    `SELECT l.user_id, DATE_FORMAT(u.digest_last, '%Y-%m-%d') AS digest_last
     FROM tg_links l JOIN users u ON u.id = l.user_id`,
  );
  for (const row of rows) {
    const user = await getUser(Number(row.user_id));
    if (!user || !user.settings.digestTime) continue;
    const now = DateTime.now().setZone(user.timezone);
    const today = now.toISODate()!;
    if (row.digest_last === today) continue;
    const [h, m] = user.settings.digestTime.split(':').map(Number);
    const sinceDue = now.diff(now.set({ hour: h, minute: m, second: 0 }), 'minutes').minutes;
    if (sinceDue < 0 || sinceDue > 60) continue;
    await exec('UPDATE users SET digest_last = ? WHERE id = ?', [today, user.id]);
    await sendDigest(user).catch((e) => console.error('[digest]', e.message));
  }
}
