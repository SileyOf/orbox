import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// 给聊天机器人用的"在浏览器中查看原文"链接：带签名、有有效期，不需要登录。
// 拿到链接的人就能看到这一封邮件，所以有效期不宜太长。

const TTL_DAYS = 7;

const sign = (payload: string) =>
  createHmac('sha256', `${config.appSecret}:webview`).update(payload).digest('base64url').slice(0, 22);

export function webviewToken(messageId: number, userId: number, days = TTL_DAYS): string {
  const payload = `${messageId}.${userId}.${Math.floor(Date.now() / 1000) + days * 86400}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function verifyWebview(token: string): { messageId: number; userId: number } | null {
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const payload = Buffer.from(b64, 'base64url').toString();
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [messageId, userId, exp] = payload.split('.').map(Number);
  if (!messageId || !userId || exp < Date.now() / 1000) return null;
  return { messageId, userId };
}

export const webviewUrl = (messageId: number, userId: number) =>
  config.publicUrl.startsWith('https://') ? `${config.publicUrl}/v/${webviewToken(messageId, userId)}` : null;
