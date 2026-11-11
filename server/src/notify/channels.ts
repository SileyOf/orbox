import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateIp } from '../net.js';
import { siteConfig } from '../site.js';
import type { EventKind, User } from '../auth.js';

// Telegram 之外的推送通道。它们只能单向推送，不带可点击的操作按钮。
export interface Push {
  title: string;
  body: string;
  /** 点击通知后打开的地址 */
  url?: string;
  /** 验证码：支持的通道会直接放进剪贴板 */
  code?: string | null;
}

export type ChannelName = 'bark' | 'ntfy' | 'webhook';

/** 这些地址由用户填写、由服务器去请求，必须挡住指向内网的地址 */
async function publicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只支持 http/https 地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (host === 'localhost' || addresses.some(isPrivateIp)) {
    throw new Error('不允许使用内网地址');
  }
  return url;
}

async function post(url: URL | string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`返回 ${res.status}`);
}

const senders: Record<ChannelName, (target: string, p: Push) => Promise<void>> = {
  // 填 Bark App 里复制的地址，形如 https://api.day.app/你的Key
  async bark(target, p) {
    const url = await publicUrl(target.replace(/\/+$/, ''));
    const key = url.pathname.split('/').filter(Boolean)[0];
    if (!key) throw new Error('Bark 地址里缺少设备 Key');
    await post(new URL('/push', url), {
      device_key: key,
      title: p.title,
      body: p.body,
      group: siteConfig().name,
      url: p.url,
      // 验证码推送到手后直接进剪贴板
      ...(p.code ? { copy: p.code, autoCopy: '1', level: 'timeSensitive' } : {}),
    });
  },
  // 填完整的主题地址，形如 https://ntfy.sh/我的主题
  async ntfy(target, p) {
    const url = await publicUrl(target.replace(/\/+$/, ''));
    const topic = url.pathname.split('/').filter(Boolean).pop();
    if (!topic) throw new Error('ntfy 地址里缺少主题名');
    await post(new URL('/', url), {
      topic,
      title: p.title,
      message: p.body,
      click: p.url,
      priority: p.code ? 4 : 3,
      ...(p.code ? { actions: [{ action: 'copy', label: `复制 ${p.code}`, value: p.code }] } : {}),
    });
  },
  // 通用 Webhook：原样 POST 一个 JSON，方便接入企业微信、Discord 转发器或自己的脚本
  async webhook(target, p) {
    await post(await publicUrl(target), { app: siteConfig().name, ...p, text: `${p.title}\n${p.body}` });
  },
};

export async function sendChannel(name: ChannelName, target: string, push: Push): Promise<void> {
  await senders[name](target, push);
}

/** 推送到用户配置的所有通道，单个通道失败不影响其他通道 */
export async function pushChannels(user: User, push: Push, kind?: EventKind): Promise<void> {
  const channels = user.settings.channels;
  await Promise.all(
    (Object.keys(senders) as ChannelName[])
      .filter((name) => channels[name] && (!kind || user.settings.routing?.[name]?.[kind] !== false))
      .map((name) => sendChannel(name, channels[name], push).catch((e) => console.error(`[${name}]`, e.message))),
  );
}
