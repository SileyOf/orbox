import type { User } from '../auth.js';
import { askAssistant, resetSession } from '../ai/agent.js';
import { summarize, translate } from '../ai/features.js';
import { resolveTask } from '../ai/tasks.js';
import { takePending } from '../ai/tools.js';
import { one } from '../db.js';
import { worker } from '../mail/manager.js';
import { sendMail } from '../mail/send.js';
import { moveMessages, setFlag } from '../routes/mail.js';
import { formatWhen, parseQuickTask } from '../tasks/parse.js';
import { completeTask, createTask, deleteTask, dueToday, skipTask, snoozeTask } from '../tasks/service.js';
import { deleteNotes, quickNote } from '../notes/service.js';
import { fullMailCard, helpText, inboxCard, linksCard, loadMail, taskCard } from './cards.js';
import type { BotIO, Card, Platform } from './types.js';
import { plain } from './types.js';

const PLATFORM_NAMES: Record<Platform, string> = { telegram: 'Telegram', feishu: '飞书', discord: 'Discord', slack: 'Slack' };

/** 正文可能还没下载（快速通道只取了开头），阅读前补齐 */
async function fullMail(user: User, id: number) {
  let m = await loadMail(user.id, id);
  if (m && !m.body_fetched) {
    await worker(m.account_id).loadBody(id).catch(() => {});
    m = await loadMail(user.id, id);
  }
  return m;
}

async function aiAnswer(user: User, platform: Platform, text: string, io: BotIO) {
  const reply = await askAssistant(user, PLATFORM_NAMES[platform], text);
  await io.reply({ tone: 'ai', text: reply.text });
  for (const p of reply.pending) {
    await io.reply({
      tone: 'warn',
      title: '待确认的邮件',
      text: plain(p.summary),
      buttons: [[{ text: '发送', action: `ai:send:${p.id}` }, { text: '取消', action: `ai:drop:${p.id}` }]],
    });
  }
}

export async function handleAction(user: User, platform: Platform, action: string, io: BotIO): Promise<void> {
  const [kind, verb, idStr, extra] = action.split(':');
  const id = Number(idStr);
  try {
    if (action === 'inbox') return void (await io.reply(await inboxCard(user)));
    if (kind === 'n' && verb === 'x') {
      await deleteNotes(user.id, [id]);
      return io.note('已撤销');
    }

    if (kind === 'm') {
      const m = await loadMail(user.id, id);
      if (!m) return io.note('邮件已被移动或删除');
      switch (verb) {
        case 'r':
          await setFlag(user.id, [id], 'seen', true);
          return io.note('已标记已读');
        case 'a':
          await setFlag(user.id, [id], 'seen', true);
          await moveMessages(user.id, [id], 'archive');
          return io.note('已归档');
        case 't': {
          const ref = await one<{ message_id: string | null }>('SELECT message_id FROM messages WHERE id = ?', [id]);
          await createTask(user.id, user.timezone, {
            title: `处理邮件：${m.subject || '(无主题)'}`.slice(0, 480),
            mailRef: ref?.message_id,
            mailSubject: m.subject,
            nagInterval: user.settings.nagInterval,
            source: platform,
          });
          return io.note('已加入待办');
        }
        case 'f': {
          await io.note('正在加载全文…');
          const full = await fullMail(user, id);
          if (!full) return;
          await io.reply(fullMailCard(user, full));
          if (!full.seen) await setFlag(user.id, [id], 'seen', true).catch(() => {});
          return;
        }
        case 'at': {
          const atts = (m.attachments || []).filter((a) => !a.inline);
          if (!atts.length) return io.note('没有附件');
          await io.note(`正在发送 ${atts.length} 个附件…`);
          const body = await worker(m.account_id).fetchSource(id);
          for (const a of atts) {
            const raw = body.raw[a.i];
            // 各平台的机器人文件上限都在几十 MB，超过的给出提示
            if (!raw || raw.size > 45 * 1024 * 1024) {
              await io.reply({ tone: 'info', text: `附件 ${plain(a.filename)} 太大，请在网页里下载。` });
              continue;
            }
            await io.file(a.filename, raw.content, raw.contentType || 'application/octet-stream');
          }
          return;
        }
        case 'l': {
          const full = await fullMail(user, id);
          return void (await io.reply(linksCard(full || m)));
        }
        case 's':
          await io.note('正在生成摘要…');
          return void (await io.reply({ tone: 'ai', title: `摘要 · ${plain(m.subject).slice(0, 40)}`, text: await summarize(user, id) }));
        case 'tr':
          await io.note('正在翻译…');
          return void (await io.reply({
            tone: 'ai',
            title: `翻译（${user.settings.translateTo}）`,
            text: plain(await translate(user, id)),
            buttons: [[{ text: '已读', action: `m:r:${id}` }, { text: '归档', action: `m:a:${id}` }]],
          }));
      }
    }

    if (kind === 't') {
      if (verb === 'x') {
        await deleteTask(user.id, id);
        return io.note('已撤销');
      }
      if (verb === 's') {
        const until = new Date(Date.now() + Number(extra || 10) * 60_000);
        const task = await snoozeTask(user.id, id, until);
        return io.note(task?.status === 'open' ? `${formatWhen(until, user.timezone)} 再提醒` : '任务已完成或不存在');
      }
      const task = verb === 'd' ? await completeTask(user.id, user.timezone, id, platform) : await skipTask(user.id, user.timezone, id, platform);
      if (!task) return io.note('任务不存在');
      const next = task.status === 'open' && task.repeat_rule && task.due_at ? `，下次 ${formatWhen(task.due_at, user.timezone)}` : '';
      return io.note(`${verb === 'd' ? '✅ 已完成' : '已跳过'}${next}`);
    }

    if (kind === 'ai') {
      const pending = takePending(user.id, verb === 'send' || verb === 'drop' ? idStr : '');
      if (!pending) return io.note('这封草稿已经处理过或已过期');
      if (verb === 'drop') return io.note('已取消，没有发送');
      await sendMail(user, pending.input, []);
      return io.note('✉️ 已发送');
    }
    await io.note('这个按钮已失效');
  } catch (e) {
    await io.note(`出错了：${(e as Error).message}`);
  }
}

export async function handleText(user: User, platform: Platform, raw: string, io: BotIO): Promise<void> {
  const text = raw.trim();
  // "记 打车 56 报销" / "记一笔 午饭 38" / "/note …"：直接记到简单记，不经过 AI
  const note = text.match(/^(?:\/note(?:@\S+)?|记一笔|记账|记)[\s:：]+([\s\S]+)$/i);
  if (note) return quickNoteReply(user, platform, note[1], io);
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  try {
    switch (cmd.toLowerCase().replace(/@.*$/, '')) {
      case '/start':
      case '/help':
      case '帮助':
        return io.reply({ tone: 'info', text: helpText() });
      case '/inbox':
      case '未读':
        return io.reply(await inboxCard(user));
      case '/today':
      case '今天': {
        const tasks = await dueToday(user.id, user.timezone);
        if (!tasks.length) return io.reply({ tone: 'info', text: '今天没有待办 🎉' });
        for (const t of tasks.slice(0, 10)) await io.reply({ ...taskCard(user, t), title: undefined });
        return;
      }
      case '/reset':
        resetSession(user.id, PLATFORM_NAMES[platform]);
        return io.reply({ tone: 'info', text: '好的，开始新的对话。' });
      case '/add':
        return quickAdd(user, platform, arg, io);
    }
    // 没配置 AI 时，普通消息当作一句话新建计划（说出差相关的就记到简单记）；配置了就交给助手
    if (!(await resolveTask(user, 'assistant'))) {
      if (/^(今天|昨天)?\s*(开始)?出差|出差(结束|回来)/.test(text)) return quickNoteReply(user, platform, text, io);
      return quickAdd(user, platform, text, io);
    }
    await aiAnswer(user, platform, text, io);
  } catch (e) {
    await io.reply({ tone: 'warn', text: `出错了：${plain((e as Error).message)}` });
  }
}

async function quickNoteReply(user: User, platform: Platform, text: string, io: BotIO) {
  const r = await quickNote(user, text, platform);
  if (r.tripEnded) return io.reply({ tone: 'info', text: `「${plain(r.tripEnded)}」已结束。在网页的 计划 → 简单记 里可以按这次出差汇总、导出报销表。` });
  if (r.trip) return io.reply({ tone: 'info', text: `已开始 **${plain(r.trip)}**，之后记的花费会自动归到这次出差、标为可报销。回来后发"出差结束"。` });
  const n = r.note!;
  const money = n.amount !== null ? ` · ${n.currency === 'CNY' ? '¥' : `${n.currency} `}${Number(n.amount)}` : '';
  const flags = [n.category, n.reimbursable ? '可报销' : '', ...(n.tags || [])].filter(Boolean).join(' · ');
  await io.reply({ tone: 'info', text: `已记下：**${plain(n.content)}**${money}\n${n.day} · ${plain(flags)}`, buttons: [[{ text: '撤销', action: `n:x:${n.id}` }]] });
}

async function quickAdd(user: User, platform: Platform, text: string, io: BotIO) {
  if (!text.trim()) return io.reply({ tone: 'info', text: '发送"/add 明天9点 交报告"这样的一句话即可。' });
  const quick = parseQuickTask(text, user.timezone);
  const task = await createTask(user.id, user.timezone, {
    title: quick.title.slice(0, 480),
    dueAt: quick.dueAt,
    nagInterval: user.settings.nagInterval,
    source: platform,
  });
  const card: Card = {
    tone: 'task',
    text: `已添加：**${plain(task.title)}**\n${quick.dueAt ? `🕐 ${formatWhen(quick.dueAt, user.timezone)}` : '未识别到时间，已作为无期限待办'}`,
    buttons: [[{ text: '撤销', action: `t:x:${task.id}` }]],
  };
  await io.reply(card);
}
