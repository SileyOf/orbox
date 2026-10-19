import { exec, query } from '../db.js';

// 会话线程：优先按 References / In-Reply-To 串起来，找不到时再用"回复前缀 + 相同主题"兜底

import { isReply, sha1 } from './thread-keys.js';

interface Row {
  id: number;
  user_id: number;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  subject: string;
  subject_key: string | null;
  date: Date;
}

/** 给这个邮箱里还没有线程的邮件分配线程，按时间先后处理，保证先到的邮件先有线程 */
export async function assignThreads(accountId: number): Promise<number> {
  let total = 0;
  for (let round = 0; round < 40; round++) {
    const rows = await query<Row>(
      `SELECT id, user_id, message_id, in_reply_to, refs, subject, subject_key, date FROM messages
       WHERE account_id = ? AND thread_id IS NULL ORDER BY date, id LIMIT 300`,
      [accountId],
    );
    if (!rows.length) break;
    for (const r of rows) {
      const related = [...(r.refs?.split(' ') || []), r.in_reply_to].filter((v): v is string => !!v);
      let thread: string | null = null;
      if (related.length) {
        const hit = await query<{ thread_id: string }>(
          `SELECT thread_id FROM messages WHERE user_id = ? AND message_id IN (?) AND thread_id IS NOT NULL LIMIT 1`,
          [r.user_id, related],
        );
        // 引用的邮件不在本地时，用会话起点的 Message-ID 当线程号，同一会话的其他回复也会落到同一个线程
        thread = hit[0]?.thread_id || sha1(related[0]);
      } else if (r.subject_key && isReply(r.subject)) {
        const hit = await query<{ thread_id: string }>(
          `SELECT thread_id FROM messages WHERE account_id = ? AND subject_key = ? AND thread_id IS NOT NULL
             AND date BETWEEN ? - INTERVAL 30 DAY AND ? ORDER BY date DESC LIMIT 1`,
          [accountId, r.subject_key, r.date, r.date],
        );
        thread = hit[0]?.thread_id || null;
      }
      thread ||= sha1(r.message_id || `row:${r.id}`);
      await exec('UPDATE messages SET thread_id = ? WHERE id = ?', [thread, r.id]);
    }
    total += rows.length;
  }
  return total;
}
