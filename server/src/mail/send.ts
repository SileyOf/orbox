import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import type { User } from '../auth.js';
import { exec, one } from '../db.js';
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
}

export async function sendMail(user: User, input: SendInput, files: Mail.Attachment[]): Promise<void> {
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
    attachments: [...files],
  };

  const refId = input.replyTo ?? input.forwardOf;
  const original = refId
    ? await one<{ id: number; uid: number; account_id: number; message_id: string | null; in_reply_to: string | null; path: string }>(
        `SELECT m.id, m.uid, m.account_id, m.message_id, m.in_reply_to, f.path
         FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ? AND m.user_id = ?`,
        [refId, user.id],
      )
    : undefined;

  if (original && input.replyTo && original.message_id) {
    opts.inReplyTo = original.message_id;
    opts.references = [original.in_reply_to, original.message_id].filter((v): v is string => !!v);
  }
  if (original && input.forwardOf) {
    const body = await worker(original.account_id).fetchSource(original.id);
    for (const a of body.raw) {
      opts.attachments!.push({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid });
    }
  }

  const mail = new MailComposer(opts).compile();
  const envelope = mail.getEnvelope();
  const raw = await mail.build();
  await smtpTransport(await connParams(account)).sendMail({ envelope, raw });

  // 发信已成功，后续的存档和标记失败不应让用户以为没发出去
  try {
    if (account.save_sent) await worker(account.id).appendSent(raw);
    if (original && input.replyTo) {
      await worker(original.account_id).setFlags(original.path, [original.uid], '\\Answered', true);
      await exec('UPDATE messages SET answered = 1 WHERE id = ?', [original.id]);
    }
  } catch (e) {
    console.error('[send] post-send step failed', e);
  }
}
