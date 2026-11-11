import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'node:util';

// 运行日志：照常输出到 stdout / stderr（docker logs 能看到），同时保留最近的一段在内存里，
// 供后台"日志"页面直接查看；设置 LOG_DIR 时还会写入文件（按 5MB 轮转）。

export interface LogLine {
  t: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const MAX_LINES = 3000;
const lines: LogLine[] = [];
const dir = process.env.LOG_DIR || '';
const file = dir ? path.join(dir, 'orbox.log') : '';
let fileQueue = Promise.resolve();

/** 日志里不应出现的敏感信息（令牌、密码、API Key 之类）做一次粗略遮盖 */
const redact = (s: string) =>
  s
    .replace(/\b(\d{6,}:[A-Za-z0-9_-]{30,})\b/g, '[telegram-token]')
    .replace(/\b(xox[abp]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})\b/g, '[slack-token]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|orbox_[a-f0-9]{20,})\b/g, '[api-key]')
    .replace(/(password|passwd|secret|token)(["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, '$1$2[hidden]');

function push(level: LogLine['level'], args: unknown[]) {
  const msg = redact(format(...args));
  lines.push({ t: Date.now(), level, msg });
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  if (file) {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}\n`;
    fileQueue = fileQueue
      .then(async () => {
        await mkdir(dir, { recursive: true });
        const st = await stat(file).catch(() => null);
        if (st && st.size > 5 * 1024 * 1024) await rename(file, `${file}.1`).catch(() => {});
        await appendFile(file, line);
      })
      .catch(() => {});
  }
}

/** 接管 console，之后所有模块里的 console.log / warn / error 都会进入日志 */
let installed = false;
export function installLogger() {
  if (installed) return;
  installed = true;
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => (push('info', a), orig.log(...a));
  console.info = (...a: unknown[]) => (push('info', a), orig.info(...a));
  console.warn = (...a: unknown[]) => (push('warn', a), orig.warn(...a));
  console.error = (...a: unknown[]) => (push('error', a), orig.error(...a));
}

export function recentLogs(opts: { level?: string; q?: string; limit?: number }) {
  const rank = { info: 0, warn: 1, error: 2 } as const;
  const min = rank[(opts.level as keyof typeof rank) || 'info'] ?? 0;
  const q = opts.q?.toLowerCase();
  return lines
    .filter((l) => rank[l.level] >= min && (!q || l.msg.toLowerCase().includes(q)))
    .slice(-(opts.limit || 500))
    .reverse();
}

export const logFile = () => file || null;

// 导入即生效：index.ts 第一行就导入本模块，这样其他模块在加载阶段打印的内容（例如配置警告）也能进日志
installLogger();
