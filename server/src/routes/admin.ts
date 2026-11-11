import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { registerApp } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { providerInput, publicProvider, saveProvider } from '../ai/tasks.js';
import type { ProviderRow } from '../ai/tasks.js';
import { discordInviteUrl } from '../bots/discord.js';
import { botStatus, restartBot } from '../bots/hub.js';
import { APP_VERSION, config, normalizeUrl, saveConfig } from '../config.js';
import { hashPassword } from '../crypto.js';
import { exec, one, query } from '../db.js';
import { logFile, recentLogs } from '../log.js';
import { disconnect } from '../events.js';
import { startAccount, stopAccount } from '../mail/manager.js';
import { microsoftRedirectUri } from '../mail/oauth.js';
import { integration, maskedIntegrations, permsSchema, publicSite, saveIntegration, saveSite, siteConfig, siteSchema } from '../site.js';
import type { Integrations } from '../site.js';

const started = Date.now();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (n: number) => Array.from({ length: n }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

/** 每个平台可以修改的字段 */
const integrationFields: Record<keyof Integrations, z.ZodTypeAny> = {
  telegram: z.object({ token: z.string().max(200), proxy: z.string().max(300) }).partial(),
  feishu: z.object({ appId: z.string().max(100), appSecret: z.string().max(200), domain: z.enum(['feishu', 'lark']) }).partial(),
  discord: z.object({ token: z.string().max(200) }).partial(),
  slack: z.object({ botToken: z.string().max(200), appToken: z.string().max(200) }).partial(),
  microsoft: z.object({ clientId: z.string().max(100), clientSecret: z.string().max(200) }).partial(),
};

/** 在 Slack 里"从清单创建应用"用的清单：Socket Mode、权限、事件、交互一次配好 */
function slackManifest() {
  const name = siteConfig().name;
  return {
    display_information: { name, description: `${name} 邮件与计划通知`, background_color: '#283026' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: { scopes: { bot: ['chat:write', 'im:history', 'im:read', 'im:write', 'files:write'] } },
    settings: {
      event_subscriptions: { bot_events: ['message.im'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

// 飞书"扫码创建应用"是一个需要等待用户操作的过程，状态放在内存里供前端轮询
let feishuJob: { state: 'waiting' | 'done' | 'error'; url?: string; error?: string; abort: AbortController } | null = null;

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/overview', async () => {
    const count = async (sql: string) => Number((await one<{ n: number }>(sql))!.n);
    return {
      version: APP_VERSION,
      node: process.version,
      uptime: Math.round((Date.now() - started) / 1000),
      users: await count('SELECT COUNT(*) AS n FROM users'),
      accounts: await count('SELECT COUNT(*) AS n FROM accounts'),
      messages: await count('SELECT COUNT(*) AS n FROM messages'),
      tasks: await count(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'`),
      dbSize: Number(
        (await one<{ n: number }>(
          'SELECT COALESCE(SUM(data_length + index_length), 0) AS n FROM information_schema.tables WHERE table_schema = DATABASE()',
        ))!.n,
      ),
      bots: botStatus(),
      publicUrl: config.publicUrl,
      /** .env 里没写 PUBLIC_URL 时可以在网页里改 */
      publicUrlEditable: !config.fromEnv.publicUrl,
    };
  });

  /** 修改对外地址（安装向导里填的那个）。写入数据目录的 config.json，立即生效 */
  app.put('/api/admin/public-url', async (req, reply) => {
    if (config.fromEnv.publicUrl) return reply.code(400).send({ error: '对外地址来自 .env 的 PUBLIC_URL，请修改 .env 后重启' });
    const { url } = z.object({ url: z.string().trim().min(1).max(200) }).parse(req.body);
    let next: string;
    try {
      next = normalizeUrl(url);
    } catch {
      return reply.code(400).send({ error: '地址格式不对，应该像 https://box.example.com' });
    }
    try {
      saveConfig({ publicUrl: next });
    } catch (e: any) {
      return reply.code(500).send({ error: `无法写入数据目录：${e.message}` });
    }
    return { publicUrl: config.publicUrl };
  });

  // ---- 站点外观与注册 ----

  app.get('/api/admin/site', async () => siteConfig());

  app.put('/api/admin/site', async (req, reply) => {
    try {
      return await saveSite(siteSchema.partial().parse(req.body));
    } catch (e: any) {
      return reply.code(400).send({ error: e.issues?.[0]?.message || e.message });
    }
  });

  // ---- 运行日志 ----

  app.get<{ Querystring: { level?: string; q?: string; limit?: string } }>('/api/admin/logs', async (req) => ({
    lines: recentLogs({ level: req.query.level, q: req.query.q, limit: Math.min(Number(req.query.limit) || 500, 3000) }),
    file: logFile(),
  }));

  // ---- 集成：聊天平台与 OAuth 凭据 ----

  app.get('/api/admin/integrations', async () => ({
    values: maskedIntegrations(),
    status: botStatus(),
    discordInvite: discordInviteUrl(),
    microsoftRedirect: microsoftRedirectUri(),
    slackManifest: slackManifest(),
  }));

  app.put<{ Params: { platform: string } }>('/api/admin/integrations/:platform', async (req, reply) => {
    const platform = req.params.platform as keyof Integrations;
    const schema = integrationFields[platform];
    if (!schema) return reply.code(404).send({ error: '未知平台' });
    await saveIntegration(platform, schema.parse(req.body) as never);
    if (platform !== 'microsoft') {
      // 新凭据立即生效：重启这个平台的机器人，并把连接结果返回给前端
      try {
        await restartBot(platform);
      } catch (e: any) {
        return reply.code(400).send({ error: `已保存，但连接失败：${e.message}` });
      }
    }
    return { ok: true, status: botStatus(), discordInvite: discordInviteUrl() };
  });

  app.post('/api/admin/feishu/register', async (req) => {
    const { lark } = z.object({ lark: z.boolean().default(false) }).parse(req.body ?? {});
    feishuJob?.abort.abort();
    const abort = new AbortController();
    const job: NonNullable<typeof feishuJob> = { state: 'waiting', abort };
    feishuJob = job;
    const urlReady = new Promise<string>((resolve, reject) => {
      registerApp({
        signal: abort.signal,
        source: 'orbox',
        createOnly: true,
        ...(lark ? { domain: 'accounts.larksuite.com' } : {}),
        appPreset: { name: siteConfig().name, desc: `${siteConfig().name} 邮件与计划通知机器人` },
        addons: {
          scopes: { tenant: ['im:message', 'im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:resource'] },
          events: { items: { tenant: ['im.message.receive_v1'] } },
          callbacks: { items: ['card.action.trigger'] },
        },
        onQRCodeReady: (info) => {
          job.url = info.url;
          resolve(info.url);
        },
      })
        .then(async (r) => {
          await saveIntegration('feishu', { appId: r.client_id, appSecret: r.client_secret, domain: r.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu' });
          job.state = 'done';
          await restartBot('feishu').catch((e) => (job.error = `应用已创建，但还没连上：${e.message}`));
        })
        .catch((e) => {
          job.state = 'error';
          job.error = e.description || e.message;
          reject(e);
        });
    });
    return { url: await urlReady };
  });

  app.get('/api/admin/feishu/register', async () => ({
    state: feishuJob?.state ?? null,
    url: feishuJob?.url,
    error: feishuJob?.error,
    appId: integration('feishu').appId,
  }));

  // ---- 用户 ----

  app.get('/api/admin/users', async () => {
    const rows = await query<any>(
      `SELECT u.id, u.email, u.name, u.is_admin, u.disabled, u.perms, u.created_at, u.last_login_at,
              GREATEST(COALESCE(u.last_seen_at, u.last_login_at), COALESCE(u.last_login_at, u.last_seen_at)) AS last_seen_at,
              (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id) AS accounts,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > UTC_TIMESTAMP()) AS sessions,
              (SELECT COUNT(*) FROM bot_links b WHERE b.user_id = u.id) AS bots,
              (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id) AS tokens
       FROM users u ORDER BY u.id`,
    );
    // perms 为空表示跟随站点默认；effective 给前端直接显示
    return rows.map((r) => ({ ...r, custom: !!r.perms, perms: { ...siteConfig().defaultPerms, ...(r.perms || {}) } }));
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const body = z
      .object({
        isAdmin: z.boolean(),
        disabled: z.boolean(),
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
        /** null 表示恢复为站点默认权限 */
        perms: permsSchema.nullable(),
      })
      .partial()
      .parse(req.body);
    if (id === req.user.id && (body.isAdmin === false || body.disabled)) return reply.code(400).send({ error: '不能取消自己的管理员身份或停用自己' });
    if (!(await one('SELECT id FROM users WHERE id = ?', [id]))) return reply.code(404).send({ error: '用户不存在' });
    if (body.email && (await one('SELECT id FROM users WHERE email = ? AND id <> ?', [body.email, id]))) return reply.code(400).send({ error: '这个邮箱已被其他用户使用' });
    if (body.isAdmin !== undefined) await exec('UPDATE users SET is_admin = ? WHERE id = ?', [+body.isAdmin, id]);
    if (body.disabled !== undefined) {
      await exec('UPDATE users SET disabled = ? WHERE id = ?', [+body.disabled, id]);
      // 停用：下线、断开实时连接、停止同步他的邮箱；重新启用时恢复同步
      const accounts = await query<{ id: number }>('SELECT id FROM accounts WHERE user_id = ?', [id]);
      if (body.disabled) {
        await exec('DELETE FROM sessions WHERE user_id = ?', [id]);
        disconnect(id);
        for (const a of accounts) stopAccount(a.id);
      } else {
        for (const a of accounts) await startAccount(a.id);
      }
    }
    if (body.name) await exec('UPDATE users SET name = ? WHERE id = ?', [body.name, id]);
    if (body.email) await exec('UPDATE users SET email = ? WHERE id = ?', [body.email, id]);
    if (body.perms !== undefined) await exec('UPDATE users SET perms = ? WHERE id = ?', [body.perms ? JSON.stringify(body.perms) : null, id]);
    return { ok: true };
  });

  /** 让这个用户所有已登录的设备下线 */
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/logout', async (req, reply) => {
    if (Number(req.params.id) === req.user.id) return reply.code(400).send({ error: '要退出自己的其他设备，请在 设置 → 账户 里点"退出其他设备"' });
    const res = await exec('DELETE FROM sessions WHERE user_id = ?', [req.params.id]);
    disconnect(Number(req.params.id));
    return { ok: true, count: res.affectedRows };
  });

  /** 生成一个临时密码交给用户，同时让他所有已登录的设备下线 */
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-password', async (req) => {
    const password = `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
    await exec('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), req.params.id]);
    await exec('DELETE FROM sessions WHERE user_id = ?', [req.params.id]);
    disconnect(Number(req.params.id));
    return { password };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return reply.code(400).send({ error: '不能删除自己' });
    for (const a of await query<{ id: number }>('SELECT id FROM accounts WHERE user_id = ?', [id])) stopAccount(a.id);
    await exec('DELETE FROM users WHERE id = ?', [id]);
    disconnect(id);
    return { ok: true };
  });

  // ---- 邀请码 ----

  app.get('/api/admin/invites', () =>
    query(
      `SELECT i.code, i.note, i.used_at, i.expires_at, i.created_at, u.email AS used_by_email
       FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 200`,
    ),
  );

  app.post('/api/admin/invites', async (req) => {
    const body = z.object({ note: z.string().trim().max(100).default(''), days: z.number().int().min(0).max(365).default(7), count: z.number().int().min(1).max(20).default(1) }).parse(req.body ?? {});
    const codes: string[] = [];
    for (let i = 0; i < body.count; i++) {
      const code = randomCode(10);
      await exec(`INSERT INTO invites (code, note, created_by, expires_at) VALUES (?, ?, ?, ${body.days ? 'UTC_TIMESTAMP() + INTERVAL ? DAY' : 'NULL'})`, [
        code,
        body.note,
        req.user.id,
        ...(body.days ? [body.days] : []),
      ]);
      codes.push(code);
    }
    return { codes };
  });

  app.delete<{ Params: { code: string } }>('/api/admin/invites/:code', async (req) => {
    await exec('DELETE FROM invites WHERE code = ?', [req.params.code]);
    return { ok: true };
  });

  // ---- 共享模型服务（提供给所有用户） ----

  app.get('/api/admin/ai-providers', async () => (await query<ProviderRow>('SELECT * FROM ai_providers WHERE user_id IS NULL ORDER BY id')).map(publicProvider));
  app.post('/api/admin/ai-providers', async (req) => ({ id: await saveProvider(null, null, providerInput.parse(req.body)) }));
  app.put<{ Params: { id: string } }>('/api/admin/ai-providers/:id', async (req) => ({ id: await saveProvider(null, Number(req.params.id), providerInput.parse(req.body)) }));
  app.delete<{ Params: { id: string } }>('/api/admin/ai-providers/:id', async (req) => {
    await exec('DELETE FROM ai_providers WHERE id = ? AND user_id IS NULL', [req.params.id]);
    return { ok: true };
  });
}

/** 不需要登录的站点资源：Logo 和 PWA 清单都跟着后台设置走 */
export async function siteRoutes(app: FastifyInstance) {
  app.get('/api/site', async () => publicSite());

  app.get('/api/site/logo', async (_req, reply) => {
    const logo = siteConfig().logo;
    const m = logo.match(/^data:(image\/[a-z+]+);base64,(.*)$/);
    if (!m) return reply.redirect('/logo.svg');
    return reply.header('Content-Type', m[1]).header('Cache-Control', 'public, max-age=300').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").send(Buffer.from(m[2], 'base64'));
  });

  app.get('/api/site/manifest.webmanifest', async (_req, reply) => {
    const s = siteConfig();
    const icons = s.logo
      ? [{ src: '/api/site/logo', sizes: 'any', type: s.logo.slice(5, s.logo.indexOf(';')) }]
      : [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ];
    return reply.type('application/manifest+json').send({
      name: s.name,
      short_name: s.name,
      description: s.subtitle,
      lang: 'zh-CN',
      start_url: '/mail',
      scope: '/',
      display: 'standalone',
      background_color: '#fafbf8',
      theme_color: '#fafbf8',
      icons,
      shortcuts: [
        { name: '写邮件', url: '/mail?compose=1' },
        { name: '计划', url: '/planner' },
      ],
    });
  });
}
