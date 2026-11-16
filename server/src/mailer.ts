import { randomInt } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { sha256 } from './crypto.js';
import { exec, one } from './db.js';
import { connParams, smtpTransport } from './mail/manager.js';
import type { AccountRow } from './mail/manager.js';
import { integration, siteConfig } from './site.js';

// 系统发信：给用户的登录邮箱发验证码（验证邮箱、找回密码、邮箱两步验证）。
// 管理员在 后台 → 集成 里配置：直接用自己已添加的某个邮箱发，或者单独填一个 SMTP。

export type CodePurpose = 'verify' | 'change' | 'reset' | 'login';

const PURPOSE_TEXT: Record<CodePurpose, { subject: string; line: string }> = {
  verify: { subject: '验证邮箱', line: '你正在验证这个邮箱地址。' },
  change: { subject: '更换登录邮箱', line: '你正在把登录邮箱更换为这个地址。' },
  reset: { subject: '重置密码', line: '你正在重置登录密码。如果不是你本人操作，忽略这封邮件即可，密码不会改变。' },
  login: { subject: '登录验证码', line: '你正在登录，这是两步验证的验证码。如果不是你本人操作，说明有人知道了你的密码，请尽快修改。' },
};

const TTL_MIN = 15;

export class MailerError extends Error {
  statusCode = 400;
}

export function mailerReady(): boolean {
  const m = integration('mail');
  return m.mode === 'account' ? !!Number(m.accountId) : m.mode === 'smtp' ? !!(m.host && m.from) : false;
}

async function transport(): Promise<{ send: Transporter; from: { name: string; address: string } }> {
  const m = integration('mail');
  const name = m.fromName || siteConfig().name;
  if (m.mode === 'account') {
    // 只允许用管理员名下的邮箱代发（保存配置时也校验过）
    const account = await one<AccountRow>(
      'SELECT a.* FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.id = ? AND u.is_admin = 1 AND u.disabled = 0',
      [Number(m.accountId)],
    );
    if (!account) throw new MailerError('系统发信用的邮箱已被移除，请管理员在 后台 → 集成 里重新选择');
    return { send: smtpTransport(await connParams(account)), from: { name, address: account.email } };
  }
  if (m.mode === 'smtp' && m.host && m.from) {
    return {
      send: nodemailer.createTransport({
        host: m.host,
        port: Number(m.port) || (m.secure === 'ssl' ? 465 : 587),
        secure: m.secure === 'ssl',
        requireTLS: m.secure === 'starttls',
        auth: m.user ? { user: m.user, pass: m.pass } : undefined,
        connectionTimeout: 15_000,
      }),
      from: { name, address: m.from },
    };
  }
  throw new MailerError('系统还没有配置发信');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendSystemMail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const { send, from } = await transport();
  try {
    await send.sendMail({ from, to, subject, text, html });
  } catch (e: any) {
    console.error(`[mailer] 发送到 ${to.replace(/^(.).*(@.*)$/, '$1***$2')} 失败：${e.responseText || e.message}`);
    throw new MailerError(`邮件发送失败：${e.responseText || e.message}`);
  }
}

const hashCode = (email: string, purpose: CodePurpose, code: string) => sha256(`${purpose}:${email.toLowerCase()}:${code}`);

/**
 * 生成 6 位验证码发到邮箱。同一邮箱同一用途 60 秒内只发一次、每小时最多 6 次。
 * @param quiet 为 true 时超过频率限制不报错（登录、找回密码这类不能透露状态的地方）
 */
export async function sendCode(email: string, purpose: CodePurpose, userId: number | null, quiet = false): Promise<void> {
  if (!mailerReady()) throw new MailerError('系统还没有配置发信，请联系管理员');
  const recent = await one<{ last: number | null; n: number }>(
    `SELECT TIMESTAMPDIFF(SECOND, MAX(created_at), UTC_TIMESTAMP()) AS last, COUNT(*) AS n
     FROM auth_codes WHERE email = ? AND purpose = ? AND created_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR`,
    [email, purpose],
  );
  if (recent && ((recent.last !== null && recent.last < 60) || recent.n >= 6)) {
    if (quiet) return;
    throw Object.assign(new MailerError(recent.n >= 6 ? '验证码发送太频繁，请一小时后再试' : '验证码刚刚发过，请查收邮件，60 秒后可以重发'), { statusCode: 429 });
  }
  const code = String(randomInt(1_000_000)).padStart(6, '0');
  // 旧的验证码保留记录用于限流，但立即作废
  await exec('UPDATE auth_codes SET expires_at = UTC_TIMESTAMP() WHERE email = ? AND purpose = ? AND expires_at > UTC_TIMESTAMP()', [email, purpose]);
  await exec('INSERT INTO auth_codes (email, purpose, code_hash, user_id, expires_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)', [
    email,
    purpose,
    hashCode(email, purpose, code),
    userId,
    TTL_MIN,
  ]);
  const site = siteConfig();
  const t = PURPOSE_TEXT[purpose];
  await sendSystemMail(
    email,
    `【${site.name}】${t.subject}验证码 ${code}`,
    `${t.line}\n\n验证码：${code}\n\n${TTL_MIN} 分钟内有效，请勿告诉他人。\n\n—— ${site.name}`,
    `<div style="font:15px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#242923;max-width:460px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 12px;font-size:18px">${esc(site.name)} · ${t.subject}</h2>
<p style="margin:0 0 16px">${t.line}</p>
<p style="margin:0 0 16px;padding:14px 18px;border-radius:12px;background:#f4f6f1;font:700 28px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.2em;text-align:center">${code}</p>
<p style="margin:0;color:#7a8278;font-size:13px">${TTL_MIN} 分钟内有效，请勿告诉他人。</p></div>`,
  );
}

/** 校验验证码：对的话作废并返回当时记录的 user_id（没有则为 null），错的话累计次数，5 次后作废 */
export async function checkCode(email: string, purpose: CodePurpose, code: string): Promise<{ ok: boolean; userId: number | null }> {
  const row = await one<{ id: number; code_hash: string; attempts: number; user_id: number | null }>(
    'SELECT id, code_hash, attempts, user_id FROM auth_codes WHERE email = ? AND purpose = ? AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1',
    [email, purpose],
  );
  if (!row) return { ok: false, userId: null };
  const given = code.replace(/\D/g, '');
  if (given.length === 6 && hashCode(email, purpose, given) === row.code_hash) {
    await exec('UPDATE auth_codes SET expires_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
    return { ok: true, userId: row.user_id === null ? null : Number(row.user_id) };
  }
  await exec('UPDATE auth_codes SET attempts = attempts + 1, expires_at = IF(attempts >= 5, UTC_TIMESTAMP(), expires_at) WHERE id = ?', [row.id]);
  return { ok: false, userId: null };
}

/** 隐去邮箱中间部分，用于提示"验证码已发送到 y***@example.com" */
export const maskEmail = (email: string) => email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2');
