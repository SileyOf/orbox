import { randomInt } from 'node:crypto';
import { DateTime } from 'luxon';
import { getUser } from '../auth.js';
import type { EventKind, User } from '../auth.js';
import { exec, one, query } from '../db.js';
import { handleAction, handleText } from './actions.js';
import { digestCard, helpText } from './cards.js';
import { siteConfig } from '../site.js';
import { discord } from './discord.js';
import { feishu } from './feishu.js';
import { slack } from './slack.js';
import { telegram } from './telegram.js';
import type { Adapter, BotIO, Card, Platform } from './types.js';

// 机器人网关：管理各平台适配器、账号绑定，把通知发到用户绑定的所有平台，
// 并把各平台收到的消息和按钮点击交给统一的处理逻辑。

// 适配器和本文件互相引用，按需取列表，避免模块初始化顺序带来的问题
const adapters = (): Adapter[] => [telegram, feishu, discord, slack];
const adapterOf = (p: string) => adapters().find((a) => a.platform === p);

// 每个平台的连接状态：最近一次失败原因 + 自动重试（30 秒起，逐次翻倍，最长 10 分钟）。
// 比如飞书应用刚提交发布、还没审核通过，审核通过后不用手动点就能连上。
const state = new Map<Platform, { error: string | null; at: number; timer?: NodeJS.Timeout; attempt: number }>();

function stateOf(p: Platform) {
  let s = state.get(p);
  if (!s) state.set(p, (s = { error: null, at: 0, attempt: 0 }));
  return s;
}

async function connect(a: Adapter): Promise<void> {
  const s = stateOf(a.platform);
  clearTimeout(s.timer);
  try {
    await a.start();
    s.error = null;
    s.attempt = 0;
  } catch (e) {
    s.error = (e as Error)?.message || String(e);
    s.at = Date.now();
    const delay = Math.min(30_000 * 2 ** s.attempt++, 600_000);
    console.error(`[${a.platform}] 连接失败（${Math.round(delay / 1000)} 秒后重试）：${s.error}`);
    s.timer = setTimeout(() => {
      if (a.enabled() && !a.name()) void a.stop().catch(() => {}).then(() => connect(a).catch(() => {}));
    }, delay);
    s.timer.unref();
    throw e;
  }
}

export async function startBots() {
  for (const a of adapters()) {
    if (!a.enabled()) continue;
    // 各平台独立启动，一个连不上不影响其他
    connect(a).catch(() => {});
  }
}

/** 管理员在网页里改了某个平台的凭据后，单独重启它 */
export async function restartBot(platform: Platform): Promise<void> {
  const a = adapterOf(platform);
  if (!a) return;
  const s = stateOf(platform);
  clearTimeout(s.timer);
  s.attempt = 0;
  s.error = null;
  await a.stop().catch(() => {});
  if (a.enabled()) await connect(a);
}

export async function stopBots() {
  await Promise.all(adapters().filter((a) => a.enabled()).map((a) => a.stop().catch(() => {})));
}

export function botStatus() {
  return adapters().map((a) => {
    const s = state.get(a.platform);
    const error = a.enabled() && !a.name() ? s?.error || null : null;
    return { platform: a.platform, label: a.label, enabled: a.enabled(), name: a.name(), error, errorAt: error ? s!.at : null };
  });
}

export const linksOf = (userId: number) =>
  query<{ platform: Platform; chat_id: string; username: string }>('SELECT platform, chat_id, username FROM bot_links WHERE user_id = ?', [userId]);

/** 用户是否让这个渠道接收这类事件（没设置过就是接收） */
export const wants = (user: User | undefined, channel: string, kind?: EventKind) =>
  !kind || user?.settings.routing?.[channel]?.[kind] !== false;

/** 发给用户绑定的所有平台（按用户的渠道设置筛选事件）。返回成功送达的平台数 */
export async function sendToUser(userId: number, cards: Card | Card[], kind?: EventKind): Promise<number> {
  let sent = 0;
  const user = await getUser(userId);
  if (!user?.perms.bots) return 0;
  for (const link of await linksOf(userId)) {
    const a = adapterOf(link.platform);
    if (!a?.enabled() || !a.name() || !wants(user, link.platform, kind)) continue;
    try {
      for (const c of Array.isArray(cards) ? cards : [cards]) await a.send(link.chat_id, c);
      sent++;
    } catch (e) {
      console.error(`[${link.platform}] 发送失败：`, (e as Error).message);
    }
  }
  return sent;
}

// ---------------- 绑定 ----------------

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function createBindCode(userId: number): Promise<string> {
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  await exec('DELETE FROM bot_link_codes WHERE user_id = ? OR expires_at < UTC_TIMESTAMP()', [userId]);
  await exec('INSERT INTO bot_link_codes (code, user_id, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 15 MINUTE)', [code, userId]);
  return code;
}

export function bindHints(code: string) {
  return adapters().filter((a) => a.enabled() && a.name()).map((a) => ({ platform: a.platform, label: a.label, ...a.bindHint(code) }));
}

export const unbind = (userId: number, platform: string) =>
  exec('DELETE FROM bot_links WHERE user_id = ? AND platform = ?', [userId, platform]);

const BIND_RE = /^(?:\/start\s+|\/bind\s+|绑定\s*|bind\s+)?([A-HJ-NP-Z2-9]{8})$/i;

async function tryBind(platform: Platform, chatId: string, text: string, username: string, io: BotIO): Promise<boolean> {
  const code = text.trim().match(BIND_RE)?.[1]?.toUpperCase();
  if (!code) return false;
  const row = await one<{ user_id: number }>('SELECT user_id FROM bot_link_codes WHERE code = ? AND expires_at > UTC_TIMESTAMP()', [code]);
  if (!row) {
    await io.reply({ tone: 'warn', text: `绑定码无效或已过期，请回到 ${siteConfig().name} 网页重新生成。` });
    return true;
  }
  await exec('DELETE FROM bot_link_codes WHERE user_id = ?', [row.user_id]);
  await exec('DELETE FROM bot_links WHERE (platform = ? AND chat_id = ?) OR (platform = ? AND user_id = ?)', [platform, chatId, platform, row.user_id]);
  await exec('INSERT INTO bot_links (user_id, platform, chat_id, username) VALUES (?, ?, ?, ?)', [row.user_id, platform, chatId, username.slice(0, 100)]);
  await io.reply({ tone: 'info', title: '绑定成功 🎉', text: helpText() });
  return true;
}

async function userOfChat(platform: Platform, chatId: string): Promise<User | undefined> {
  const row = await one<{ user_id: number }>('SELECT user_id FROM bot_links WHERE platform = ? AND chat_id = ?', [platform, chatId]);
  return row ? getUser(Number(row.user_id)) : undefined;
}

const notLinked = () =>
  `尚未绑定 ${siteConfig().name} 账号。请在网页「设置 → 通知渠道」里生成绑定码，再把绑定码发给我。`;

/** 适配器收到文字消息时调用 */
export async function inboundText(platform: Platform, chatId: string, text: string, username: string, io: BotIO) {
  if (await tryBind(platform, chatId, text, username, io)) return;
  const user = await userOfChat(platform, chatId);
  if (!user) return io.reply({ tone: 'info', text: notLinked() });
  if (/^\/unlink\b|^解除绑定$/.test(text.trim())) {
    await unbind(user.id, platform);
    return io.reply({ tone: 'info', text: '已解除绑定，之后不会再收到通知。' });
  }
  await handleText(user, platform, text, io);
}

/** 适配器收到按钮点击时调用 */
export async function inboundAction(platform: Platform, chatId: string, action: string, io: BotIO) {
  const user = await userOfChat(platform, chatId);
  if (!user) return io.note(notLinked());
  await handleAction(user, platform, action, io);
}

/** 每日早报：到点后一小时内补发，每个用户每天只发一次 */
export async function runDigests(): Promise<void> {
  const rows = await query<{ user_id: number; digest_last: string | null }>(
    `SELECT DISTINCT l.user_id, DATE_FORMAT(u.digest_last, '%Y-%m-%d') AS digest_last
     FROM bot_links l JOIN users u ON u.id = l.user_id`,
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
    await sendToUser(user.id, await digestCard(user), 'digest').catch((e) => console.error('[digest]', e.message));
  }
}
