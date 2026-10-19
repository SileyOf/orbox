import { createHash } from 'node:crypto';

// 线程判定用到的纯函数，单独放一个文件便于测试

export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** 从原始头部里取出 References 里的所有 Message-ID（按出现顺序，第一个是会话的起点） */
export function parseRefs(headers?: Buffer): string | null {
  if (!headers) return null;
  const raw = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const line = raw.match(/^references:\s*(.*)$/im)?.[1];
  const ids = line?.match(/<[^<>\s]+>/g);
  return ids?.length ? ids.slice(0, 50).join(' ').slice(0, 4000) : null;
}

const REPLY_PREFIX = /^\s*((re|aw|sv|antw|回复|回覆|答复|答覆)\s*(\[\d+\])?\s*[:：]\s*)+/i;
const ANY_PREFIX = /^\s*((re|aw|sv|antw|fw|fwd|wg|tr|回复|回覆|答复|答覆|转发|轉寄|转寄)\s*(\[\d+\])?\s*[:：]\s*)+/i;

export const isReply = (subject: string) => REPLY_PREFIX.test(subject);

/** 去掉 Re:/Fwd:/回复： 之类的前缀和空白差异后的主题指纹 */
export function subjectKey(subject: string): string | null {
  const core = subject.replace(ANY_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return core.length >= 3 ? sha1(core) : null;
}
