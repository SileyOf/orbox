import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { User } from '../auth.js';
import { exec, one, query } from '../db.js';
import { worker } from '../mail/manager.js';
import { LINK_LABELS } from '../mail/links.js';
import type { LinkInfo } from '../mail/links.js';
import { saveDraft, sendMail } from '../mail/send.js';
import type { SendInput } from '../mail/send.js';
import { moveMessages, setFlag } from '../routes/mail.js';
import { completeTask, createTask, listTasks } from '../tasks/service.js';
import { formatWhen } from '../tasks/parse.js';
import { CATEGORIES, activeTrip, addNote, listNotes, setTrip, summarize } from '../notes/service.js';
import type { ToolSpec } from './provider.js';

// 邮件和计划的工具集。内置助手和 MCP 共用同一套定义，
// 只能访问开启了"允许 AI 读取"的邮箱。

export interface ToolContext {
  user: User;
  /** 内置助手：发信必须经用户在界面上确认；MCP：看令牌是否授予了发信权限 */
  mode: 'assistant' | 'mcp';
  allowSend: boolean;
}

interface Tool<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
  /** 只在 MCP 且令牌允许发信时提供 */
  sendOnly?: boolean;
}

const tool = <S extends z.ZodTypeAny>(t: Tool<S>) => t;

const allowedAccounts = async (userId: number) =>
  (await query<{ id: number; name: string; email: string }>(
    'SELECT id, name, email FROM accounts WHERE user_id = ? AND ai_enabled = 1 ORDER BY sort, id',
    [userId],
  ));

async function accountIds(userId: number): Promise<number[]> {
  const ids = (await allowedAccounts(userId)).map((a) => a.id);
  if (!ids.length) throw new Error('用户没有为任何邮箱开启 AI 访问（设置 → 邮箱账号 → 允许 AI 读取）');
  return ids;
}

const when = (d: Date | string, tz: string) => DateTime.fromJSDate(new Date(d), { zone: tz }).toFormat('yyyy-LL-dd HH:mm');

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textToHtml = (s: string) => s.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');

// ---------------- 待确认的发信 ----------------

interface Pending {
  userId: number;
  input: SendInput;
  summary: string;
  expires: number;
}
const pending = new Map<string, Pending>();

export function takePending(userId: number, id: string): Pending | null {
  const p = pending.get(id);
  if (!p || p.userId !== userId || p.expires < Date.now()) return null;
  pending.delete(id);
  return p;
}
export const peekPending = (userId: number, id: string) => {
  const p = pending.get(id);
  return p && p.userId === userId && p.expires > Date.now() ? p : null;
};

// ---------------- 工具 ----------------

const emailInput = z.object({
  to: z.array(z.string().email()).min(1).max(20).describe('收件人邮箱地址'),
  cc: z.array(z.string().email()).max(20).optional(),
  subject: z.string().max(500),
  body: z.string().max(50_000).describe('纯文本正文，段落之间空一行'),
  reply_to_id: z.number().int().optional().describe('回复某封邮件时填它的 id，会自动带上引用关系'),
  account_id: z.number().int().optional().describe('用哪个邮箱发出，默认与被回复的邮件相同或第一个邮箱'),
});

async function toSendInput(input: z.infer<typeof emailInput>, ctx: ToolContext): Promise<{ send: SendInput; from: string }> {
  const ids = await accountIds(ctx.user.id);
  let accountId = input.account_id;
  if (!accountId && input.reply_to_id) {
    accountId = (await one<{ account_id: number }>('SELECT account_id FROM messages WHERE id = ? AND user_id = ?', [input.reply_to_id, ctx.user.id]))?.account_id;
  }
  accountId ||= ids[0];
  if (!ids.includes(accountId)) throw new Error('不能使用这个邮箱发信');
  const account = (await one<{ email: string; signature: string | null }>('SELECT email, signature FROM accounts WHERE id = ?', [accountId]))!;
  const text = account.signature ? `${input.body}\n\n-- \n${account.signature}` : input.body;
  return {
    from: account.email,
    send: {
      accountId,
      to: input.to,
      cc: input.cc || [],
      bcc: [],
      subject: input.subject,
      html: textToHtml(text),
      text,
      replyTo: input.reply_to_id,
    },
  };
}

const TOOLS = [
  tool({
    name: 'list_accounts',
    description: '列出可以访问的邮箱账号',
    schema: z.object({}),
    run: async (_i, ctx) => allowedAccounts(ctx.user.id),
  }),
  tool({
    name: 'search_mail',
    description: '搜索或列出邮件。不给 query 时按时间倒序列出。返回 id、发件人、主题、时间、摘要，需要正文时再用 read_mail。',
    schema: z.object({
      query: z.string().max(200).optional().describe('全文搜索关键词，匹配主题、发件人和正文'),
      box: z.enum(['inbox', 'sent', 'archive', 'drafts', 'all']).default('inbox'),
      unread_only: z.boolean().default(false),
      from: z.string().max(200).optional().describe('发件人地址或名字的一部分'),
      since_days: z.number().int().min(1).max(3650).optional().describe('只看最近多少天'),
      limit: z.number().int().min(1).max(30).default(10),
    }),
    run: async (i, ctx) => {
      const where = ['m.account_id IN (?)'];
      const params: unknown[] = [await accountIds(ctx.user.id)];
      if (i.box !== 'all') {
        where.push('f.role = ?');
        params.push(i.box);
      } else where.push(`(f.role IS NULL OR f.role NOT IN ('trash', 'junk'))`);
      if (i.unread_only) where.push('m.seen = 0');
      if (i.from) {
        where.push('(m.from_addr LIKE ? OR m.from_name LIKE ?)');
        params.push(`%${i.from}%`, `%${i.from}%`);
      }
      if (i.since_days) {
        where.push('m.date >= UTC_TIMESTAMP() - INTERVAL ? DAY');
        params.push(i.since_days);
      }
      const words = (i.query || '').split(/\s+/).map((w) => w.replace(/[+\-<>()~*"@]/g, '')).filter((w) => w.length >= 2);
      if (words.length) {
        where.push('MATCH(m.subject, m.from_name, m.from_addr, m.body_text) AGAINST (? IN BOOLEAN MODE)');
        params.push(words.map((w) => `+"${w}"`).join(' '));
      }
      const rows = await query(
        `SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, m.seen, m.snippet, m.code, f.role AS box, a.email AS account
         FROM messages m JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id
         WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT ?`,
        [...params, i.limit],
      );
      return rows.map((r) => ({
        id: r.id,
        from: r.from_name ? `${r.from_name} <${r.from_addr}>` : r.from_addr,
        subject: r.subject,
        date: when(r.date, ctx.user.timezone),
        unread: !r.seen,
        snippet: r.snippet.slice(0, 160),
        ...(r.code ? { code: r.code } : {}),
        box: r.box,
        account: r.account,
      }));
    },
  }),
  tool({
    name: 'read_mail',
    description: '读取一封邮件的完整内容（正文、收件人、附件名、链接、验证码）',
    schema: z.object({ id: z.number().int() }),
    run: async (i, ctx) => {
      const ids = await accountIds(ctx.user.id);
      let m = await one(`SELECT * FROM messages WHERE id = ? AND user_id = ?`, [i.id, ctx.user.id]);
      if (!m || !ids.includes(m.account_id)) throw new Error('邮件不存在或未开启 AI 访问');
      if (!m.body_fetched) {
        await worker(m.account_id).loadBody(m.id);
        m = await one(`SELECT * FROM messages WHERE id = ?`, [i.id]);
      }
      const body: string = m.body_text || '';
      return {
        id: m.id,
        from: m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr,
        to: (m.to_json || []).map((a: any) => a.address),
        cc: (m.cc_json || []).map((a: any) => a.address),
        date: when(m.date, ctx.user.timezone),
        subject: m.subject,
        ...(m.code ? { verification_code: m.code } : {}),
        attachments: (m.attachments || []).filter((a: any) => !a.inline).map((a: any) => a.filename),
        links: ((m.links || []) as LinkInfo[]).slice(0, 15).map((l) => ({ kind: LINK_LABELS[l.kind], text: l.text, url: l.url, ...(l.suspicious ? { suspicious: true } : {}) })),
        body: body.length > 30_000 ? `${body.slice(0, 30_000)}\n[正文过长，已截取前 30000 字]` : body,
      };
    },
  }),
  tool({
    name: 'mark_mail',
    description: '把邮件标为已读/未读或加/去星标',
    schema: z.object({ ids: z.array(z.number().int()).min(1).max(100), read: z.boolean().optional(), starred: z.boolean().optional() }),
    run: async (i, ctx) => {
      await accountIds(ctx.user.id);
      if (i.read !== undefined) await setFlag(ctx.user.id, i.ids, 'seen', i.read);
      if (i.starred !== undefined) await setFlag(ctx.user.id, i.ids, 'flagged', i.starred);
      return '完成';
    },
  }),
  tool({
    name: 'archive_mail',
    description: '把邮件移到归档文件夹',
    schema: z.object({ ids: z.array(z.number().int()).min(1).max(100) }),
    run: async (i, ctx) => {
      await accountIds(ctx.user.id);
      await moveMessages(ctx.user.id, i.ids, 'archive');
      return '已归档';
    },
  }),
  tool({
    name: 'list_tasks',
    description: '列出计划表里的任务',
    schema: z.object({ status: z.enum(['open', 'done']).default('open'), due_within_days: z.number().int().min(0).max(365).optional() }),
    run: async (i, ctx) => {
      const limit = i.due_within_days !== undefined ? Date.now() + i.due_within_days * 86400_000 : null;
      return (await listTasks(ctx.user.id, i.status))
        .filter((t) => !limit || (t.due_at && new Date(t.due_at).getTime() <= limit))
        .slice(0, 50)
        .map((t) => ({ id: t.id, kind: t.kind, title: t.title, due: t.due_at ? when(t.due_at, ctx.user.timezone) : null, notes: t.notes, tags: t.tags, meta: t.meta }));
    },
  }),
  tool({
    name: 'create_task',
    description:
      '在计划表里新建计划，到点会提醒用户。kind=bill 是账单 / 续费（每期提醒付款，可带金额），kind=birthday 是生日 / 纪念日（每年提醒，可用农历）。',
    schema: z.object({
      title: z.string().min(1).max(200).describe('例如"交报告"、"Netflix 续费"、"妈妈生日"'),
      kind: z.enum(['task', 'bill', 'birthday']).default('task'),
      due: z
        .string()
        .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d/)
        .optional()
        .describe('用户时区的本地时间 YYYY-MM-DDTHH:mm；账单是下次付款日，公历生日是下一次生日当天的提醒时间'),
      notes: z.string().max(2000).optional(),
      remind_before_minutes: z.number().int().min(0).max(86400).optional().describe('提前多久提醒，账单常用 1–3 天（1440–4320）'),
      repeat: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional().describe('普通任务和账单的重复周期；生日固定每年'),
      amount: z.number().min(0).optional().describe('账单每期金额'),
      currency: z.string().length(3).optional().describe('账单币种，默认 CNY'),
      person: z.string().max(60).optional().describe('生日：是谁'),
      birth_year: z.number().int().optional().describe('生日：出生年份（知道的话，用来算年龄）'),
      lunar_month: z.number().int().min(1).max(12).optional().describe('农历生日的月份；公历生日不填'),
      lunar_day: z.number().int().min(1).max(30).optional(),
    }),
    run: async (i, ctx) => {
      const due = i.due ? DateTime.fromISO(i.due.slice(0, 16), { zone: ctx.user.timezone }) : null;
      const lunar = i.kind === 'birthday' && i.lunar_month && i.lunar_day ? { month: i.lunar_month, day: i.lunar_day } : null;
      const task = await createTask(ctx.user.id, ctx.user.timezone, {
        kind: i.kind,
        title: i.title,
        notes: i.notes,
        dueAt: due?.isValid ? due.toJSDate() : null,
        remindBefore: i.remind_before_minutes ?? (i.kind === 'task' ? undefined : 1440),
        repeat: i.kind === 'bill' ? { freq: i.repeat || 'monthly', interval: 1 } : i.repeat ? { freq: i.repeat, interval: 1 } : null,
        meta:
          i.kind === 'bill'
            ? { amount: i.amount, currency: (i.currency || 'CNY').toUpperCase(), autoNote: true }
            : i.kind === 'birthday'
              ? { person: i.person || i.title.replace(/的?生日$/, ''), birthYear: i.birth_year ?? null, lunar }
              : null,
        nagInterval: i.kind === 'task' ? ctx.user.settings.nagInterval : 0,
        source: ctx.mode === 'mcp' ? 'mcp' : 'ai',
      });
      return { id: task.id, kind: task.kind, title: task.title, due: task.due_at ? formatWhen(task.due_at, ctx.user.timezone) : null };
    },
  }),
  tool({
    name: 'complete_task',
    description: '把任务标为完成（重复任务会滚动到下一次）',
    schema: z.object({ id: z.number().int() }),
    run: async (i, ctx) => {
      const t = await completeTask(ctx.user.id, ctx.user.timezone, i.id, ctx.mode);
      if (!t) throw new Error('任务不存在');
      return t.status === 'done' ? '已完成' : `已完成，下次在 ${formatWhen(t.due_at!, ctx.user.timezone)}`;
    },
  }),
  tool({
    name: 'add_note',
    description:
      '简单记：记下一件事或一笔花费（例如"打车 56 报销"、"护照放在书房抽屉"）。出差期间记的花费会自动打上出差标签并标为可报销。一句话里有多笔花费时分别调用。',
    schema: z.object({
      content: z.string().min(1).max(1000).describe('记什么，不含金额'),
      amount: z.number().optional().describe('花费金额，没有就不填'),
      currency: z.string().length(3).optional().describe('默认 CNY'),
      category: z.enum(CATEGORIES).optional(),
      day: z.string().regex(/^\d{4}-\d\d-\d\d$/).optional().describe('发生日期，默认今天（用户时区）'),
      reimbursable: z.boolean().optional().describe('是否需要报销'),
      tags: z.array(z.string().max(30)).max(5).optional(),
    }),
    run: async (i, ctx) => {
      const n = await addNote(ctx.user, { ...i, currency: i.currency?.toUpperCase(), source: ctx.mode === 'mcp' ? 'mcp' : 'ai' });
      return { id: n.id, day: n.day, content: n.content, amount: n.amount, currency: n.currency, category: n.category, tags: n.tags, reimbursable: !!n.reimbursable };
    },
  }),
  tool({
    name: 'list_notes',
    description: '查看简单记里的记录，可按月份、关键词、标签（例如某次出差）筛选，并返回按币种 / 分类汇总的金额',
    schema: z.object({
      month: z.string().regex(/^\d{4}-\d\d$/).optional().describe('YYYY-MM'),
      from: z.string().regex(/^\d{4}-\d\d-\d\d$/).optional(),
      to: z.string().regex(/^\d{4}-\d\d-\d\d$/).optional(),
      q: z.string().max(100).optional(),
      tag: z.string().max(30).optional(),
      reimbursable: z.boolean().optional(),
    }),
    run: async (i, ctx) => {
      const notes = await listNotes(ctx.user.id, { ...i, limit: 300 });
      return {
        summary: summarize(notes),
        notes: notes.slice(0, 100).map((n) => ({ id: n.id, day: n.day, content: n.content, amount: n.amount, currency: n.currency, category: n.category, tags: n.tags, reimbursable: !!n.reimbursable, reimbursed: !!n.reimbursed })),
      };
    },
  }),
  tool({
    name: 'set_trip',
    description: '开始或结束一次出差。开始后用户记的花费会自动归到这次出差、标为可报销，方便回来后汇总报销。',
    schema: z.object({
      action: z.enum(['start', 'end']),
      name: z.string().max(30).optional().describe('开始时：出差名称，例如"上海出差 11/05"'),
      start: z.string().regex(/^\d{4}-\d\d-\d\d$/).optional().describe('开始日期，默认今天'),
    }),
    run: async (i, ctx) => {
      if (i.action === 'end') {
        const t = activeTrip(ctx.user);
        await setTrip(ctx.user, null);
        return t ? `「${t.name}」已结束，可以用 list_notes 按标签"${t.name}"汇总` : '当前没有进行中的出差';
      }
      const start = i.start || DateTime.now().setZone(ctx.user.timezone).toISODate()!;
      const name = i.name || `出差 ${start.slice(5).replace('-', '/')}`;
      await setTrip(ctx.user, { name, start });
      return `已开始「${name}」`;
    },
  }),
  tool({
    name: 'draft_email',
    description:
      '起草一封邮件（新邮件或回复）。不会直接发出：内置助手里会请用户确认后发送；通过 MCP 调用时存入邮箱的草稿箱。',
    schema: emailInput,
    run: async (i, ctx) => {
      const { send, from } = await toSendInput(i, ctx);
      if (ctx.mode === 'mcp') {
        await saveDraft(ctx.user, send, []);
        return '已存入草稿箱';
      }
      const id = randomBytes(4).toString('hex');
      const summary = `发件人：${from}\n收件人：${send.to.join(', ')}${send.cc.length ? `\n抄送：${send.cc.join(', ')}` : ''}\n主题：${send.subject}\n\n${send.text}`;
      pending.set(id, { userId: ctx.user.id, input: send, summary, expires: Date.now() + 30 * 60_000 });
      return { pending_id: id, note: '草稿已生成，正在等用户点"发送"确认。不要说已经发出。' };
    },
  }),
  tool({
    name: 'send_email',
    description: '直接发送邮件（仅在用户为这个连接授予了发信权限时可用）',
    schema: emailInput,
    sendOnly: true,
    run: async (i, ctx) => {
      if (!ctx.allowSend) throw new Error('没有发信权限');
      const { send } = await toSendInput(i, ctx);
      await sendMail(ctx.user, send, []);
      return '已发送';
    },
  }),
];

/** 某个场景下可用的工具 */
export function toolsFor(ctx: Pick<ToolContext, 'mode' | 'allowSend'>) {
  return TOOLS.filter((t) => !t.sendOnly || (ctx.mode === 'mcp' && ctx.allowSend));
}

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
}

export function toolSpecs(ctx: Pick<ToolContext, 'mode' | 'allowSend'>): ToolSpec[] {
  return toolsFor(ctx).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: jsonSchema(t.schema),
  }));
}

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<string> {
  const t = toolsFor(ctx).find((x) => x.name === name);
  if (!t) throw new Error(`未知工具 ${name}`);
  const parsed = t.schema.safeParse(input ?? {});
  if (!parsed.success) throw new Error(`参数不正确：${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
  const out = await t.run(parsed.data as never, ctx);
  return typeof out === 'string' ? out : JSON.stringify(out);
}

export { TOOLS };

/** 记录 API 令牌的使用时间，便于用户发现不再使用的连接 */
export const touchToken = (id: number) => exec('UPDATE api_tokens SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [id]);
