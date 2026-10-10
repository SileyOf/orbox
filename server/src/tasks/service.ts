import { DateTime } from 'luxon';
import { z } from 'zod';
import { exec, one, query } from '../db.js';
import { emit } from '../events.js';

export const repeatRule = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).default(1),
  /** 仅 weekly：1=周一 … 7=周日，留空表示沿用截止日的星期 */
  weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  /** 仅 monthly：记住最初是几号，避免 31 号经过小月后永久漂移到 30 号 */
  monthDay: z.number().int().min(1).max(31).optional(),
});
export type RepeatRule = z.infer<typeof repeatRule>;

export interface TaskRow {
  id: number;
  user_id: number;
  title: string;
  notes: string | null;
  due_at: Date | null;
  remind_before: number;
  repeat_rule: RepeatRule | null;
  priority: number;
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
  title: string;
  notes?: string | null;
  dueAt?: Date | null;
  remindBefore?: number;
  repeat?: RepeatRule | null;
  priority?: number;
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

export const getTask = (userId: number, id: number) =>
  one<TaskRow>('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);

export async function createTask(userId: number, tz: string, input: TaskInput): Promise<TaskRow> {
  const remindBefore = input.remindBefore ?? 0;
  const res = await exec(
    `INSERT INTO tasks (user_id, title, notes, due_at, remind_before, repeat_rule, priority, next_remind_at,
       nag_interval, mail_ref, mail_subject, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      input.title,
      input.notes || null,
      input.dueAt || null,
      remindBefore,
      normalizeRule(input.repeat, input.dueAt, tz),
      input.priority ?? 0,
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
  const dueAt = patch.dueAt !== undefined ? patch.dueAt : task.due_at;
  const remindBefore = patch.remindBefore ?? task.remind_before;
  const repeat = patch.repeat !== undefined ? patch.repeat : task.repeat_rule;
  const timingChanged =
    (dueAt?.getTime() ?? null) !== (task.due_at?.getTime() ?? null) || remindBefore !== task.remind_before;
  await exec(
    `UPDATE tasks SET title = ?, notes = ?, due_at = ?, remind_before = ?, repeat_rule = ?, priority = ?,
       nag_interval = ?, next_remind_at = ?, nag_count = ? WHERE id = ?`,
    [
      patch.title ?? task.title,
      patch.notes !== undefined ? patch.notes || null : task.notes,
      dueAt,
      remindBefore,
      normalizeRule(repeat, dueAt, tz),
      patch.priority ?? task.priority,
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
  if (task.repeat_rule && task.due_at) {
    const next = nextOccurrence(task.due_at, task.repeat_rule, tz, new Date());
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
