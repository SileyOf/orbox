import { exec, query } from '../db.js';
import { emit } from '../events.js';
import { notifyTaskReminder, runDigests } from '../notify/telegram.js';
import type { TaskRow } from './service.js';

const TICK = 15_000;
/** 一直不处理的任务最多连续催这么多次，之后保持未完成但不再打扰 */
const MAX_NAGS = 8;

async function tick() {
  const due = await query<TaskRow>(
    `SELECT * FROM tasks WHERE status = 'open' AND next_remind_at <= UTC_TIMESTAMP() ORDER BY next_remind_at LIMIT 50`,
  );
  for (const task of due) {
    const again =
      task.nag_interval > 0 && task.nag_count < MAX_NAGS ? new Date(Date.now() + task.nag_interval * 60_000) : null;
    // 带条件的更新充当认领，保证同一次提醒不会被发两遍
    const claimed = await exec(
      'UPDATE tasks SET next_remind_at = ?, nag_count = nag_count + 1 WHERE id = ? AND next_remind_at = ?',
      [again, task.id, task.next_remind_at],
    );
    if (!claimed.affectedRows) continue;
    emit(task.user_id, { type: 'reminder', id: task.id, title: task.title });
    emit(task.user_id, { type: 'tasks' });
    await notifyTaskReminder(task, task.nag_count).catch((e) => console.error('[reminder]', e.message));
  }
  await exec('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
  await runDigests();
}

export function startScheduler(): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e: any) {
      console.error('[scheduler]', e?.message || e);
    } finally {
      running = false;
    }
  }, TICK);
  return () => clearInterval(timer);
}
