import { exec, query } from '../db.js';
import { emit } from '../events.js';
import { one } from '../db.js';
import { flushOutbox } from '../mail/send.js';
import { dispatchResurfaced, dispatchTaskReminder } from '../notify/dispatch.js';
import { runDigests } from '../notify/telegram.js';
import { setFlag } from '../routes/mail.js';
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
    await dispatchTaskReminder(task, task.nag_count).catch((e) => console.error('[reminder]', e.message));
  }

  // 稍后处理到点：重新标为未读让它回到收件箱顶部的视线里，并提醒一次
  const snoozed = await query<{ id: number; user_id: number; account_id: number }>(
    'SELECT id, user_id, account_id FROM messages WHERE snoozed_until <= UTC_TIMESTAMP() LIMIT 20',
  );
  for (const m of snoozed) {
    const claimed = await exec('UPDATE messages SET snoozed_until = NULL WHERE id = ? AND snoozed_until IS NOT NULL', [m.id]);
    if (!claimed.affectedRows) continue;
    await setFlag(m.user_id, [m.id], 'seen', false).catch((e) => console.error('[snooze]', e.message));
    const account = await one<{ name: string }>('SELECT name FROM accounts WHERE id = ?', [m.account_id]);
    await dispatchResurfaced(m.user_id, account?.name || '', m.id).catch((e) => console.error('[snooze]', e.message));
  }

  await flushOutbox();
  await exec('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
  await runDigests();
}

export function startScheduler(): () => void {
  let running = false;
  // 上次进程退出时正在投递的定时邮件状态未知，不自动重发以免发两遍，交给用户决定
  void exec(`UPDATE outbox SET status = 'failed', error = '服务重启时正在发送，请确认是否已发出' WHERE status = 'sending'`).catch(() => {});
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
