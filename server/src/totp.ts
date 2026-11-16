import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sha256 } from './crypto.js';

// 两步验证用的 TOTP（RFC 6238：30 秒一个 6 位数，HMAC-SHA1），和 Google Authenticator、1Password 等通用。

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = '';
  for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpAt(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

/** 同一个验证码只能用一次：记下每个用户最近通过的时间片（换了密钥就重新算） */
const lastUsed = new Map<number, { secret: string; step: number }>();

/** 校验 6 位动态码，允许前后各一个时间片的时钟误差 */
export function verifyTotp(userId: number, secretB32: string, code: string, now = Date.now()): boolean {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const secret = base32Decode(secretB32);
  const step = Math.floor(now / 30_000);
  for (const c of [step, step - 1, step + 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, c)), Buffer.from(given))) {
      const last = lastUsed.get(userId);
      if (last && last.secret === secretB32 && last.step >= c) return false;
      lastUsed.set(userId, { secret: secretB32, step: c });
      return true;
    }
  }
  return false;
}

export const otpauthUri = (issuer: string, account: string, secretB32: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---- 恢复码：手机丢了、收不到邮件时用，每个只能用一次 ----

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const normalize = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (c: string) => sha256(`recovery:${normalize(c)}`);

export function newRecoveryCodes(): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: 10 }, () => {
    const s = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { plain, hashed: plain.map(hashRecovery) };
}

/** 用掉一个恢复码：匹配则返回剩下的哈希列表，不匹配返回 null */
export function useRecoveryCode(hashed: string[], code: string): string[] | null {
  const h = hashRecovery(code);
  const i = hashed.indexOf(h);
  return i < 0 ? null : hashed.filter((_, j) => j !== i);
}
