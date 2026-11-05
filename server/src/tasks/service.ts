import { DateTime } from 'luxon';
import { z } from 'zod';
import { exec, one, query } from '../db.js';
import { emit } from '../events.js';
import { nextLunarOccurrence } from './lunar.js';
import { getUser } from '../auth.js';
import { addNote } from '../notes/service.js';

export const repeatRule = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).default(1),
  /** 仅 weekly：1=周一 … 7=周日，留空表示沿用截止日的星期 */
  weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  /** 仅 monthly：记住最初是几号，避免 31 号经过小月后永久漂移到 30 号 */
  monthDay: z.number().int().min(1).max(31).optional(),
});
export type RepeatRule = z.infer<typeof repeatRule>;

/** 计划类型：普通待办 / 账单续费（每期提醒付款）/ 生日纪念日（每年，支持农历） */
export const TASK_KINDS = ['task', 'bill', 'birthday'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const taskMeta = z
  .object({
    /** 账单：每期金额、币种、付款 / 续费链接、付款方式；付款后是否自动记进"简单记" */
    amount: z.number().min(0).max(1e9),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    payUrl: z.string().trim().max(500).refine((v) => v === '' || /^https?:\/\//i.test(v), '链接必须以 http:// 或 https:// 开头'),
    payMethod: z.string().trim().max(40),
    autoNote: z.boolean(),
    /** 生日：是谁、什么关系、出生年份（算年龄，可空）、农历月日（为空表示公历） */
    person: z.string().trim().max(60),
    relation: z.string().trim().max(30),
    birthYear: z.number().int().min(1900).max(2100).nullable(),
    lunar: z.object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(30) }).nullable(),
  })
  .partial();
export type TaskMeta = z.infer<typeof taskMeta>;

export interface TaskRow {
  id: number;
  user_id: number;
  kind: TaskKind;
  meta: TaskMeta | null;
  title: string;
  notes: string | null;
  due_at: Date | null;
  remind_before: number;
  repeat_rule: RepeatRule | null;
  priority: number;
  tags: string[] | null;
  status: 'open' | 'done';
  completed_at: Date | null;
  next_remind_at: Date | null;
  nag_interval: number;
  nag_count: number;
  /** 关联邮件的 Message-ID 头：邮件被移动后本地行 id 会变，头不会 */
  mail_ref: string | null;
  mail_subject: string | null;
  source: string;
}

export interface TaskInput {
  kind?: TaskKind;
  meta?: TaskMeta | null;
  title: string;
  notes?: string | null;
  dueAt?: Date | null;
  remindBefore?: number;
  repeat?: RepeatRule | null;
  priority?: number;
  tags?: string[];
  nagInterval?: number;
  mailRef?: string | null;
  mailSubject?: string | null;
  source?: string;
}

/** 严格晚于 after 的下一次发生时间（按用户时区推算，夏令时下钟点不变） */
export function nextOccurrence(due: Date, rule: RepeatRule, tz: string, after: Date): Date {
  let d = DateTime.fromJSDate(due, { zone: tz });
  const base = d;
  const limit = after.getTime();
  const weeksFromBase = (x: DateTime) => Math.round(x.startOf('week').diff(base.startOf('week'), 'weeks').weeks);
  for (let i = 0; i < 5000; i++) {
    if (rule.freq === 'daily') {
      d = d.plus({ days: rule.interval });
    } else if (rule.freq === 'weekly' && rule.weekdays?.length) {
      do d = d.plus({ days: 1 });
      while (!rule.weekdays.includes(d.weekday) || weeksFromBase(d) % rule.interval !== 0);
    } else if (rule.freq === 'weekly') {
      d = d.plus({ weeks: rule.interval });
    } else if (rule.freq === 'monthly') {
      d = d.plus({ months: rule.interval });
      if (rule.monthDay) d = d.set({ day: Math.min(rule.monthDay, d.daysInMonth!) });
    } else {
      d = d.plus({ years: rule.interval });
    }
    if (d.toMillis() > limit) break;
  }
  return d.toJSDate();
}

function remindAt(dueAt: Date | null | undefined, remindBefore: number): Date | null {
  if (!dueAt) return null;
  const at = new Date(dueAt.getTime() - remindBefore * 60_000);
  // 截止时间已过的任务不再补发提醒
  return dueAt.getTime() > Date.now() ? at : null;
}

function normalizeRule(rule: RepeatRule | null | undefined, dueAt: Date | null | undefined, tz: string) {
  if (!rule || !dueAt) return null;
  if (rule.freq === 'monthly') rule = { ...rule, monthDay: DateTime.fromJSDate(dueAt, { zone: tz }).day };
  return JSON.stringify(rule);
}

/** 按类型整理：生日固定每年重复，农历生日的日期由农历推算 */
function shape(kind: TaskKind, input: { dueAt?: Date | null; repeat?: RepeatRule | null; meta?: TaskMeta | null }, tz: string) {
  let { dueAt, repeat } = input;
  if (kind === 'birthday') {
    repeat = { freq: 'yearly', interval: 1 };
    const lunar = input.meta?.lunar;
    if (lunar) {
      const base = dueAt ? DateTime.fromJSDate(dueAt, { zone: tz }) : DateTime.now().setZone(tz).set({ hour: 9, minute: 0 });
      // 今天就是生日时也算这一次（从今天零点之后找）
      dueAt = nextLunarOccurrence(lunar, { hour: base.hour, minute: base.minute }, tz, DateTime.now().setZone(tz).startOf('day').minus({ seconds: 1 }).toJSDate());
    }
    if (!dueAt) throw Object.assign(new Error('请选择生日日期'), { statusCode: 400 });
  }
  if (kind === 'bill' && !dueAt) throw Object.assign(new Error('请选择下次付款日期'), { statusCode: 400 });
  return { dueAt, repeat };
}

export const getTask = (userId: number, id: number) =>
  one<TaskRow>('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);

export async function createTask(userId: number, tz: string, input: TaskInput): Promise<TaskRow> {
  const remindBefore = input.remindBefore ?? 0;
  const kind = input.kind || 'task';
  const { dueAt, repeat } = shape(kind, input, tz);
  input = { ...input, dueAt };
  const res = await exec(
    `INSERT INTO tasks (user_id, kind, meta, title, notes, due_at, remind_before, repeat_rule, priority, tags, next_remind_at,
       nag_interval, mail_ref, mail_subject, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      kind,
      input.meta && kind !== 'task' ? JSON.stringify(input.meta) : null,
      input.title,
      input.notes || null,
      input.dueAt || null,
      remindBefore,
      normalizeRule(repeat, input.dueAt, tz),
      input.priority ?? 0,
      JSON.stringify(input.tags ?? []),
      remindAt(input.dueAt, remindBefore),
      input.nagInterval ?? 0,
      input.mailRef || null,
      input.mailSubject?.slice(0, 500) || null,
      input.source || 'web',
    ],
  );
  emit(userId, { type: 'tasks' });
  return (await getTask(userId, res.insertId))!;
}

export async function updateTask(userId: number, tz: string, id: number, patch: Partial<TaskInput>) {
  const task = await getTask(userId, id);
  if (!task) return undefined;
  const kind = patch.kind ?? task.kind;
  const meta = patch.meta !== undefined ? patch.meta : task.meta;
  // MySQL 的 JSON 会重排键的顺序，按值比较
  const lk = (l?: { month: number; day: number } | null) => (l ? `${l.month}-${l.day}` : '');
  const lunarChanged = lk(patch.meta?.lunar) !== lk(task.meta?.lunar);
  const { dueAt, repeat } = shape(
    kind,
    {
      // 农历日期没变、只改了别的字段时保留当前这一次的日期
      dueAt: patch.dueAt !== undefined ? patch.dueAt : task.due_at,
      repeat: patch.repeat !== undefined ? patch.repeat : task.repeat_rule,
      meta: kind === 'birthday' && meta?.lunar && (patch.meta === undefined || (!lunarChanged && patch.dueAt === undefined)) ? { ...meta, lunar: null } : meta,
    },
    tz,
  );
  const remindBefore = patch.remindBefore ?? task.remind_before;
  const timingChanged =
    (dueAt?.getTime() ?? null) !== (task.due_at?.getTime() ?? null) || remindBefore !== task.remind_before;
  await exec(
    `UPDATE tasks SET kind = ?, meta = ?, title = ?, notes = ?, due_at = ?, remind_before = ?, repeat_rule = ?, priority = ?, tags = ?,
       nag_interval = ?, next_remind_at = ?, nag_count = ? WHERE id = ?`,
    [
      kind,
      meta && kind !== 'task' ? JSON.stringify(meta) : null,
      patch.title ?? task.title,
      patch.notes !== undefined ? patch.notes || null : task.notes,
      dueAt,
      remindBefore,
      normalizeRule(repeat, dueAt, tz),
      patch.priority ?? task.priority,
      JSON.stringify(patch.tags ?? task.tags ?? []),
      patch.nagInterval ?? task.nag_interval,
      timingChanged ? remindAt(dueAt, remindBefore) : task.next_remind_at,
      timingChanged ? 0 : task.nag_count,
      id,
    ],
  );
  emit(userId, { type: 'tasks' });
  return getTask(userId, id);
}

const log = (task: TaskRow, action: string, via: string) =>
  exec('INSERT INTO task_logs (task_id, user_id, action, due_at, via) VALUES (?, ?, ?, ?, ?)', [
    task.id,
    task.user_id,
    action,
    task.due_at,
    via,
  ]);

/** 重复任务滚动到下一次；一次性任务按 finish 决定是否标记完成 */
async function advance(task: TaskRow, tz: string, action: 'done' | 'skip', via: string) {
  await log(task, action, via);
  // 账单标记"已付"时自动记一笔到简单记，月底汇总时能看到
  if (action === 'done' && task.kind === 'bill' && task.meta?.amount && task.meta.autoNote !== false) {
    const user = await getUser(task.user_id);
    if (user)
      await addNote(user, {
        content: task.title,
        amount: task.meta.amount,
        currency: task.meta.currency || 'CNY',
        category: '账单',
        day: DateTime.now().setZone(tz).toISODate()!,
        reimbursable: false,
        source: 'bill',
      }).catch((e) => console.error('[notes] 账单自动记账失败：', e.message));
  }
  if (task.repeat_rule && task.due_at) {
    const lunar = task.kind === 'birthday' ? task.meta?.lunar : null;
    const local = DateTime.fromJSDate(task.due_at, { zone: tz });
    // 从这一次之后开始找下一次（提前完成也不会在同一期内重复）
    const after = new Date(Math.max(Date.now(), task.due_at.getTime()));
    const next = lunar
      ? nextLunarOccurrence(lunar, { hour: local.hour, minute: local.minute }, tz, after)
      : nextOccurrence(task.due_at, task.repeat_rule, tz, task.kind === 'task' ? new Date() : after);
    await exec('UPDATE tasks SET due_at = ?, next_remind_at = ?, nag_count = 0 WHERE id = ?', [
      next,
      remindAt(next, task.remind_before),
      task.id,
    ]);
  } else if (action === 'done') {
    await exec(
      `UPDATE tasks SET status = 'done', completed_at = UTC_TIMESTAMP(), next_remind_at = NULL WHERE id = ?`,
      [task.id],
    );
  } else {
    await exec('UPDATE tasks SET next_remind_at = NULL WHERE id = ?', [task.id]);
  }
  emit(task.user_id, { type: 'tasks' });
}

export async function completeTask(userId: number, tz: string, id: number, via = 'web') {
  const task = await getTask(userId, id);
  if (!task || task.status !== 'open') return task;
  await advance(task, tz, 'done', via);
  return getTask(userId, id);
}

/** 跳过：重复任务跳到下一次，一次性任务只是停止继续提醒 */
export async function skipTask(userId: number, tz: string, id: number, via = 'web') {
  const task = await getTask(userId, id);
  if (!task || task.status !== 'open') return task;
  await advance(task, tz, 'skip', via);
  return getTask(userId, id);
}

export async function snoozeTask(userId: number, id: number, until: Date) {
  const res = await exec(
    `UPDATE tasks SET next_remind_at = ?, nag_count = 0 WHERE id = ? AND user_id = ? AND status = 'open'`,
    [until, id, userId],
  );
  if (res.affectedRows) emit(userId, { type: 'tasks' });
  return getTask(userId, id);
}

export async function reopenTask(userId: number, id: number) {
  await exec(`UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ? AND user_id = ?`, [id, userId]);
  emit(userId, { type: 'tasks' });
  return getTask(userId, id);
}

export async function deleteTask(userId: number, id: number) {
  const res = await exec('DELETE FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);
  if (res.affectedRows) emit(userId, { type: 'tasks' });
  return res.affectedRows > 0;
}

const LINKED_MAIL = `(SELECT id FROM messages WHERE user_id = t.user_id AND message_id = t.mail_ref
  ORDER BY id DESC LIMIT 1) AS mail_id`;

export function listTasks(userId: number, status: 'open' | 'done') {
  return status === 'open'
    ? query<TaskRow>(
        `SELECT t.*, ${LINKED_MAIL} FROM tasks t
         WHERE t.user_id = ? AND t.status = 'open' ORDER BY t.due_at IS NULL, t.due_at, t.priority DESC, t.id`,
        [userId],
      )
    : query<TaskRow>(
        `SELECT t.*, ${LINKED_MAIL} FROM tasks t
         WHERE t.user_id = ? AND t.status = 'done' ORDER BY t.completed_at DESC LIMIT 200`,
        [userId],
      );
}

/** 今天（用户时区）到期或已逾期的未完成任务 */
export function dueToday(userId: number, tz: string) {
  const end = DateTime.now().setZone(tz).endOf('day').toJSDate();
  return query<TaskRow>(
    `SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at <= ?
     ORDER BY due_at`,
    [userId, end],
  );
}
