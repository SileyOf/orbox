import { randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import mysql from 'mysql2/promise';
import { ZodError, z } from 'zod';
import { startSession } from './auth.js';
import { APP_VERSION, clearSavedConfig, config, dataDirPersistent, isConfigured, normalizeUrl, saveConfig } from './config.js';
import { canDecrypt, hashPassword, randomToken } from './crypto.js';
import { closePool, dbHint, exec, one } from './db.js';
import { migrate } from './migrate.js';
import { loadSite, publicSite, saveSite, siteConfig } from './site.js';

// 首次安装向导的服务端。只在"还没装好"的时候运行：
//   1. 没有数据库配置（.env 和数据目录里都没有）→ 填数据库、站点信息、管理员账号；
//   2. 数据库已通过 .env 配置，但里面还没有任何用户 → 只填站点信息和管理员账号。
// 装好后关闭这个临时服务，由正常的应用接管同一个端口。
//
// 未安装的实例谁先打开谁就能配置，所以所有操作都要带"安装码"：启动时打印在日志里，
// 只有能看到服务器日志的人（也就是部署的人）才拿得到。它同时防止别人借"测试数据库连接"探测内网。

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

const dbInput = z.object({
  host: z.string().trim().min(1, '请填写数据库地址').max(190),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  user: z.string().trim().min(1, '请填写数据库用户名').max(64),
  password: z.string().max(200).default(''),
  database: z.string().trim().regex(/^[A-Za-z0-9_]{1,64}$/, '库名只能包含字母、数字和下划线'),
});
type DbInput = z.infer<typeof dbInput>;

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone').concat('UTC'));
const siteInput = z.object({
  name: z.string().trim().min(1, '请填写站点名称').max(40),
  publicUrl: z.string().trim().min(1, '请填写访问地址').max(200),
  timezone: z.string().refine((tz) => TIMEZONES.has(tz), '未知时区'),
  registration: z.enum(['open', 'invite', 'closed']),
});
const adminInput = z.object({
  name: z.string().trim().max(100).default(''),
  email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
  password: z.string().min(8, '密码至少 8 位').max(200),
});

interface DbReport {
  version: string;
  /** 库是这次新建的 */
  created: boolean;
  /** 库里已有 Orbox 的数据（有用户） */
  users: number;
  /** 已有数据里的一段密文，用来核对 APP_SECRET */
  sample: string | null;
}

class SetupError extends Error {
  statusCode = 400;
}

/** 连接并检查数据库：版本、库是否存在（不存在就尝试创建）、里面有没有已有数据 */
async function inspectDatabase(db: DbInput): Promise<DbReport> {
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection({ host: db.host, port: db.port, user: db.user, password: db.password, connectTimeout: 12_000, timezone: 'Z' });
  } catch (e: any) {
    throw new SetupError(`连不上数据库（${e.code || e.message}）。${dbHint(e)}`);
  }
  try {
    const [[v]] = (await conn.query('SELECT VERSION() AS v')) as unknown as [{ v: string }[]];
    const version = String(v.v);
    if (/mariadb/i.test(version)) throw new SetupError(`这是 MariaDB（${version}）。Orbox 的全文搜索依赖 MySQL 8 的 ngram 分词器，请换成 MySQL 8.0 或更高版本`);
    if (Number(version.split('.')[0]) < 8) throw new SetupError(`MySQL 版本是 ${version}，需要 8.0 或更高`);

    const [found] = (await conn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db.database])) as unknown as [unknown[]];
    let created = false;
    if (!found.length) {
      try {
        // 库名已用正则限定为字母数字下划线
        await conn.query(`CREATE DATABASE \`${db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        created = true;
      } catch (e: any) {
        throw new SetupError(`数据库「${db.database}」不存在，这个账号也没有权限创建（${e.code || e.message}）。请先在 MySQL 里建好库并授权给这个账号`);
      }
    }
    try {
      await conn.query(`USE \`${db.database}\``);
    } catch (e: any) {
      throw new SetupError(`这个账号没有访问数据库「${db.database}」的权限（${e.code || e.message}）`);
    }
    const [tables] = (await conn.query("SHOW TABLES LIKE 'users'")) as unknown as [unknown[]];
    let users = 0;
    let sample: string | null = null;
    if (tables.length) {
      const [[c]] = (await conn.query('SELECT COUNT(*) AS n FROM users')) as unknown as [{ n: number }[]];
      users = Number(c.n);
      const [rows] = (await conn
        .query("SELECT password_enc AS s FROM accounts WHERE password_enc LIKE '%.%.%' LIMIT 1")
        .catch(() => [[]])) as unknown as [{ s: string }[]];
      sample = rows[0]?.s ?? null;
    } else if (!created) {
      // 库已存在但不是 Orbox 的：确认至少能建表
      try {
        await conn.query('CREATE TABLE _orbox_probe (id INT) ENGINE=InnoDB');
        await conn.query('DROP TABLE _orbox_probe');
      } catch (e: any) {
        throw new SetupError(`这个账号在「${db.database}」里没有建表权限（${e.code || e.message}），请授予 ALL PRIVILEGES`);
      }
    }
    return { version, created, users, sample };
  } catch (e: any) {
    if (e instanceof SetupError) throw e;
    throw new SetupError(`检查数据库时出错（${e.code || e.message}）`);
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * 运行安装向导，直到安装完成才返回。
 * @param webDist 前端构建产物目录（开发时由 Vite 代理，可以不存在）
 */
export async function runSetup(webDist: string): Promise<void> {
  const needDatabase = !isConfigured();
  const code = normalizeCode(process.env.SETUP_CODE || '') || Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
  const banner = () =>
    console.log(
      `[setup] 首次安装：请在浏览器里打开 Orbox 完成配置${needDatabase ? '（数据库、站点、管理员账号）' : '（站点、管理员账号）'}。\n[setup] 安装码：${shown}`,
    );

  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 64 * 1024, trustProxy: true, forceCloseConnections: true });
  await app.register(cookie);
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues[0]?.message || '参数不正确' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    console.error('[setup]', err?.stack || err);
    return reply.code(500).send({ error: err.message || '服务器内部错误' });
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer');
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });

  // 安装码猜错限流：每个 IP 10 分钟 10 次，全局 10 分钟 200 次
  const fails = new Map<string, { n: number; until: number }>();
  const tooMany = (key: string, max: number) => {
    const f = fails.get(key);
    return !!f && f.until > Date.now() && f.n >= max;
  };
  const fail = (key: string) => {
    const f = fails.get(key);
    if (!f || f.until < Date.now()) fails.set(key, { n: 1, until: Date.now() + 600_000 });
    else f.n++;
  };
  function checkCode(req: FastifyRequest) {
    if (tooMany(`i:${req.ip}`, 10) || tooMany('all', 200)) throw Object.assign(new Error('尝试次数太多，请 10 分钟后再试'), { statusCode: 429 });
    const given = Buffer.from(normalizeCode(String((req.body as { code?: unknown } | null)?.code ?? '')).padEnd(code.length, ' ').slice(0, code.length));
    if (!timingSafeEqual(given, Buffer.from(code))) {
      fail(`i:${req.ip}`);
      fail('all');
      throw Object.assign(new Error('安装码不对。请在服务器上执行 docker compose logs，找到"安装码"那一行'), { statusCode: 403 });
    }
  }

  let finishing = false;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));

  app.get('/api/setup/status', async () => ({
    setup: true,
    version: APP_VERSION,
    needDatabase,
    /** Docker 里数据目录有没有挂载卷；null 表示不是 Docker */
    persistent: dataDirPersistent(),
  }));

  // 安装码正确后才给出预填值（.env 里已有的数据库地址、用户名等不对未验证的访客公开）
  app.post('/api/setup/code', async (req) => {
    checkCode(req);
    return {
      ok: true,
      defaults: {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        database: config.db.database || 'orbox',
        publicUrl: config.fromEnv.publicUrl ? config.publicUrl : '',
        name: siteConfig().name,
      },
    };
  });

  // 登录页启动时会先请求这个接口；这里告诉它"还没安装"，前端据此显示安装向导
  app.get('/api/auth/status', async () => ({ setup: true, allowRegistration: false, inviteRequired: false, version: APP_VERSION, site: publicSite() }));

  app.post('/api/setup/database', async (req) => {
    checkCode(req);
    if (!needDatabase) throw new SetupError('数据库已经通过环境变量配置');
    const { sample, ...report } = await inspectDatabase(dbInput.parse((req.body as { database?: unknown }).database));
    return { ...report, needSecret: report.users > 0 };
  });

  app.post('/api/setup/finish', async (req, reply) => {
    checkCode(req);
    if (finishing) throw new SetupError('正在安装，请稍候');
    const body = z
      .object({
        database: dbInput.optional(),
        /** 接管已有数据的库时必须填原来的 APP_SECRET */
        appSecret: z.string().trim().max(200).optional(),
        site: siteInput.optional(),
        admin: adminInput.optional(),
      })
      .parse(req.body);

    let existing = false;
    let wroteConfig = false;
    finishing = true;
    try {
      if (needDatabase) {
        if (!body.database) throw new SetupError('请填写数据库配置');
        const report = await inspectDatabase(body.database);
        existing = report.users > 0;
        let secret = config.appSecret || body.appSecret || '';
        if (existing) {
          if (!secret) throw new SetupError('这个数据库里已有 Orbox 的数据，请填写原来的 APP_SECRET（否则已保存的邮箱密码无法解密）');
          if (report.sample && !canDecrypt(report.sample, secret)) throw new SetupError('APP_SECRET 和这个数据库里的数据对不上，请填写原来部署时用的那个');
        } else if (secret && secret.length < 16) {
          throw new SetupError('APP_SECRET 至少 16 位，留空会自动生成');
        }
        secret ||= randomToken(32);
        try {
          saveConfig({ db: body.database, appSecret: secret });
          wroteConfig = true;
        } catch (e: any) {
          throw new SetupError(`无法写入数据目录（${e.code || e.message}）。Docker 部署请确认给 /app/data 挂载了卷`);
        }
      }
      await migrate();
      await loadSite();
      existing = (await one<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n > 0;

      if (!existing) {
        if (!body.site || !body.admin) throw new SetupError('请填写站点信息和管理员账号');
        let publicUrl: string | undefined;
        if (!config.fromEnv.publicUrl) {
          try {
            publicUrl = normalizeUrl(body.site.publicUrl);
          } catch {
            throw new SetupError('访问地址格式不对，应该像 https://box.example.com');
          }
          saveConfig({ publicUrl });
          wroteConfig = true;
        }
        await saveSite({ name: body.site.name, registration: body.site.registration, defaultTimezone: body.site.timezone });
        const site = siteConfig();
        const res = await exec('INSERT INTO users (email, name, password_hash, is_admin, timezone, settings) VALUES (?, ?, ?, 1, ?, ?)', [
          body.admin.email,
          body.admin.name || body.admin.email.split('@')[0],
          await hashPassword(body.admin.password),
          body.site.timezone,
          JSON.stringify({ theme: site.theme, accent: site.accent, followSite: true }),
        ]);
        await exec('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [res.insertId]);
        // 直接登录，装完不用再输一遍密码
        await startSession(req, reply, res.insertId);
        console.log(`[setup] 安装完成，管理员 ${body.admin.email}`);
      } else {
        console.log('[setup] 已连接到现有数据，沿用其中的用户和设置');
      }
    } catch (e) {
      finishing = false;
      // 配置写了一半就失败（例如迁移出错）：撤销，回到未安装状态，避免下次启动卡在坏配置上
      if (wroteConfig && needDatabase) {
        await closePool();
        clearSavedConfig();
      }
      throw e;
    }
    // 先把响应发出去，再关闭安装服务、交给正常的应用
    setTimeout(done, 300);
    return { ok: true, existing };
  });

  // 其他接口一律告诉前端"还没安装"，前端据此显示安装向导
  const notInstalled = { error: 'Orbox 还没有完成安装', setup: true };
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || req.url.startsWith('/mcp') ? reply.code(503).send(notInstalled) : reply.header('Cache-Control', 'no-cache').sendFile('index.html'),
    );
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(503).send(notInstalled));
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  banner();
  // 日志滚动后还能找到安装码
  const reminder = setInterval(banner, 10 * 60_000);
  reminder.unref();

  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await finished;
  clearInterval(reminder);
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await app.close();
}
