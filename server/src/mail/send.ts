import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import type { User } from '../auth.js';
import { exec, one, query } from '../db.js';
import { emit } from '../events.js';
import { connParams, smtpTransport, worker } from './manager.js';
import type { AccountRow } from './manager.js';

export interface SendInput {
  accountId: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  /** 回复的原邮件 id：带上 In-Reply-To 并标记已回复 */
  replyTo?: number;
  /** 转发的原邮件 id：把原附件一并带上 */
  forwardOf?: number;
  /** 从服务器草稿继续编辑：沿用草稿里的附件，发出或重新保存后删掉旧草稿 */
  draftOf?: number;
}

type Envelope = { from: string; to: string[] };

interface Built {
  account: AccountRow;
  raw: Buffer;
  envelope: Envelope;
  /** 被回复邮件的 Message-ID，发出后据此标记"已回复" */
  replyRef: string | null;
}

interface Located {
  id: number;
  uid: number;
  account_id: number;
  message_id: string | null;
  in_reply_to: string | null;
  path: string;
}

const locate = (userId: number, id?: number) =>
  id
    ? one<Located>(
        `SELECT m.id, m.uid, m.account_id, m.message_id, m.in_reply_to, f.path
         FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ? AND m.user_id = ?`,
        [id, userId],
      )
    : Promise.resolve(undefined);

async function build(user: User, input: SendInput, files: Mail.Attachment[], date?: Date): Promise<Built> {
  const account = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND user_id = ?', [
    input.accountId,
    user.id,
  ]);
  if (!account) throw new Error('发件邮箱不存在');

  const opts: Mail.Options = {
    from: { name: account.from_name || user.name, address: account.email },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html,
    text: input.text,
    date,
    attachments: [...files],
  };

  const replied = await locate(user.id, input.replyTo);
  if (replied?.message_id) {
    opts.inReplyTo = replied.message_id;
    opts.references = [replied.in_reply_to, replied.message_id].filter((v): v is string => !!v);
  }
  // 转发的原邮件、继续编辑的草稿：把它们已有的附件带过来
  for (const source of [await locate(user.id, input.forwardOf), await locate(user.id, input.draftOf)]) {
    if (!source) continue;
    const body = await worker(source.account_id).fetchSource(source.id);
    for (const a of body.raw) {
      opts.attachments!.push({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid });
    }
  }

  const mail = new MailComposer(opts).compile();
  const env = mail.getEnvelope();
  const raw = await mail.build();
  return {
    account,
    raw,
    envelope: { from: env.from || account.email, to: env.to },
    replyRef: replied?.message_id || null,
  };
}

async function removeDraft(userId: number, draftOf?: number) {
  const draft = await locate(userId, draftOf);
  if (!draft) return;
  await worker(draft.account_id).destroy(draft.path, [draft.uid]);
  await exec('DELETE FROM messages WHERE id = ?', [draft.id]);
}

/** 真正投递：SMTP 发出后存入"已发送"并把原邮件标为已回复 */
export async function deliver(account: AccountRow, envelope: Envelope, raw: Buffer, replyRef: string | null) {
  await smtpTransport(await connParams(account)).sendMail({ envelope, raw });
  // 发信已成功，后续的存档和标记失败不应让用户以为没发出去
  try {
    if (account.save_sent) await worker(account.id).appendTo('sent', raw);
    if (replyRef) {
      const originals = await query<{ id: number; uid: number; account_id: number; path: string }>(
        `SELECT m.id, m.uid, m.account_id, f.path FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE m.user_id = ? AND m.message_id = ?`,
        [account.user_id, replyRef],
      );
      for (const o of originals) {
        await worker(o.account_id).setFlags(o.path, [o.uid], '\\Answered', true);
        await exec('UPDATE messages SET answered = 1 WHERE id = ?', [o.id]);
      }
    }
  } catch (e) {
    console.error('[send] post-send step failed', e);
  }
}

export async function sendMail(user: User, input: SendInput, files: Mail.Attachment[]): Promise<void> {
  const b = await build(user, input, files);
  await deliver(b.account, b.envelope, b.raw, b.replyRef);
  await removeDraft(user.id, input.draftOf).catch(() => {});
}

/** 定时发送：现在就把整封邮件生成好存进发件队列，到点由调度器投递 */
export async function scheduleMail(user: User, input: SendInput, files: Mail.Attachment[], sendAt: Date) {
  const b = await build(user, input, files, sendAt);
  await exec(
    `INSERT INTO outbox (user_id, account_id, send_at, subject, recipients, envelope, raw, reply_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id,
      b.account.id,
      sendAt,
      input.subject.slice(0, 1000),
      [...input.to, ...input.cc, ...input.bcc].join(', ').slice(0, 1000),
      JSON.stringify(b.envelope),
      b.raw,
      b.replyRef,
    ],
  );
  await removeDraft(user.id, input.draftOf).catch(() => {});
  emit(user.id, { type: 'outbox' });
}

export async function saveDraft(user: User, input: SendInput, files: Mail.Attachment[]): Promise<void> {
  const b = await build(user, input, files);
  if (!(await worker(b.account.id).appendTo('drafts', b.raw))) throw new Error('这个邮箱没有草稿文件夹');
  await removeDraft(user.id, input.draftOf).catch(() => {});
}

/** 调度器调用：投递到点的定时邮件。失败的保留在队列里并记下原因，由用户决定重试或删除 */
export async function flushOutbox(onlyId?: number): Promise<void> {
  const due = await query<{ id: number; user_id: number; account_id: number; envelope: Envelope; raw: Buffer; reply_ref: string | null }>(
    onlyId
      ? `SELECT id, user_id, account_id, envelope, raw, reply_ref FROM outbox WHERE id = ? AND status IN ('pending', 'failed')`
      : `SELECT id, user_id, account_id, envelope, raw, reply_ref FROM outbox
         WHERE status = 'pending' AND send_at <= UTC_TIMESTAMP() ORDER BY send_at LIMIT 10`,
    onlyId ? [onlyId] : [],
  );
  for (const row of due) {
    const claimed = await exec(`UPDATE outbox SET status = 'sending' WHERE id = ? AND status IN ('pending', 'failed')`, [row.id]);
    if (!claimed.affectedRows) continue;
    try {
      const account = await one<AccountRow>('SELECT * FROM accounts WHERE id = ?', [row.account_id]);
      if (!account) throw new Error('发件邮箱已被移除');
      await deliver(account, row.envelope, row.raw, row.reply_ref);
      await exec('DELETE FROM outbox WHERE id = ?', [row.id]);
    } catch (e: any) {
      await exec(`UPDATE outbox SET status = 'failed', error = ? WHERE id = ?`, [
        String(e.responseText || e.message).slice(0, 500),
        row.id,
      ]);
    }
    emit(row.user_id, { type: 'outbox' });
  }
}
