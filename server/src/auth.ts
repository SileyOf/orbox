import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_VERSION, config } from './config.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import { exec, one, query } from './db.js';
import { ALL_PERMS, publicSite, siteConfig } from './site.js';
import type { Perms } from './site.js';

const COOKIE = 'orbox_sid';
const SESSION_DAYS = 30;

export interface UserSettings {
  /** 正在进行的出差（简单记用），由服务端维护 */
  trip?: { name: string; start: string };
  theme: 'light' | 'dark' | 'system';
  accent: string;
  /** 面板效果：通透（半透明 + 模糊）/ 实色 */
  surface: 'clear' | 'solid';
  /** 文本选中颜色：accent 表示跟随强调色，否则是颜色值 */
  selection: string;
  /** 强调色跟随站点（管理员改了站点强调色会一起变） */
  followSite: boolean;
  /** 界面动效 */
  motion: boolean;
  notifyMail: boolean;
  quietStart: string; // "HH:mm"，与 quietEnd 相同表示关闭免打扰
  quietEnd: string;
  digestTime: string; // "HH:mm"，空字符串表示不发早报
  nagInterval: number; // 默认重复提醒间隔（分钟），0 表示只提醒一次
  blockRemoteImages: boolean;
  /** 始终通知的发件人（地址或域名），不受免打扰限制 */
  vipSenders: string[];
  /** 从不通知的发件人（地址或域名） */
  mutedSenders: string[];
  /** 带验证码的邮件无视免打扰 */
  codeAlways: boolean;
  /** Telegram 之外的推送通道地址，空字符串表示未启用 */
  channels: { bark: string; ntfy: string; webhook: string };
  /** 会话视图：列表按会话折叠 */
  threads: boolean;
  /** 翻译的目标语言 */
  translateTo: string;
  /** 只推送重要邮件（用 AI 或本地规则判断；验证码、重点发件人始终推送） */
  importantOnly: boolean;
  /** 每项 AI 任务用哪个模型服务、是否启用 */
  aiTasks?: Partial<Record<string, { enabled: boolean; providerId: number | null; model: string }>>;
  /** 每个通知渠道接收哪些事件，缺省表示全部接收 */
  routing?: Record<string, Partial<Record<EventKind, boolean>>>;
}

export type EventKind = 'mail' | 'code' | 'task' | 'digest' | 'snooze';

export const defaultSettings: UserSettings = {
  theme: 'system',
  accent: '#cceb79',
  surface: 'solid',
  selection: 'accent',
  followSite: false,
  motion: true,
  notifyMail: true,
  quietStart: '23:00',
  quietEnd: '07:30',
  digestTime: '08:30',
  nagInterval: 15,
  blockRemoteImages: true,
  vipSenders: [],
  mutedSenders: [],
  codeAlways: true,
  channels: { bark: '', ntfy: '', webhook: '' },
  threads: true,
  translateTo: '简体中文',
  importantOnly: false,
};

export interface User {
  id: number;
  email: string;
  name: string;
  isAdmin: boolean;
  timezone: string;
  settings: UserSettings;
  /** 生效的权限（管理员全开；没单独设置的用站点默认） */
  perms: Perms;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}

function toUser(row: any): User {
  return {
    id: Number(row.id),
    email: row.email,
    name: row.name,
    isAdmin: !!row.is_admin,
    timezone: row.timezone,
    perms: row.is_admin ? ALL_PERMS : { ...siteConfig().defaultPerms, ...(row.perms || {}) },
    settings: {
      ...defaultSettings,
      ...(row.settings || {}),
      channels: { ...defaultSettings.channels, ...(row.settings?.channels || {}) },
    },
  };
}

/** 检查权限，不满足时抛出 403 */
export function requirePerm(u: User, perm: Exclude<keyof Perms, 'maxAccounts'>, what: string) {
  if (!u.perms[perm]) throw Object.assign(new Error(`管理员没有给你开放${what}`), { statusCode: 403 });
}

/** 返回给前端的用户信息（管理员额外带上后台路径） */
export function publicUser(u: User) {
  return { ...u, ...(u.isAdmin ? { adminPath: siteConfig().adminPath } : {}) };
}

export async function getUser(id: number): Promise<User | undefined> {
  const row = await one('SELECT * FROM users WHERE id = ?', [id]);
  return row ? toUser(row) : undefined;
}

async function startSession(req: FastifyRequest, reply: FastifyReply, userId: number) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await exec('INSERT INTO sessions (id, user_id, user_agent, expires_at) VALUES (?, ?, ?, ?)', [
    sha256(token),
    userId,
    String(req.headers['user-agent'] || '').slice(0, 255),
    expires,
  ]);
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    expires,
  });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireUser(req, reply);
  if (reply.sent) return;
  if (!req.user.isAdmin) return reply.code(403).send({ error: '需要管理员权限' });
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  if (token) {
    const row = await one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > UTC_TIMESTAMP() AND u.disabled = 0`,
      [sha256(token)],
    );
    if (row) {
      req.user = toUser(row);
      // 最近活跃时间：5 分钟内只写一次
      const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
      if (Date.now() - seen > 300_000) void exec('UPDATE users SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]).catch(() => {});
      return;
    }
  }
  return reply.code(401).send({ error: '未登录' });
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
  password: z.string().min(8, '密码至少 8 位').max(200),
});

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone').concat('UTC'));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const senderList = z.array(z.string().trim().min(3).max(190)).max(200);
const channelUrl = z.string().trim().max(500).refine((v) => v === '' || /^https?:\/\//i.test(v), '通道地址必须以 http:// 或 https:// 开头');

const profilePatch = z.object({
  name: z.string().trim().max(100).optional(),
  timezone: z.string().refine((tz) => TIMEZONES.has(tz), '未知时区').optional(),
  settings: z
    .object({
      theme: z.enum(['light', 'dark', 'system']),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      surface: z.enum(['clear', 'solid']),
      selection: z.string().regex(/^(accent|#[0-9a-fA-F]{6})$/),
      followSite: z.boolean(),
      motion: z.boolean(),
      notifyMail: z.boolean(),
      quietStart: hhmm,
      quietEnd: hhmm,
      digestTime: hhmm.or(z.literal('')),
      nagInterval: z.number().int().min(0).max(1440),
      blockRemoteImages: z.boolean(),
      vipSenders: senderList,
      mutedSenders: senderList,
      codeAlways: z.boolean(),
      channels: z.object({ bark: channelUrl, ntfy: channelUrl, webhook: channelUrl }).partial(),
      threads: z.boolean(),
      translateTo: z.string().trim().min(2).max(30),
      importantOnly: z.boolean(),
      aiTasks: z.record(z.string(), z.object({ enabled: z.boolean(), providerId: z.number().int().nullable(), model: z.string().trim().max(100) })),
      routing: z.record(z.string(), z.record(z.string(), z.boolean())),
    })
    .partial()
    .optional(),
  password: z.object({ current: z.string(), next: z.string().min(8, '密码至少 8 位').max(200) }).optional(),
});

// 登录失败限流：同一邮箱 15 分钟内失败 10 次、同一 IP 失败 30 次后暂时拒绝。
// 按邮箱计数可以防止换 IP（或伪造 X-Forwarded-For）绕过。
const failures = new Map<string, { n: number; until: number }>();
const WINDOW = 15 * 60_000;
const limited = (key: string, max: number) => {
  const f = failures.get(key);
  return !!f && f.until > Date.now() && f.n >= max;
};
const fail = (key: string) => {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) failures.set(key, { n: 1, until: Date.now() + WINDOW });
  else f.n++;
  if (failures.size > 10_000) for (const [k, v] of failures) if (v.until < Date.now()) failures.delete(k);
};
/** 邮箱不存在时也算一次哈希，避免通过响应时间判断哪些邮箱注册过 */
let dummyHash: Promise<string> | null = null;

export async function authRoutes(app: FastifyInstance) {
  /** 登录页需要的信息：站点外观、能否注册、是否需要邀请码 */
  app.get('/api/auth/status', async () => {
    const row = await one<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    const site = siteConfig();
    const first = !row?.n;
    return {
      allowRegistration: first || site.registration !== 'closed',
      inviteRequired: !first && site.registration === 'invite',
      version: APP_VERSION,
      site: publicSite(),
    };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = credentials.extend({ name: z.string().trim().max(100).default(''), invite: z.string().trim().max(20).optional() }).parse(req.body);
    const count = (await one<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n;
    const site = siteConfig();
    // 首个用户始终可注册并成为管理员
    if (count > 0 && site.registration === 'closed') return reply.code(403).send({ error: '注册已关闭' });
    if (count > 0 && site.registration === 'invite') {
      const inv = body.invite && (await one('SELECT code FROM invites WHERE code = ? AND used_by IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())', [body.invite.toUpperCase()]));
      if (!inv) return reply.code(403).send({ error: '邀请码无效或已被使用' });
    }
    if (limited(`r:${req.ip}`, 10)) return reply.code(429).send({ error: '注册太频繁，请稍后再试' });
    fail(`r:${req.ip}`);
    if (await one('SELECT id FROM users WHERE email = ?', [body.email])) {
      return reply.code(409).send({ error: '该邮箱已注册' });
    }
    const res = await exec('INSERT INTO users (email, name, password_hash, is_admin, timezone, settings) VALUES (?, ?, ?, ?, ?, ?)', [
      body.email,
      body.name || body.email.split('@')[0],
      await hashPassword(body.password),
      count === 0 ? 1 : 0,
      site.defaultTimezone,
      // 新用户沿用站点的默认主题和强调色
      JSON.stringify({ theme: site.theme, accent: site.accent, followSite: true }),
    ]);
    if (count > 0 && site.registration === 'invite') {
      // 同一个邀请码被同时使用时只有一个能成功
      const claim = await exec('UPDATE invites SET used_by = ?, used_at = UTC_TIMESTAMP() WHERE code = ? AND used_by IS NULL', [res.insertId, body.invite!.toUpperCase()]);
      if (!claim.affectedRows) {
        await exec('DELETE FROM users WHERE id = ?', [res.insertId]);
        return reply.code(403).send({ error: '邀请码无效或已被使用' });
      }
    }
    await startSession(req, reply, res.insertId);
    return publicUser((await getUser(res.insertId))!);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
    const keys = [`e:${body.email}`, `i:${req.ip}`];
    if (limited(keys[0], 10) || limited(keys[1], 30)) return reply.code(429).send({ error: '失败次数太多，请 15 分钟后再试' });
    const row = await one('SELECT * FROM users WHERE email = ?', [body.email]);
    const ok = row
      ? await verifyPassword(body.password, row.password_hash)
      : await verifyPassword(body.password, await (dummyHash ??= hashPassword('orbox-dummy'))).then(() => false);
    if (!row || !ok) {
      keys.forEach(fail);
      return reply.code(401).send({ error: '邮箱或密码错误' });
    }
    failures.delete(keys[0]);
    if (row.disabled) return reply.code(403).send({ error: '这个账号已被管理员停用' });
    await exec('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
    await startSession(req, reply, Number(row.id));
    return publicUser(toUser(row));
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await exec('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireUser }, async (req) => publicUser(req.user));

  app.get('/api/me/sessions', { preHandler: requireUser }, async (req) => {
    const cur = sha256(req.cookies[COOKIE] || '');
    const rows = await query<{ id: string; user_agent: string; created_at: string }>(
      'SELECT id, user_agent, created_at FROM sessions WHERE user_id = ? AND expires_at > UTC_TIMESTAMP() ORDER BY created_at DESC',
      [req.user.id],
    );
    return rows.map((r) => ({ userAgent: r.user_agent, createdAt: r.created_at, current: r.id === cur }));
  });

  /** 退出其他所有设备 */
  app.post('/api/me/logout-others', { preHandler: requireUser }, async (req) => {
    const res = await exec('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [req.user.id, sha256(req.cookies[COOKIE] || '')]);
    return { ok: true, count: res.affectedRows };
  });

  app.patch('/api/me', { preHandler: requireUser }, async (req, reply) => {
    const body = profilePatch.parse(req.body);
    const user = req.user;
    if (body.password) {
      const row = await one('SELECT password_hash FROM users WHERE id = ?', [user.id]);
      if (!(await verifyPassword(body.password.current, row.password_hash))) {
        return reply.code(400).send({ error: '当前密码不正确' });
      }
      await exec('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(body.password.next), user.id]);
      // 改密码后其他设备全部下线，只保留当前这个
      await exec('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [user.id, sha256(req.cookies[COOKIE] || '')]);
    }
    await exec('UPDATE users SET name = ?, timezone = ?, settings = ? WHERE id = ?', [
      body.name ?? user.name,
      body.timezone ?? user.timezone,
      JSON.stringify({
        ...user.settings,
        ...body.settings,
        channels: { ...user.settings.channels, ...body.settings?.channels },
      }),
      user.id,
    ]);
    return publicUser((await getUser(user.id))!);
  });
}
