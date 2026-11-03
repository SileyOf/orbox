import { App, LogLevel } from '@slack/bolt';
import type { webApi } from '@slack/bolt';
import { integration, siteConfig } from '../site.js';
import { inboundAction, inboundText } from './hub.js';
import type { Adapter, BotIO, Card } from './types.js';
import { splitCard, spans } from './types.js';

// Slack：Socket Mode 接收私信和按钮点击，不需要公网回调地址。

let app: App | null = null;
let botName: string | null = null;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mrkdwn = (md: string) =>
  spans(md)
    .map((s) => (s.t === 'bold' ? `*${esc(s.v)}*` : s.t === 'code' ? `\`${esc(s.v)}\`` : s.t === 'link' ? `<${s.url}|${esc(s.v)}>` : esc(s.v)))
    .join('');

export function blocks(c: Card) {
  const copies = (c.buttons || []).flat().filter((b) => b.copy);
  const out: any[] = [];
  if (c.title) out.push({ type: 'header', text: { type: 'plain_text', text: c.title.slice(0, 150) } });
  out.push({ type: 'section', text: { type: 'mrkdwn', text: mrkdwn(c.text + copies.map((b) => `\n\`${b.copy}\``).join('')) } });
  let n = 0;
  for (const row of c.buttons || []) {
    const elements = row
      .filter((b) => !b.copy && (b.url || b.action))
      .map((b) =>
        b.url
          ? { type: 'button', text: { type: 'plain_text', text: b.text.slice(0, 75) }, url: b.url, action_id: `u${n++}` }
          : { type: 'button', text: { type: 'plain_text', text: b.text.slice(0, 75) }, value: b.action, action_id: `o${n++}` },
      );
    if (elements.length) out.push({ type: 'actions', elements });
  }
  return out;
}

async function sendCard(client: webApi.WebClient, channel: string, c: Card) {
  for (const part of splitCard(c, 2800)) {
    await client.chat.postMessage({ channel, text: `${part.title ?? ''} ${part.text}`.slice(0, 3000), blocks: blocks(part) });
  }
}

function ioFor(client: webApi.WebClient, channel: string, user?: string): BotIO {
  return {
    reply: (c) => sendCard(client, channel, c),
    file: async (name, data) => void (await client.files.uploadV2({ channel_id: channel, file: data, filename: name })),
    note: async (text) => {
      if (user && !text.endsWith('…')) await client.chat.postEphemeral({ channel, user, text }).catch(() => {});
    },
  };
}

export const slack: Adapter = {
  platform: 'slack',
  label: 'Slack',
  enabled: () => !!(integration('slack').botToken && integration('slack').appToken),
  name: () => botName,
  bindHint: (code) => ({ text: `在 Slack 里打开应用「${botName}」的私信，发送：绑定 ${code}` }),

  async start() {
    const a = new App({ token: integration('slack').botToken, appToken: integration('slack').appToken, socketMode: true, logLevel: LogLevel.WARN });
    a.message(async ({ message, client }) => {
      if (message.subtype || message.channel_type !== 'im' || !('text' in message) || !message.text) return;
      await inboundText('slack', message.channel, message.text, message.user, ioFor(client, message.channel, message.user));
    });
    a.action(/^o\d+$/, async ({ ack, body, action, client }) => {
      await ack();
      const value = 'value' in action ? action.value : undefined;
      const channel = 'channel' in body ? body.channel?.id : undefined;
      if (value && channel) await inboundAction('slack', channel, value, ioFor(client, channel, body.user.id));
    });
    // 链接按钮也会产生点击事件，确认收到即可
    a.action(/^u\d+$/, async ({ ack }) => void (await ack()));
    a.error(async (e) => console.error('[slack]', e.message));
    await a.start();
    const auth = await a.client.auth.test();
    app = a;
    botName = (auth.user as string) || siteConfig().name;
    console.log(`[slack] ${botName} 已连接`);
  },

  async stop() {
    const a = app;
    app = null;
    botName = null;
    await a?.stop();
  },

  send: (chatId, c) => sendCard(app!.client, chatId, c),
  async sendFile(chatId, name, data) {
    await app!.client.files.uploadV2({ channel_id: chatId, file: data, filename: name });
  },
};
