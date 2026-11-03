import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { integration, siteConfig } from '../site.js';
import { inboundAction, inboundText } from './hub.js';
import type { Adapter, BotIO, Button, Card } from './types.js';
import { splitCard } from './types.js';

// 飞书 / Lark：自建应用 + 长连接（WebSocket）接收消息和卡片按钮回调，不需要公网回调地址。

let channel: LarkChannel | null = null;
let botName: string | null = null;

const TEMPLATES: Record<NonNullable<Card['tone']>, string> = {
  mail: 'blue',
  code: 'green',
  task: 'orange',
  ai: 'violet',
  info: 'grey',
  warn: 'red',
};

function button(b: Button) {
  const behaviors = b.url ? [{ type: 'open_url', default_url: b.url }] : [{ type: 'callback', value: { a: b.action } }];
  return { tag: 'button', text: { tag: 'plain_text', content: b.text.slice(0, 40) }, type: 'default', size: 'small', behaviors };
}

/** 卡片 JSON 2.0。飞书卡片没有"复制"按钮，验证码以代码样式放进正文，长按即可复制 */
export function card(c: Card): object {
  const copies = (c.buttons || []).flat().filter((b) => b.copy);
  const text = c.text + copies.map((b) => `\n\n**${b.copy}**`).join('');
  const rows = (c.buttons || []).map((row) => row.filter((b) => !b.copy && (b.url || b.action))).filter((r) => r.length);
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    ...(c.title ? { header: { title: { tag: 'plain_text', content: c.title.slice(0, 100) }, template: TEMPLATES[c.tone || 'info'] } } : {}),
    body: {
      elements: [
        { tag: 'markdown', content: text },
        ...rows.map((row) => ({
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          columns: row.map((b) => ({ tag: 'column', width: 'auto', elements: [button(b)] })),
        })),
      ],
    },
  };
}

async function sendCard(chatId: string, c: Card) {
  for (const part of splitCard(c, 6000)) await channel!.send(chatId, { card: card(part) });
}

function ioFor(chatId: string): BotIO {
  return {
    reply: (c) => sendCard(chatId, c),
    file: async (name, data) => void (await channel!.send(chatId, { file: { source: data, fileName: name } })),
    // 飞书的卡片回调没有轻量提示，结果类反馈发一条短消息；进度类（省略号结尾）不发，避免刷屏
    note: async (text) => {
      if (!text.endsWith('…')) await channel!.send(chatId, { markdown: text });
    },
  };
}

export const feishu: Adapter = {
  platform: 'feishu',
  get label() {
    return integration('feishu').domain === 'lark' ? 'Lark' : '飞书';
  },
  enabled: () => !!(integration('feishu').appId && integration('feishu').appSecret),
  name: () => botName,
  bindHint: (code) => ({ text: `在${feishu.label}里搜索机器人「${botName}」，私聊发送：绑定 ${code}` }),

  async start() {
    const cfg = integration('feishu');
    const ch = createLarkChannel({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain: cfg.domain === 'lark' ? Domain.Lark : Domain.Feishu,
      loggerLevel: LoggerLevel.warn,
      source: 'orbox',
      // 只处理单聊；群里需要 @ 机器人
      policy: { dmMode: 'open', requireMention: true },
      handshakeTimeoutMs: 20_000,
    });
    ch.on('message', async (msg) => {
      if (msg.chatType !== 'p2p' || !msg.content.trim()) return;
      await inboundText('feishu', msg.chatId, msg.content, msg.senderName || msg.senderId, ioFor(msg.chatId));
    });
    ch.on('cardAction', async (evt) => {
      const action = (evt.action.value as { a?: string } | null)?.a;
      if (action) await inboundAction('feishu', evt.chatId, action, ioFor(evt.chatId));
    });
    ch.on('error', (err) => console.error('[feishu]', err.code, err.message));
    await ch.connect();
    channel = ch;
    botName = ch.botIdentity?.name || siteConfig().name;
    console.log(`[feishu] ${botName} 已连接`);
  },

  async stop() {
    const ch = channel;
    channel = null;
    botName = null;
    await ch?.disconnect();
  },

  send: (chatId, c) => sendCard(chatId, c),
  async sendFile(chatId, name, data) {
    await channel!.send(chatId, { file: { source: data, fileName: name } });
  },
};
