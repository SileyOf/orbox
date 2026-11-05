import { DateTime } from 'luxon';
import { z } from 'zod';
import type { User } from '../auth.js';
import { exec, one, query } from '../db.js';
import { emit } from '../events.js';
import { CATEGORIES, parseNote } from './parse.js';

export { CATEGORIES, parseNote };

// 简单记：一句话记下发生的事和花的钱（"打车 56 报销"），月底按分类、按出差汇总，可导出表格。
// "出差"是一个持续状态：开始出差后，期间记下的花费自动打上这次出差的标签并标记为可报销。

export interface NoteRow {
  id: number;
  user_id: number;
  day: string;
  content: string;
  amount: string | null;
  currency: string;
  category: string;
  tags: string[] | null;
  reimbursable: number;
  reimbursed: number;
  source: string;
  created_at: Date;
}


export const noteInput = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  content: z.string().trim().min(1, '写点什么吧').max(1000),
  amount: z.number().min(-1e9).max(1e9).nullish(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  category: z.string().trim().max(30).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  reimbursable: z.boolean().optional(),
  reimbursed: z.boolean().optional(),
});
export type NoteInput = z.infer<typeof noteInput> & { source?: string };

export const activeTrip = (u: User) => u.settings.trip || null;

export async function setTrip(u: User, trip: { name: string; start: string } | null) {
  const settings = { ...u.settings, trip: trip || undefined };
  if (!trip) delete settings.trip;
  await exec('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settings), u.id]);
  u.settings = settings;
  emit(u.id, { type: 'notes' });
}

export async function addNote(u: User, input: NoteInput): Promise<NoteRow> {
  const trip = activeTrip(u);
  const tags = [...(input.tags || [])];
  // 出差期间记的花费：自动打上出差标签、默认可报销
  const inTrip = trip && input.amount != null && (input.day || '9999') >= trip.start;
  if (inTrip && !tags.includes(trip.name)) tags.push(trip.name);
  const res = await exec(
    `INSERT INTO notes (user_id, day, content, amount, currency, category, tags, reimbursable, reimbursed, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      u.id,
      input.day || DateTime.now().setZone(u.timezone).toISODate(),
      input.content,
      input.amount ?? null,
      input.currency || 'CNY',
      input.category || (input.amount == null ? '备忘' : '其他'),
      JSON.stringify(tags),
      +(input.reimbursable ?? !!inTrip),
      +!!input.reimbursed,
      input.source || 'web',
    ],
  );
  emit(u.id, { type: 'notes' });
  return (await one<NoteRow>('SELECT * FROM notes WHERE id = ?', [res.insertId]))!;
}

/** 一句话记一笔：本地规则拆分；也处理开始 / 结束出差 */
export async function quickNote(u: User, text: string, source: string): Promise<{ note?: NoteRow; trip?: string; tripEnded?: string }> {
  const p = parseNote(text, u.timezone);
  if (p.tripEnd) {
    const t = activeTrip(u);
    await setTrip(u, null);
    return { tripEnded: t?.name || '出差' };
  }
  if (p.tripStart) {
    const name = `${p.tripStart === '出差' ? '' : p.tripStart}出差 ${p.day!.slice(5).replace('-', '/')}`.trim();
    await setTrip(u, { name, start: p.day! });
    const note = await addNote(u, { day: p.day, content: `开始出差${p.tripStart === '出差' ? '' : `：${p.tripStart}`}`, category: '备忘', tags: [name], source });
    return { note, trip: name };
  }
  // 句子里没说报销时交给出差状态决定（出差期间默认可报销）
  return { note: await addNote(u, { ...p, reimbursable: p.reimbursable || undefined, source }) };
}

export async function updateNote(userId: number, id: number, patch: Partial<z.infer<typeof noteInput>>) {
  const cur = await one<NoteRow>('SELECT * FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
  if (!cur) return null;
  await exec(
    'UPDATE notes SET day = ?, content = ?, amount = ?, currency = ?, category = ?, tags = ?, reimbursable = ?, reimbursed = ? WHERE id = ?',
    [
      patch.day ?? cur.day,
      patch.content ?? cur.content,
      patch.amount !== undefined ? patch.amount : cur.amount,
      patch.currency ?? cur.currency,
      patch.category ?? cur.category,
      JSON.stringify(patch.tags ?? cur.tags ?? []),
      patch.reimbursable !== undefined ? +patch.reimbursable : cur.reimbursable,
      patch.reimbursed !== undefined ? +patch.reimbursed : cur.reimbursed,
      id,
    ],
  );
  emit(userId, { type: 'notes' });
  return one<NoteRow>('SELECT * FROM notes WHERE id = ?', [id]);
}

export async function deleteNotes(userId: number, ids: number[]) {
  if (!ids.length) return 0;
  const res = await exec(`DELETE FROM notes WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [userId, ...ids]);
  emit(userId, { type: 'notes' });
  return res.affectedRows;
}

export async function markReimbursed(userId: number, ids: number[], value: boolean) {
  if (!ids.length) return 0;
  const res = await exec(`UPDATE notes SET reimbursed = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [+value, userId, ...ids]);
  emit(userId, { type: 'notes' });
  return res.affectedRows;
}

export interface NoteFilter {
  /** YYYY-MM */
  month?: string;
  from?: string;
  to?: string;
  q?: string;
  tag?: string;
  reimbursable?: boolean;
  limit?: number;
}

export function listNotes(userId: number, f: NoteFilter) {
  const where = ['user_id = ?'];
  const args: unknown[] = [userId];
  if (f.month) {
    const start = DateTime.fromISO(`${f.month}-01`);
    where.push('day >= ? AND day < ?');
    args.push(start.toISODate(), start.plus({ months: 1 }).toISODate());
  }
  if (f.from) where.push('day >= ?'), args.push(f.from);
  if (f.to) where.push('day <= ?'), args.push(f.to);
  if (f.q) where.push('content LIKE ?'), args.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
  if (f.tag) where.push('JSON_CONTAINS(tags, JSON_QUOTE(?))'), args.push(f.tag);
  if (f.reimbursable !== undefined) where.push('reimbursable = ?'), args.push(+f.reimbursable);
  return query<NoteRow>(
    `SELECT *, DATE_FORMAT(day, '%Y-%m-%d') AS day FROM notes WHERE ${where.join(' AND ')} ORDER BY day DESC, id DESC LIMIT ${Math.min(f.limit || 1000, 5000)}`,
    args,
  );
}

/** 汇总：按币种分别统计（不做汇率换算），再按分类、按标签（出差）细分 */
export function summarize(notes: NoteRow[]) {
  const byCurrency: Record<string, { total: number; reimbursable: number; pending: number; byCategory: Record<string, number> }> = {};
  const byTag: Record<string, Record<string, number>> = {};
  for (const n of notes) {
    if (n.amount === null) continue;
    const a = Number(n.amount);
    const c = (byCurrency[n.currency] ??= { total: 0, reimbursable: 0, pending: 0, byCategory: {} });
    c.total += a;
    c.byCategory[n.category] = (c.byCategory[n.category] || 0) + a;
    if (n.reimbursable) {
      c.reimbursable += a;
      if (!n.reimbursed) c.pending += a;
    }
    for (const t of n.tags || []) (byTag[t] ??= {})[n.currency] = (byTag[t][n.currency] || 0) + a;
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  for (const c of Object.values(byCurrency)) {
    c.total = round(c.total);
    c.reimbursable = round(c.reimbursable);
    c.pending = round(c.pending);
    for (const k in c.byCategory) c.byCategory[k] = round(c.byCategory[k]);
  }
  return { count: notes.length, spent: notes.filter((n) => n.amount !== null).length, byCurrency, byTag };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // 防止表格软件把 = + - @ 开头的内容当公式执行
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(notes: NoteRow[]): string {
  const head = ['日期', '内容', '金额', '币种', '分类', '标签', '可报销', '已报销'];
  const rows = notes
    .slice()
    .reverse()
    .map((n) => [n.day, n.content, n.amount ?? '', n.amount === null ? '' : n.currency, n.category, (n.tags || []).join(' '), n.reimbursable ? '是' : '', n.reimbursed ? '是' : '']);
  // 带 BOM，Excel 打开中文不乱码
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
