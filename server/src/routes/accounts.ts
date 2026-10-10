import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { decrypt, encrypt, randomToken } from '../crypto.js';
import { exec, one, query } from '../db.js';
import { emit } from '../events.js';
import { startAccount, stopAccount, testConnection, worker } from '../mail/manager.js';
import type { AccountRow } from '../mail/manager.js';
import { exchangeMicrosoftCode, forgetAccessToken, microsoftAuthUrl, microsoftEnabled } from '../mail/oauth.js';

const host = z.string().trim().min(1).max(190);
const port = z.number().int().min(1).max(65535);

const accountBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email(),
  from_name: z.string().trim().max(100).default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#498a97'),
  imap_host: host,
  imap_port: port.default(993),
  imap_secure: z.boolean().default(true),
  smtp_host: host,
  smtp_port: port.default(465),
  smtp_secure: z.boolean().default(true),
  username: z.string().trim().min(1).max(190),
  password: z.string().min(1).max(500),
  signature: z.string().max(5000).default(''),
  notify: z.boolean().default(true),
  save_sent: z.boolean().default(true),
});

const COLUMNS = [
  'name', 'email', 'from_name', 'color', 'imap_host', 'imap_port', 'imap_secure',
  'smtp_host', 'smtp_port', 'smtp_secure', 'username', 'signature', 'notify', 'save_sent',
] as const;
const OAUTH_COOKIE = 'orbox_oauth_state';
const CONN_FIELDS = ['imap_host', 'imap_port', 'imap_secure', 'smtp_host', 'smtp_port', 'smtp_secure', 'username'] as const;

export async function accountRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/accounts', async (req) => {
    const accounts = await query(
      `SELECT id, ${COLUMNS.join(', ')}, auth_type, sync_state, last_error, last_sync_at
       FROM accounts WHERE user_id = ? ORDER BY sort, id`,
      [req.user.id],
    );
    const folders = await query(
      `SELECT f.id, f.account_id, f.path, f.name, f.role, f.total, f.unread
       FROM folders f JOIN accounts a ON a.id = f.account_id WHERE a.user_id = ? ORDER BY f.path`,
      [req.user.id],
    );
    return accounts.map((a) => ({ ...a, folders: folders.filter((f) => f.account_id === a.id) }));
  });

  app.post('/api/accounts', async (req, reply) => {
    const body = accountBody.parse(req.body);
    try {
      await testConnection(body);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    const res = await exec(
      `INSERT INTO accounts (user_id, ${COLUMNS.join(', ')}, password_enc) VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?)`,
      [req.user.id, ...COLUMNS.map((c) => body[c]), encrypt(body.password)],
    );
    await startAccount(res.insertId);
    emit(req.user.id, { type: 'accounts' });
    return { id: res.insertId };
  });

  app.patch<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    const current = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    if (!current) return reply.code(404).send({ error: '邮箱不存在' });
    const body = accountBody.partial().parse(req.body);
    if (current.auth_type === 'oauth') {
      // OAuth 邮箱的服务器和凭据由授权流程决定，这里只允许改展示和行为相关的字段
      const editable = ['name', 'from_name', 'color', 'signature', 'notify', 'save_sent'] as const;
      const next = { ...current, ...Object.fromEntries(editable.filter((k) => k in body).map((k) => [k, body[k]])) };
      await exec(`UPDATE accounts SET ${editable.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
        ...editable.map((c) => next[c]),
        current.id,
      ]);
      await startAccount(current.id);
      emit(req.user.id, { type: 'accounts' });
      return { ok: true };
    }
    // 编辑时密码留空表示沿用已保存的密码
    const password = body.password || decrypt(current.password_enc);
    const next = { ...current, ...body, password };
    const norm = (v: unknown) => (typeof v === 'boolean' ? +v : v);
    const connChanged = !!body.password || CONN_FIELDS.some((f) => f in body && norm(body[f]) !== current[f]);
    if (connChanged) {
      try {
        await testConnection(next);
      } catch (e: any) {
        return reply.code(400).send({ error: e.message });
      }
    }
    await exec(`UPDATE accounts SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')}, password_enc = ? WHERE id = ?`, [
      ...COLUMNS.map((c) => next[c]),
      body.password ? encrypt(body.password) : current.password_enc,
      current.id,
    ]);
    await startAccount(current.id);
    emit(req.user.id, { type: 'accounts' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    const row = await one<{ id: number }>('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    if (!row) return reply.code(404).send({ error: '邮箱不存在' });
    stopAccount(row.id);
    await exec('DELETE FROM accounts WHERE id = ?', [row.id]);
    emit(req.user.id, { type: 'accounts' });
    return { ok: true };
  });

  app.get('/api/oauth/providers', async () => ({ microsoft: microsoftEnabled() }));

  // 浏览器整页跳转到 Microsoft 登录；state 同时存进 cookie，回调时比对以防跨站伪造
  app.get<{ Querystring: { hint?: string } }>('/api/oauth/microsoft/start', async (req, reply) => {
    if (!microsoftEnabled()) return reply.code(400).send({ error: '服务器未配置 Microsoft 登录' });
    const state = randomToken(16);
    reply.setCookie(OAUTH_COOKIE, state, {
      path: '/api/oauth',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicUrl.startsWith('https://'),
      maxAge: 600,
    });
    return reply.redirect(microsoftAuthUrl(state, req.query.hint));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/api/oauth/microsoft/callback',
    async (req, reply) => {
      const done = (params: Record<string, string>) =>
        reply.clearCookie(OAUTH_COOKIE, { path: '/api/oauth' }).redirect(`/settings?${new URLSearchParams(params)}`);
      const q = req.query;
      if (q.error) return done({ oauth_error: q.error_description?.split('\n')[0] || q.error });
      if (!q.code || !q.state || q.state !== req.cookies[OAUTH_COOKIE]) return done({ oauth_error: '授权已过期，请重试' });
      try {
        const grant = await exchangeMicrosoftCode(q.code);
        const conn = {
          imap_host: grant.imapHost, imap_port: 993, imap_secure: 1,
          smtp_host: grant.smtpHost, smtp_port: 587, smtp_secure: 0,
          username: grant.email,
        };
        await testConnection({ ...conn, accessToken: grant.accessToken });
        const refresh = encrypt(grant.refreshToken);
        // 同一个邮箱再次授权视为"重新授权"，只更新凭据
        const existing = await one<{ id: number }>(
          `SELECT id FROM accounts WHERE user_id = ? AND email = ? AND auth_type = 'oauth'`,
          [req.user.id, grant.email],
        );
        let id = existing?.id;
        if (id) {
          forgetAccessToken(id);
          await exec('UPDATE accounts SET oauth_refresh_enc = ?, smtp_host = ?, last_error = NULL WHERE id = ?', [
            refresh, grant.smtpHost, id,
          ]);
        } else {
          const res = await exec(
            `INSERT INTO accounts (user_id, name, email, from_name, color, imap_host, imap_port, imap_secure,
               smtp_host, smtp_port, smtp_secure, username, auth_type, password_enc, oauth_refresh_enc, save_sent)
             VALUES (?, ?, ?, ?, '#7db7f0', ?, ?, ?, ?, ?, ?, ?, 'oauth', '', ?, 0)`,
            [req.user.id, 'Outlook', grant.email, grant.name, conn.imap_host, conn.imap_port, conn.imap_secure,
             conn.smtp_host, conn.smtp_port, conn.smtp_secure, conn.username, refresh],
          );
          id = res.insertId;
        }
        await startAccount(id);
        emit(req.user.id, { type: 'accounts' });
        return done({ oauth: 'ok' });
      } catch (e: any) {
        return done({ oauth_error: e.message });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/accounts/:id/sync', async (req, reply) => {
    const row = await one<{ id: number }>('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    if (!row) return reply.code(404).send({ error: '邮箱不存在' });
    void worker(row.id).requestSync().catch(() => {});
    return { ok: true };
  });
}
