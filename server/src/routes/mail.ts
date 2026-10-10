import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { exec, one, query } from '../db.js';
import { emit, subscribe } from '../events.js';
import { worker } from '../mail/manager.js';
import { flushOutbox, saveDraft, scheduleMail, sendMail } from '../mail/send.js';
import type { AttachmentMeta } from '../mail/parse.js';

const LIST_COLUMNS = `m.id, m.account_id, m.folder_id, m.subject, m.from_name, m.from_addr, m.to_json AS \`to\`,
  m.date, m.seen, m.flagged, m.answered, m.has_attachments, m.snippet, m.code, m.snoozed_until, f.role AS folder_role, f.name AS folder_name`;

const listQuery = z.object({
  view: z.enum(['inbox', 'unread', 'starred', 'snoozed', 'folder', 'search']).default('inbox'),
  folderId: z.coerce.number().int().optional(),
  accountId: z.coerce.number().int().optional(),
  q: z.string().trim().max(200).optional(),
  before: z.string().regex(/^\d+_\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ids = z.array(z.number().int()).min(1).max(500);

interface Located {
  id: number;
  uid: number;
  account_id: number;
  folder_id: number;
  path: string;
  role: string | null;
}

async function locate(userId: number, messageIds: number[]): Promise<Map<number, Located[]>> {
  const rows = await query<Located>(
    `SELECT m.id, m.uid, m.account_id, m.folder_id, f.path, f.role
     FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND m.id IN (?)`,
    [userId, messageIds],
  );
  const byFolder = new Map<number, Located[]>();
  for (const r of rows) byFolder.set(r.folder_id, [...(byFolder.get(r.folder_id) || []), r]);
  return byFolder;
}

const recount = (folderId: number) =>
  exec(
    `UPDATE folders f SET
       total = (SELECT COUNT(*) FROM messages WHERE folder_id = f.id),
       unread = (SELECT COUNT(*) FROM messages WHERE folder_id = f.id AND seen = 0)
     WHERE id = ?`,
    [folderId],
  );

/** 供网页和 Telegram 按钮共用 */
export async function setFlag(userId: number, messageIds: number[], flag: 'seen' | 'flagged', on: boolean) {
  const groups = await locate(userId, messageIds);
  for (const [folderId, rows] of groups) {
    await exec(`UPDATE messages SET ${flag} = ? WHERE id IN (?)`, [+on, rows.map((r) => r.id)]);
    await recount(folderId);
    await worker(rows[0].account_id).setFlags(
      rows[0].path,
      rows.map((r) => r.uid),
      flag === 'seen' ? '\\Seen' : '\\Flagged',
      on,
    );
    emit(userId, { type: 'mail', accountId: rows[0].account_id, folderId });
  }
}

export async function moveMessages(userId: number, messageIds: number[], to: string | number) {
  const groups = await locate(userId, messageIds);
  for (const [folderId, rows] of groups) {
    const accountId = rows[0].account_id;
    const dest = await one<{ id: number; path: string }>(
      typeof to === 'number'
        ? 'SELECT id, path FROM folders WHERE account_id = ? AND id = ?'
        : 'SELECT id, path FROM folders WHERE account_id = ? AND role = ?',
      [accountId, to],
    );
    const uids = rows.map((r) => r.uid);
    const w = worker(accountId);
    if (to === 'trash' && (rows[0].role === 'trash' || !dest)) {
      // 已在废纸篓里（或服务器没有废纸篓）再删就是彻底删除
      await w.destroy(rows[0].path, uids);
    } else if (!dest) {
      throw new Error('该邮箱没有对应的目标文件夹');
    } else if (dest.id === folderId) {
      continue;
    } else {
      await w.move(rows[0].path, uids, dest.path);
    }
    await exec('DELETE FROM messages WHERE id IN (?)', [rows.map((r) => r.id)]);
    await recount(folderId);
    emit(userId, { type: 'mail', accountId, folderId });
  }
}

/** ngram 全文索引下把每个词当短语匹配，并去掉布尔模式的操作符 */
function fulltextQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((w) => w.replace(/[+\-<>()~*"@]/g, ' ').trim())
    .filter(Boolean)
    .map((w) => `+"${w}"`)
    .join(' ');
}

export async function mailRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    req.raw.on('close', subscribe(req.user.id, reply.raw));
  });

  app.get('/api/messages', async (req) => {
    const p = listQuery.parse(req.query);
    const where = ['m.user_id = ?'];
    const params: unknown[] = [req.user.id];

    if (p.view === 'folder' && p.folderId) {
      where.push('m.folder_id = ?');
      params.push(p.folderId);
    } else if (p.view === 'search' && p.q) {
      const ft = fulltextQuery(p.q);
      if (p.q.length >= 2 && ft) {
        where.push('MATCH(m.subject, m.from_name, m.from_addr, m.body_text) AGAINST (? IN BOOLEAN MODE)');
        params.push(ft);
      } else {
        where.push('(m.subject LIKE ? OR m.from_name LIKE ?)');
        params.push(`%${p.q}%`, `%${p.q}%`);
      }
      where.push(`(f.role IS NULL OR f.role NOT IN ('trash', 'junk'))`);
    } else if (p.view === 'starred') {
      where.push('m.flagged = 1');
    } else if (p.view === 'snoozed') {
      where.push('m.snoozed_until IS NOT NULL');
    } else {
      // 稍后处理的邮件在到点之前不出现在收件箱里
      where.push(`f.role = 'inbox' AND m.snoozed_until IS NULL`);
      if (p.view === 'unread') where.push('m.seen = 0');
    }
    if (p.accountId) {
      where.push('m.account_id = ?');
      params.push(p.accountId);
    }
    if (p.before) {
      const [ms, id] = p.before.split('_').map(Number);
      where.push('(m.date < ? OR (m.date = ? AND m.id < ?))');
      params.push(new Date(ms), new Date(ms), id);
    }

    const rows = await query(
      `SELECT ${LIST_COLUMNS} FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE ${where.join(' AND ')} ORDER BY m.date DESC, m.id DESC LIMIT ?`,
      [...params, p.limit + 1],
    );
    const items = rows.slice(0, p.limit);
    const last = items[items.length - 1];
    return {
      items,
      next: rows.length > p.limit && last ? `${new Date(last.date).getTime()}_${last.id}` : null,
    };
  });

  app.get<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
    const load = () =>
      one(
        `SELECT m.id, m.account_id, m.folder_id, m.message_id, m.subject, m.from_name, m.from_addr,
                m.to_json AS \`to\`, m.cc_json AS cc, m.reply_to, m.date, m.size, m.seen, m.flagged, m.answered,
                m.code, m.snoozed_until, m.body_fetched, m.body_text, m.body_html, m.attachments, f.role AS folder_role, f.name AS folder_name
         FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ? AND m.user_id = ?`,
        [req.params.id, req.user.id],
      );
    let msg = await load();
    if (!msg) return reply.code(404).send({ error: '邮件不存在' });
    let bodyError: string | null = null;
    if (!msg.body_fetched) {
      try {
        await worker(msg.account_id).loadBody(msg.id);
        msg = await load();
      } catch (e: any) {
        bodyError = e.message;
      }
    }
    const attachments: AttachmentMeta[] = msg.attachments || [];
    let html: string | null = msg.body_html;
    if (html) {
      for (const a of attachments) {
        if (a.inline && a.cid) html = html.split(`cid:${a.cid}`).join(`/api/messages/${msg.id}/attachments/${a.i}`);
      }
    }
    return { ...msg, body_html: html, attachments: attachments.filter((a) => !a.inline), bodyError };
  });

  app.get<{ Params: { id: string; i: string } }>('/api/messages/:id/attachments/:i', async (req, reply) => {
    const msg = await one<{ id: number; account_id: number }>(
      'SELECT id, account_id FROM messages WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id],
    );
    if (!msg) return reply.code(404).send({ error: '邮件不存在' });
    const body = await worker(msg.account_id).fetchSource(msg.id);
    const att = body.raw[Number(req.params.i)];
    if (!att) return reply.code(404).send({ error: '附件不存在' });
    // 附件内容不可信：只有位图允许内联显示，其余一律作为下载，避免同源下执行 HTML/SVG
    const safeInline = /^image\/(png|jpeg|gif|webp)$/i.test(att.contentType);
    const filename = encodeURIComponent(att.filename || 'attachment');
    return reply
      .header('Content-Type', safeInline ? att.contentType : 'application/octet-stream')
      .header('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=3600')
      .send(att.content);
  });

  app.post('/api/messages/flags', async (req) => {
    const body = z.object({ ids, seen: z.boolean().optional(), flagged: z.boolean().optional() }).parse(req.body);
    if (body.seen !== undefined) await setFlag(req.user.id, body.ids, 'seen', body.seen);
    if (body.flagged !== undefined) await setFlag(req.user.id, body.ids, 'flagged', body.flagged);
    return { ok: true };
  });

  app.post('/api/messages/move', async (req, reply) => {
    const body = z
      .object({ ids, to: z.enum(['inbox', 'archive', 'trash', 'junk']).or(z.number().int()) })
      .parse(req.body);
    try {
      await moveMessages(req.user.id, body.ids, body.to);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    return { ok: true };
  });

  app.post('/api/messages/snooze', async (req) => {
    const body = z.object({ ids, until: z.coerce.date().nullable() }).parse(req.body);
    await exec('UPDATE messages SET snoozed_until = ? WHERE user_id = ? AND id IN (?)', [body.until, req.user.id, body.ids]);
    emit(req.user.id, { type: 'mail', accountId: 0 });
    return { ok: true };
  });

  /** 发信、定时发送、存草稿共用同一种 multipart 请求体 */
  async function readCompose(req: FastifyRequest) {
    let payload: unknown;
    const files: { filename: string; content: Buffer; contentType: string }[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        files.push({ filename: part.filename, content: await part.toBuffer(), contentType: part.mimetype });
      } else if (part.fieldname === 'payload') {
        payload = JSON.parse(String(part.value));
      }
    }
    const addrs = z.array(z.string().trim().min(3).max(320)).max(100).default([]);
    const input = z
      .object({
        accountId: z.number().int(),
        to: addrs,
        cc: addrs,
        bcc: addrs,
        subject: z.string().max(998).default(''),
        html: z.string().max(5_000_000),
        text: z.string().max(5_000_000).default(''),
        replyTo: z.number().int().optional(),
        forwardOf: z.number().int().optional(),
        draftOf: z.number().int().optional(),
        sendAt: z.coerce.date().optional(),
      })
      .parse(payload);
    return { input, files };
  }

  app.post('/api/send', async (req, reply) => {
    const { input, files } = await readCompose(req);
    if (!input.to.length && !input.cc.length && !input.bcc.length) {
      return reply.code(400).send({ error: '请填写收件人' });
    }
    try {
      if (input.sendAt && input.sendAt.getTime() > Date.now() + 30_000) {
        // 整封邮件要存进数据库，给定时邮件单独设一个保守的大小上限
        if (files.reduce((n, f) => n + f.content.length, 0) > 20 * 1024 * 1024) {
          return reply.code(400).send({ error: '定时发送的附件总大小不能超过 20MB' });
        }
        await scheduleMail(req.user, input, files, input.sendAt);
        return { ok: true, scheduled: true };
      }
      await sendMail(req.user, input, files);
    } catch (e: any) {
      return reply.code(502).send({ error: `发送失败：${e.responseText || e.message}` });
    }
    return { ok: true };
  });

  app.post('/api/drafts', async (req, reply) => {
    const { input, files } = await readCompose(req);
    try {
      await saveDraft(req.user, input, files);
    } catch (e: any) {
      return reply.code(502).send({ error: `保存草稿失败：${e.responseText || e.message}` });
    }
    return { ok: true };
  });

  app.get('/api/outbox', (req) =>
    query(
      `SELECT id, account_id, send_at, subject, recipients, status, error FROM outbox
       WHERE user_id = ? ORDER BY send_at`,
      [req.user.id],
    ),
  );

  app.delete<{ Params: { id: string } }>('/api/outbox/:id', async (req, reply) => {
    const res = await exec(`DELETE FROM outbox WHERE id = ? AND user_id = ? AND status <> 'sending'`, [
      req.params.id,
      req.user.id,
    ]);
    emit(req.user.id, { type: 'outbox' });
    return res.affectedRows ? { ok: true } : reply.code(404).send({ error: '这封邮件已经发出或不存在' });
  });

  app.post<{ Params: { id: string } }>('/api/outbox/:id/send', async (req, reply) => {
    const row = await one<{ id: number }>('SELECT id FROM outbox WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return reply.code(404).send({ error: '这封邮件已经发出或不存在' });
    await flushOutbox(row.id);
    const left = await one<{ error: string | null }>('SELECT error FROM outbox WHERE id = ?', [row.id]);
    return left ? reply.code(502).send({ error: `发送失败：${left.error}` }) : { ok: true };
  });
}
