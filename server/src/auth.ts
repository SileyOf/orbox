import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_VERSION, config } from './config.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import { exec, one } from './db.js';

const COOKIE = 'orbox_sid';
const SESSION_DAYS = 30;

export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  accent: string;
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
  /** 只推送 AI 判定为重要的邮件（验证码、重点发件人始终推送） */
  aiFilter: boolean;
  ai?: {
    provider: 'anthropic' | 'openai';
    baseUrl: string;
    model: string;
    fastModel: string;
    /** 加密存储，不会返回给前端 */
    apiKeyEnc: string;
  };
}

export const defaultSettings: UserSettings = {
  theme: 'system',
  accent: '#cceb79',
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
  aiFilter: false,
};

export interface User {
  id: number;
  email: string;
  name: string;
  isAdmin: boolean;
  timezone: string;
  settings: UserSettings;
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
    settings: {
      ...defaultSettings,
      ...(row.settings || {}),
      channels: { ...defaultSettings.channels, ...(row.settings?.channels || {}) },
    },
  };
}

/** 返回给前端的用户信息：去掉加密存储的 API Key，只告诉前端配置了没有 */
export function publicUser(u: User) {
  const { ai, ...settings } = u.settings;
  return {
    ...u,
    settings: { ...settings, ai: ai ? { provider: ai.provider, baseUrl: ai.baseUrl, model: ai.model, fastModel: ai.fastModel, hasKey: !!ai.apiKeyEnc } : null },
  };
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

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  if (token) {
    const row = await one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > UTC_TIMESTAMP()`,
      [sha256(token)],
    );
    if (row) {
      req.user = toUser(row);
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
      aiFilter: z.boolean(),
    })
    .partial()
    .optional(),
  password: z.object({ current: z.string(), next: z.string().min(8, '密码至少 8 位').max(200) }).optional(),
});

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/status', async () => {
    const row = await one<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    return { allowRegistration: config.allowRegistration || !row?.n, version: APP_VERSION };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = credentials.extend({ name: z.string().trim().max(100).default('') }).parse(req.body);
    const count = (await one<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n;
    // 首个用户始终可注册并成为管理员
    if (count > 0 && !config.allowRegistration) return reply.code(403).send({ error: '注册已关闭' });
    if (await one('SELECT id FROM users WHERE email = ?', [body.email])) {
      return reply.code(409).send({ error: '该邮箱已注册' });
    }
    const res = await exec('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?)', [
      body.email,
      body.name || body.email.split('@')[0],
      await hashPassword(body.password),
      count === 0 ? 1 : 0,
    ]);
    await startSession(req, reply, res.insertId);
    return publicUser((await getUser(res.insertId))!);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
    const row = await one('SELECT * FROM users WHERE email = ?', [body.email]);
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      return reply.code(401).send({ error: '邮箱或密码错误' });
    }
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

  app.patch('/api/me', { preHandler: requireUser }, async (req, reply) => {
    const body = profilePatch.parse(req.body);
    const user = req.user;
    if (body.password) {
      const row = await one('SELECT password_hash FROM users WHERE id = ?', [user.id]);
      if (!(await verifyPassword(body.password.current, row.password_hash))) {
        return reply.code(400).send({ error: '当前密码不正确' });
      }
      await exec('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(body.password.next), user.id]);
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
