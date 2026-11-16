import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { publicUser, requireUser, startSession, toUser } from '../auth.js';
import { config } from '../config.js';
import { decrypt, encrypt, hashPassword, randomToken, verifyPassword } from '../crypto.js';
import { exec, one } from '../db.js';
import { disconnect } from '../events.js';
import { checkCode, maskEmail, mailerReady, sendCode } from '../mailer.js';
import { siteConfig } from '../site.js';
import { newRecoveryCodes, newTotpSecret, otpauthUri, useRecoveryCode, verifyTotp } from '../totp.js';

// 账号安全：邮箱验证、找回密码、两步验证（动态码 App / 邮箱验证码 / 恢复码）。

const email = z.string().trim().toLowerCase().email('邮箱格式不正确');
const code = z.string().trim().min(4).max(20);
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// ---------------- 简单的内存限流 ----------------

const hits = new Map<string, { n: number; until: number }>();
/** 窗口内超过 max 次就拒绝 */
function throttle(key: string, max: number, windowMs = 15 * 60_000) {
  const h = hits.get(key);
  if (!h || h.until < Date.now()) hits.set(key, { n: 1, until: Date.now() + windowMs });
  else if (++h.n > max) throw fail('操作太频繁，请稍后再试', 429);
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < Date.now()) hits.delete(k);
}

// ---------------- 两步验证的登录票据 ----------------

interface Ticket {
  userId: number;
  expires: number;
  attempts: number;
}
const tickets = new Map<string, Ticket>();

export type TwoFactorMethod = 'totp' | 'email' | 'recovery';

interface SecurityRow {
  id: number;
  email: string;
  email_verified_at: Date | null;
  totp_enabled: number;
  email_otp: number;
  totp_secret_enc: string | null;
  recovery_codes: string[] | null;
  password_hash: string;
}

const twoFactorOn = (u: Pick<SecurityRow, 'totp_enabled' | 'email_otp'>) => !!(u.totp_enabled || u.email_otp);

/**
 * 密码验证通过后调用：这个用户需要两步验证时返回票据和可用的方式，否则返回 null（直接登录）。
 */
export function beginTwoFactor(u: SecurityRow): { ticket: string; methods: TwoFactorMethod[]; emailHint: string } | null {
  if (!twoFactorOn(u) || config.disable2fa) return null;
  const methods: TwoFactorMethod[] = [];
  if (u.totp_enabled && u.totp_secret_enc) methods.push('totp');
  if (u.email_otp && mailerReady()) methods.push('email');
  if (u.recovery_codes?.length) methods.push('recovery');
  if (!methods.length) throw fail('这个账号开启了邮箱两步验证，但系统发信现在不可用。请联系管理员', 503);
  const ticket = randomToken(24);
  tickets.set(ticket, { userId: u.id, expires: Date.now() + 10 * 60_000, attempts: 0 });
  if (tickets.size > 5000) for (const [k, v] of tickets) if (v.expires < Date.now()) tickets.delete(k);
  return { ticket, methods, emailHint: maskEmail(u.email) };
}

function ticketOf(id: string): Ticket {
  const t = tickets.get(id);
  if (!t || t.expires < Date.now()) {
    tickets.delete(id);
    throw fail('登录已超时，请重新输入密码', 401);
  }
  return t;
}

const securityRow = (userId: number) =>
  one<SecurityRow>(
    'SELECT id, email, email_verified_at, totp_enabled, email_otp, totp_secret_enc, recovery_codes, password_hash FROM users WHERE id = ? AND disabled = 0',
    [userId],
  );

async function requirePassword(req: FastifyRequest, password: string | undefined): Promise<SecurityRow> {
  const row = (await securityRow(req.user.id))!;
  throttle(`pw:${req.user.id}`, 10);
  if (!password || !(await verifyPassword(password, row.password_hash))) throw fail('当前密码不正确');
  return row;
}

/** 开启任何一种两步验证时，如果还没有恢复码就生成一组；返回明文（只显示这一次） */
async function ensureRecoveryCodes(u: SecurityRow): Promise<string[] | null> {
  if (u.recovery_codes?.length) return null;
  const { plain, hashed } = newRecoveryCodes();
  await exec('UPDATE users SET recovery_codes = ? WHERE id = ?', [JSON.stringify(hashed), u.id]);
  return plain;
}

export async function securityRoutes(app: FastifyInstance) {
  // ================= 登录第二步 =================

  /** 把登录验证码发到邮箱 */
  app.post('/api/auth/2fa/email', async (req) => {
    const { ticket } = z.object({ ticket: z.string() }).parse(req.body);
    const u = await securityRow(ticketOf(ticket).userId);
    if (!u?.email_otp) throw fail('这个账号没有开启邮箱验证码');
    await sendCode(u.email, 'login', u.id);
    return { ok: true, emailHint: maskEmail(u.email) };
  });

  app.post('/api/auth/2fa', async (req, reply) => {
    const body = z.object({ ticket: z.string(), method: z.enum(['totp', 'email', 'recovery']), code }).parse(req.body);
    const t = ticketOf(body.ticket);
    if (++t.attempts > 6) {
      tickets.delete(body.ticket);
      throw fail('验证码错误次数太多，请重新登录', 429);
    }
    const u = await securityRow(t.userId);
    if (!u) throw fail('账号不可用', 401);
    let ok = false;
    if (body.method === 'totp' && u.totp_enabled && u.totp_secret_enc) ok = verifyTotp(u.id, decrypt(u.totp_secret_enc), body.code);
    else if (body.method === 'email' && u.email_otp) ok = (await checkCode(u.email, 'login', body.code)).ok;
    else if (body.method === 'recovery' && u.recovery_codes?.length) {
      const left = useRecoveryCode(u.recovery_codes, body.code);
      if (left) {
        ok = true;
        await exec('UPDATE users SET recovery_codes = ? WHERE id = ?', [JSON.stringify(left), u.id]);
      }
    }
    if (!ok) throw fail(body.method === 'recovery' ? '恢复码不正确或已经用过' : '验证码不正确或已过期', 401);
    tickets.delete(body.ticket);
    await exec('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [u.id]);
    await startSession(req, reply, u.id);
    return publicUser(toUser((await one('SELECT * FROM users WHERE id = ?', [u.id]))!));
  });

  // ================= 注册后的邮箱验证 =================

  app.post('/api/auth/verify', async (req, reply) => {
    const body = z.object({ email, code }).parse(req.body);
    throttle(`verify:${req.ip}`, 20);
    const row = await one('SELECT * FROM users WHERE email = ? AND verify_pending = 1 AND disabled = 0', [body.email]);
    if (!row || !(await checkCode(body.email, 'verify', body.code)).ok) throw fail('验证码不正确或已过期');
    await exec('UPDATE users SET email_verified_at = UTC_TIMESTAMP(), verify_pending = 0, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
    await startSession(req, reply, Number(row.id));
    return publicUser(toUser((await one('SELECT * FROM users WHERE id = ?', [row.id]))!));
  });

  app.post('/api/auth/verify/resend', async (req) => {
    const body = z.object({ email }).parse(req.body);
    throttle(`resend:${req.ip}`, 10);
    const row = await one<{ id: number }>('SELECT id FROM users WHERE email = ? AND verify_pending = 1 AND disabled = 0', [body.email]);
    // 不透露这个邮箱是否在等待验证
    if (row) await sendCode(body.email, 'verify', row.id, true);
    return { ok: true };
  });

  // ================= 找回密码 =================

  app.post('/api/auth/forgot', async (req) => {
    const body = z.object({ email }).parse(req.body);
    throttle(`forgot:${req.ip}`, 10);
    if (!mailerReady()) throw fail('系统没有配置发信，无法通过邮件找回密码。请联系管理员重置');
    const row = await one<{ id: number }>('SELECT id FROM users WHERE email = ? AND disabled = 0', [body.email]);
    // 邮箱不存在也返回成功，避免被用来探测哪些邮箱注册过
    if (row) await sendCode(body.email, 'reset', row.id, true).catch((e) => console.error('[auth] 找回密码邮件发送失败：', e.message));
    return { ok: true };
  });

  app.post('/api/auth/reset', async (req) => {
    const body = z.object({ email, code, password: z.string().min(8, '密码至少 8 位').max(200) }).parse(req.body);
    throttle(`reset:${req.ip}`, 20);
    const res = await checkCode(body.email, 'reset', body.code);
    const row = res.ok ? await one<{ id: number }>('SELECT id FROM users WHERE email = ? AND disabled = 0', [body.email]) : undefined;
    if (!row || res.userId !== Number(row.id)) throw fail('验证码不正确或已过期');
    // 能收到这封邮件说明邮箱是本人的，顺便标记为已验证；所有设备下线。两步验证不受影响，登录时仍然需要
    await exec('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()), verify_pending = 0 WHERE id = ?', [
      await hashPassword(body.password),
      row.id,
    ]);
    await exec('DELETE FROM sessions WHERE user_id = ?', [row.id]);
    disconnect(Number(row.id));
    console.log(`[auth] 用户 ${row.id} 通过邮件重置了密码`);
    return { ok: true };
  });

  // ================= 登录后的安全设置 =================

  app.get('/api/me/security', { preHandler: requireUser }, async (req) => {
    const u = (await securityRow(req.user.id))!;
    return {
      email: u.email,
      emailVerified: !!u.email_verified_at,
      mailer: mailerReady(),
      totp: !!u.totp_enabled,
      emailOtp: !!u.email_otp,
      recoveryLeft: u.recovery_codes?.length ?? 0,
    };
  });

  /** 发验证码：验证当前邮箱，或者（带上新邮箱和密码）更换登录邮箱 */
  app.post('/api/me/email/code', { preHandler: requireUser }, async (req) => {
    const body = z.object({ email: email.optional(), password: z.string().optional() }).parse(req.body ?? {});
    const target = body.email || req.user.email;
    if (target !== req.user.email) {
      await requirePassword(req, body.password);
      if (await one('SELECT id FROM users WHERE email = ?', [target])) throw fail('这个邮箱已被其他账号使用');
      await sendCode(target, 'change', req.user.id);
    } else {
      await sendCode(target, 'verify', req.user.id);
    }
    return { ok: true, emailHint: maskEmail(target) };
  });

  app.post('/api/me/email/confirm', { preHandler: requireUser }, async (req) => {
    const body = z.object({ email, code }).parse(req.body);
    throttle(`confirm:${req.user.id}`, 20);
    const changing = body.email !== req.user.email;
    const res = await checkCode(body.email, changing ? 'change' : 'verify', body.code);
    if (!res.ok || res.userId !== req.user.id) throw fail('验证码不正确或已过期');
    if (changing) {
      if (await one('SELECT id FROM users WHERE email = ?', [body.email])) throw fail('这个邮箱已被其他账号使用');
      await exec('UPDATE users SET email = ?, email_verified_at = UTC_TIMESTAMP(), verify_pending = 0 WHERE id = ?', [body.email, req.user.id]);
    } else {
      await exec('UPDATE users SET email_verified_at = UTC_TIMESTAMP(), verify_pending = 0 WHERE id = ?', [req.user.id]);
    }
    return { ok: true, email: body.email };
  });

  /** 第一步：生成密钥，给出二维码内容。此时还没生效，要输入一次动态码确认 */
  app.post('/api/me/2fa/totp/setup', { preHandler: requireUser }, async (req) => {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const u = await requirePassword(req, password);
    if (u.totp_enabled) throw fail('动态码已经开启，要更换请先关闭');
    const secret = newTotpSecret();
    await exec('UPDATE users SET totp_secret_enc = ? WHERE id = ?', [encrypt(secret), u.id]);
    return { secret, uri: otpauthUri(siteConfig().name, u.email, secret) };
  });

  app.post('/api/me/2fa/totp/enable', { preHandler: requireUser }, async (req) => {
    const body = z.object({ code }).parse(req.body);
    throttle(`totp:${req.user.id}`, 10);
    const u = (await securityRow(req.user.id))!;
    if (u.totp_enabled) throw fail('动态码已经开启');
    if (!u.totp_secret_enc || !verifyTotp(u.id, decrypt(u.totp_secret_enc), body.code)) throw fail('动态码不正确。请确认手机时间准确，并输入 App 里当前显示的 6 位数');
    await exec('UPDATE users SET totp_enabled = 1 WHERE id = ?', [u.id]);
    return { ok: true, recoveryCodes: await ensureRecoveryCodes(u) };
  });

  app.post('/api/me/2fa/email', { preHandler: requireUser }, async (req) => {
    const body = z.object({ enabled: z.boolean(), password: z.string() }).parse(req.body);
    const u = await requirePassword(req, body.password);
    if (body.enabled) {
      if (!mailerReady()) throw fail('系统还没有配置发信，不能使用邮箱验证码');
      if (!u.email_verified_at) throw fail('请先验证登录邮箱');
      await exec('UPDATE users SET email_otp = 1 WHERE id = ?', [u.id]);
      return { ok: true, recoveryCodes: await ensureRecoveryCodes(u) };
    }
    await exec('UPDATE users SET email_otp = 0, recovery_codes = IF(totp_enabled = 1, recovery_codes, NULL) WHERE id = ?', [u.id]);
    return { ok: true, recoveryCodes: null };
  });

  app.post('/api/me/2fa/totp/disable', { preHandler: requireUser }, async (req) => {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const u = await requirePassword(req, password);
    await exec('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, recovery_codes = IF(email_otp = 1, recovery_codes, NULL) WHERE id = ?', [u.id]);
    return { ok: true };
  });

  /** 重新生成恢复码，旧的全部作废 */
  app.post('/api/me/2fa/recovery', { preHandler: requireUser }, async (req) => {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const u = await requirePassword(req, password);
    if (!twoFactorOn(u)) throw fail('还没有开启两步验证');
    const { plain, hashed } = newRecoveryCodes();
    await exec('UPDATE users SET recovery_codes = ? WHERE id = ?', [JSON.stringify(hashed), u.id]);
    return { recoveryCodes: plain };
  });
}
