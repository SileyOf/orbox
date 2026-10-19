import net from 'node:net';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { z } from 'zod';

// ManageSieve（RFC 5804）客户端 + 规则 ↔ Sieve 脚本的互相转换。
// mailcow（Dovecot）默认在 4190 端口提供 ManageSieve，服务器端过滤在邮件到达时就生效，
// 不依赖 Orbox 在线。

export const SCRIPT_NAME = 'orbox';

export const ruleSchema = z.object({
  name: z.string().trim().max(100).default(''),
  enabled: z.boolean().default(true),
  match: z.enum(['all', 'any']).default('all'),
  conditions: z
    .array(
      z.object({
        field: z.enum(['from', 'to', 'cc', 'subject', 'list']),
        op: z.enum(['contains', 'not_contains', 'is', 'domain']),
        value: z.string().trim().min(1).max(300),
      }),
    )
    .min(1)
    .max(10),
  actions: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('fileinto'), folder: z.string().min(1).max(255) }),
        z.object({ type: z.literal('markread') }),
        z.object({ type: z.literal('flag') }),
        z.object({ type: z.literal('discard') }),
        z.object({ type: z.literal('redirect'), address: z.string().trim().email(), keep: z.boolean().default(true) }),
        z.object({ type: z.literal('stop') }),
      ]),
    )
    .min(1)
    .max(6),
});
export type Rule = z.infer<typeof ruleSchema>;

export interface RuleSet {
  rules: Rule[];
  /** 启用 Orbox 规则之前处于激活状态的脚本（例如 SOGo 的），会被 include 进来继续生效 */
  base: string | null;
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function condition(c: Rule['conditions'][number]): string {
  if (c.field === 'list') {
    return `${c.op === 'not_contains' ? 'not ' : ''}header :contains "list-id" ${q(c.value)}`;
  }
  if (c.op === 'domain') return `address :domain :is ${q(c.field)} ${q(c.value.replace(/^@/, ''))}`;
  if (c.field === 'subject') {
    const op = c.op === 'is' ? ':is' : ':contains';
    return `${c.op === 'not_contains' ? 'not ' : ''}header ${op} "subject" ${q(c.value)}`;
  }
  // 发件人等地址字段：精确匹配比较地址本身，包含匹配同时覆盖显示名称
  if (c.op === 'is') return `address :is ${q(c.field)} ${q(c.value)}`;
  return `${c.op === 'not_contains' ? 'not ' : ''}header :contains ${q(c.field)} ${q(c.value)}`;
}

function action(a: Rule['actions'][number]): string {
  switch (a.type) {
    case 'fileinto':
      return `fileinto ${q(a.folder)};`;
    case 'markread':
      return 'addflag "\\\\Seen";';
    case 'flag':
      return 'addflag "\\\\Flagged";';
    case 'discard':
      return 'discard;';
    case 'redirect':
      return a.keep ? `redirect :copy ${q(a.address)};` : `redirect ${q(a.address)};`;
    case 'stop':
      return 'stop;';
  }
}

/** 规则原文以 JSON 存在脚本开头的注释里，下次打开时能原样还原成可编辑的规则 */
export function buildScript(set: RuleSet): string {
  const active = set.rules.filter((r) => r.enabled);
  const needs = new Set<string>();
  for (const r of active) {
    for (const a of r.actions) {
      if (a.type === 'fileinto') needs.add('fileinto');
      if (a.type === 'markread' || a.type === 'flag') needs.add('imap4flags');
      if (a.type === 'redirect' && a.keep) needs.add('copy');
    }
  }
  if (set.base) needs.add('include');

  const lines = [
    `# Orbox 生成的过滤规则，请在 Orbox 里修改；直接改这个脚本会在下次保存时被覆盖`,
    `# orbox-rules: ${JSON.stringify(set)}`,
  ];
  if (needs.size) lines.push(`require [${[...needs].map(q).join(', ')}];`);
  for (const r of active) {
    const tests = r.conditions.map(condition);
    const test = tests.length === 1 ? tests[0] : `${r.match === 'all' ? 'allof' : 'anyof'}(${tests.join(', ')})`;
    lines.push('', `# ${r.name.replace(/[\r\n]/g, ' ') || '未命名规则'}`, `if ${test} {`, ...r.actions.map((a) => `  ${action(a)}`), '}');
  }
  if (set.base) lines.push('', `include :personal ${q(set.base)};`);
  return lines.join('\r\n') + '\r\n';
}

export function parseScript(script: string | null): RuleSet | null {
  const line = script?.match(/^# orbox-rules: (.*)$/m)?.[1];
  if (!line) return null;
  try {
    const raw = JSON.parse(line);
    return { rules: z.array(ruleSchema).parse(raw.rules), base: typeof raw.base === 'string' ? raw.base : null };
  } catch {
    return null;
  }
}

// ---------------- 协议 ----------------

interface Response {
  ok: boolean;
  lines: string[];
  literal?: string;
  message: string;
}

export class SieveClient {
  private socket!: net.Socket | tls.TLSSocket;
  private buffer = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  capabilities = new Map<string, string>();

  constructor(
    private host: string,
    private port: number,
  ) {}

  private attach(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.waiters.splice(0).forEach((w) => w());
    });
    socket.on('error', () => this.waiters.splice(0).forEach((w) => w()));
    socket.on('close', () => this.waiters.splice(0).forEach((w) => w()));
  }

  private async more() {
    if (this.socket.destroyed) throw new Error('连接已断开');
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('ManageSieve 服务器响应超时')), 15_000);
      this.waiters.push(() => (clearTimeout(t), res()));
    });
  }

  private async line(): Promise<string> {
    for (;;) {
      const i = this.buffer.indexOf('\r\n');
      if (i >= 0) {
        const l = this.buffer.subarray(0, i).toString('utf8');
        this.buffer = this.buffer.subarray(i + 2);
        return l;
      }
      await this.more();
    }
  }

  private async bytes(n: number): Promise<string> {
    while (this.buffer.length < n) await this.more();
    const out = this.buffer.subarray(0, n).toString('utf8');
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** 读到 OK / NO / BYE 为止，中间的行和字面量都收集起来 */
  private async response(): Promise<Response> {
    const lines: string[] = [];
    let literal: string | undefined;
    for (;;) {
      let l = await this.line();
      const lit = l.match(/\{(\d+)\+?\}$/);
      if (lit) {
        const text = await this.bytes(Number(lit[1]));
        if (/^\{\d+\+?\}$/.test(l)) {
          literal = text;
          continue;
        }
        l = l.replace(/\{\d+\+?\}$/, JSON.stringify(text));
      }
      const done = l.match(/^(OK|NO|BYE)\b\s*(.*)$/i);
      if (done) {
        const message = done[2].replace(/^\([^)]*\)\s*/, '').replace(/^"(.*)"$/, '$1');
        return { ok: done[1].toUpperCase() === 'OK', lines, literal, message };
      }
      lines.push(l);
    }
  }

  private async command(cmd: string): Promise<Response> {
    this.socket.write(cmd + '\r\n');
    return this.response();
  }

  private parseCapabilities(lines: string[]) {
    this.capabilities.clear();
    for (const l of lines) {
      const m = l.match(/^"([^"]+)"(?:\s+"(.*)")?$/);
      if (m) this.capabilities.set(m[1].toUpperCase(), m[2] || '');
    }
  }

  async connect(user: string, password: string, useTls: boolean) {
    await new Promise<void>((res, rej) => {
      const s = net.connect({ host: this.host, port: this.port, timeout: 15_000 }, () => res());
      s.once('error', rej);
      s.once('timeout', () => rej(new Error(`连接 ${this.host}:${this.port} 超时`)));
      this.attach(s);
    });
    const greeting = await this.response();
    this.parseCapabilities(greeting.lines);
    if (this.capabilities.has('STARTTLS')) {
      const r = await this.command('STARTTLS');
      if (!r.ok) throw new Error(`STARTTLS 失败：${r.message}`);
      const plain = this.socket as net.Socket;
      plain.removeAllListeners('data');
      const secure = await new Promise<tls.TLSSocket>((res, rej) => {
        const t = tls.connect({ socket: plain, servername: isIP(this.host) ? undefined : this.host }, () => res(t));
        t.once('error', rej);
      });
      this.buffer = Buffer.alloc(0);
      this.attach(secure);
      // RFC 5804：TLS 建立后服务器会重新发送能力列表
      this.parseCapabilities((await this.response()).lines);
    } else if (useTls) {
      throw new Error('服务器不支持 STARTTLS，为保护密码拒绝明文登录');
    }
    const token = Buffer.from(`\0${user}\0${password}`).toString('base64');
    const auth = await this.command(`AUTHENTICATE "PLAIN" "${token}"`);
    if (!auth.ok) throw new Error(`登录失败：${auth.message}`);
  }

  async list(): Promise<{ name: string; active: boolean }[]> {
    const r = await this.command('LISTSCRIPTS');
    if (!r.ok) throw new Error(r.message);
    return r.lines
      .map((l) => l.match(/^"((?:[^"\\]|\\.)*)"(\s+ACTIVE)?/i))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ name: m[1].replace(/\\(.)/g, '$1'), active: !!m[2] }));
  }

  async get(name: string): Promise<string | null> {
    const r = await this.command(`GETSCRIPT ${q(name)}`);
    return r.ok ? (r.literal ?? '') : null;
  }

  async check(script: string) {
    const n = Buffer.byteLength(script);
    const r = await this.command(`CHECKSCRIPT {${n}+}\r\n${script}`);
    if (!r.ok) throw new Error(`脚本校验失败：${r.message}`);
  }

  async put(name: string, script: string) {
    const n = Buffer.byteLength(script);
    const r = await this.command(`PUTSCRIPT ${q(name)} {${n}+}\r\n${script}`);
    if (!r.ok) throw new Error(`保存脚本失败：${r.message}`);
  }

  async activate(name: string) {
    const r = await this.command(`SETACTIVE ${q(name)}`);
    if (!r.ok) throw new Error(`启用脚本失败：${r.message}`);
  }

  async close() {
    try {
      if (!this.socket.destroyed) await this.command('LOGOUT');
    } catch {}
    this.socket.destroy();
  }
}
