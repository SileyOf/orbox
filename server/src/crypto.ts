import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
// 密钥可能在安装向导里才确定，所以按当前的 APP_SECRET 惰性派生
let cached: { secret: string; key: Buffer } | null = null;
const keyOf = (secret: string) => createHash('sha256').update(secret).digest();
function currentKey(): Buffer {
  if (!config.appSecret) throw new Error('APP_SECRET 还没有配置');
  if (cached?.secret !== config.appSecret) cached = { secret: config.appSecret, key: keyOf(config.appSecret) };
  return cached.key;
}

/** AES-256-GCM，输出 iv.tag.data（base64） */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', currentKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function decryptWithKey(enc: string, key: Buffer): string {
  const [iv, tag, data] = enc.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export const decrypt = (enc: string): string => decryptWithKey(enc, currentKey());

/** 某个密钥能否解开这段密文（安装向导接管已有数据库时用来核对 APP_SECRET） */
export function canDecrypt(enc: string, secret: string): boolean {
  try {
    decryptWithKey(enc, keyOf(secret));
    return true;
  } catch {
    return false;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('hex');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
