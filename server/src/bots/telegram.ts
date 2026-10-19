import { Bot, InlineKeyboard, InputFile } from 'grammy';
import type { Context } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../config.js';
import { inboundAction, inboundText } from './hub.js';
import type { Adapter, BotIO, Card } from './types.js';
import { splitCard, spans } from './types.js';

let bot: Bot | null = null;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function html(card: Card): string {
  const body = spans(card.text)
    .map((s) =>
      s.t === 'bold' ? `<b>${esc(s.v)}</b>` : s.t === 'code' ? `<code>${esc(s.v)}</code>` : s.t === 'link' ? `<a href="${esc(s.url)}">${esc(s.v)}</a>` : esc(s.v),
    )
    .join('');
  return card.title ? `<b>${esc(card.title)}</b>\n${body}` : body;
}

export function keyboard(card: Card): InlineKeyboard | undefined {
  if (!card.buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  card.buttons.forEach((row, i) => {
    // 只在两行之间换行，末尾多出的空行会被 Telegram 拒绝
    if (i > 0) kb.row();
    for (const b of row) {
      if (b.copy) kb.copyText(b.text, b.copy);
      else if (b.url) kb.url(b.text, b.url);
      // callback_data 最长 64 字节
      else if (b.action && Buffer.byteLength(b.action) <= 64) kb.text(b.text, b.action);
    }
  });
  return kb;
}

async function sendCard(chatId: string | number, card: Card) {
  for (const part of splitCard(card, 3800)) {
    await bot!.api.sendMessage(Number(chatId), html(part), {
      parse_mode: 'HTML',
      reply_markup: keyboard(part),
      link_preview_options: { is_disabled: true },
    });
  }
}

function ioFor(ctx: Context): BotIO {
  let answered = false;
  return {
    reply: (card) => sendCard(ctx.chat!.id, card),
    file: async (name, data) => void (await ctx.replyWithDocument(new InputFile(data, name))),
    async note(text) {
      if (!answered) {
        answered = true;
        await ctx.answerCallbackQuery({ text: text.slice(0, 190) }).catch(() => {});
      }
      const msg = ctx.callbackQuery?.message;
      // 进度类提示（以省略号结尾）只弹出提示；结果类提示同时标注在原消息末尾，避免重复点击
      if (!msg || !ctx.callbackQuery || text.endsWith('…')) return;
      await ctx.api
        .editMessageText(msg.chat.id, msg.message_id, `${msg.text ?? ''}\n\n— ${text}`, {
          entities: msg.entities,
          reply_markup: msg.reply_markup,
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {});
    },
  };
}

export const telegram: Adapter = {
  platform: 'telegram',
  label: 'Telegram',
  enabled: () => !!config.telegramToken,
  name: () => bot?.botInfo.username ?? null,
  bindHint: (code) => ({ url: `https://t.me/${bot?.botInfo.username}?start=${code}`, text: '点击链接打开机器人，按 Start 即可完成绑定' }),

  async start() {
    // 服务器直连不了 Telegram 时（例如在国内开发）可通过 TELEGRAM_PROXY 走 HTTP 代理
    const agent = config.telegramProxy ? new HttpsProxyAgent(config.telegramProxy) : undefined;
    const b = new Bot(config.telegramToken, { client: { baseFetchConfig: { agent, compress: true } } });
    for (let delay = 5_000; ; delay = Math.min(delay * 2, 5 * 60_000)) {
      try {
        await b.init();
        break;
      } catch (e: any) {
        if (e?.error_code === 401 || e?.error_code === 404) throw new Error('Token 无效');
        console.error(`[telegram] 连接失败（${e.message}），${delay / 1000}s 后重试`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    b.on('message:text', (ctx) => inboundText('telegram', String(ctx.chat.id), ctx.message.text, ctx.from?.username || ctx.from?.first_name || '', ioFor(ctx)));
    b.on('callback_query:data', (ctx) => inboundAction('telegram', String(ctx.chat?.id ?? ctx.from.id), ctx.callbackQuery.data, ioFor(ctx)));
    b.catch((err) => console.error('[telegram]', err.error));
    await b.api
      .setMyCommands([
        { command: 'inbox', description: '未读邮件' },
        { command: 'today', description: '今日计划' },
        { command: 'add', description: '新建计划，如 /add 明天9点 交报告' },
        { command: 'reset', description: '开始新的 AI 对话' },
        { command: 'help', description: '使用说明' },
      ])
      .catch(() => {});
    bot = b;
    console.log(`[telegram] @${b.botInfo.username} 已启动`);
    void (async () => {
      while (bot === b) {
        try {
          await b.start();
          return;
        } catch (e: any) {
          const hint = e?.error_code === 409 ? '：这个 Token 正被另一个程序轮询，同一个机器人只能有一个实例' : '';
          console.error(`[telegram] 轮询中断（${e?.description || e?.message}）${hint}，15s 后重试`);
          await new Promise((r) => setTimeout(r, 15_000));
        }
      }
    })();
  },

  async stop() {
    const b = bot;
    bot = null;
    await b?.stop();
  },

  send: (chatId, card) => sendCard(chatId, card),
  async sendFile(chatId, name, data) {
    await bot!.api.sendDocument(Number(chatId), new InputFile(data, name));
  },
};
