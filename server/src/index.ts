import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { authRoutes } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';
import { setNewMailHandler, startAllAccounts, stopAllAccounts } from './mail/manager.js';
import { migrate } from './migrate.js';
import { dispatchNewMail } from './notify/dispatch.js';
import { startBots, stopBots } from './bots/hub.js';
import { accountRoutes } from './routes/accounts.js';
import { mailRoutes } from './routes/mail.js';
import { taskRoutes } from './routes/tasks.js';
import { aiRoutes } from './routes/ai.js';
import { mcpRoutes } from './routes/mcp.js';
import { publicRoutes } from './routes/public.js';
import { startScheduler } from './tasks/scheduler.js';

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 10 * 1024 * 1024, trustProxy: true, forceCloseConnections: true });

app.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: err.issues[0]?.message || '参数不正确' });
  }
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
  app.log.error(err);
  return reply.code(500).send({ error: err.message || '服务器内部错误' });
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 20 } });
await app.register(authRoutes);
await app.register(accountRoutes);
await app.register(mailRoutes);
await app.register(taskRoutes);
await app.register(aiRoutes);
await app.register(mcpRoutes);
await app.register(publicRoutes);

// 生产环境由同一个进程托管前端构建产物
const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') || req.url.startsWith('/mcp') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  );
}

// 数据库连不上时给出一行能看懂的提示并持续重试，而不是带着堆栈反复崩溃重启
for (;;) {
  try {
    await pool.query('SELECT 1');
    break;
  } catch (e: any) {
    const { host, port } = config.db;
    const hint =
      e.code === 'ETIMEDOUT'
        ? '连接超时：多半是数据库所在机器的防火墙/安全组没有放行本机，或 MySQL 只监听了 127.0.0.1'
        : e.code === 'ECONNREFUSED'
          ? '连接被拒绝：地址或端口不对。注意容器里的 127.0.0.1 是容器自己，同机数据库请用 host.docker.internal'
          : e.code === 'ER_ACCESS_DENIED_ERROR' || e.code === 'ER_DBACCESS_DENIED_ERROR'
            ? '账号、密码或授权的来源主机不对'
            : e.code === 'ER_BAD_DB_ERROR'
              ? '数据库不存在，请先建库'
              : '';
    console.error(`[db] 无法连接 ${host}:${port}（${e.code || e.message}）${hint ? '。' + hint : ''}，5s 后重试`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
await migrate();
void startBots();
setNewMailHandler(dispatchNewMail);
await startAllAccounts();
const stopScheduler = startScheduler();

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[orbox] listening on :${config.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopScheduler();
    stopAllAccounts();
    await stopBots();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
