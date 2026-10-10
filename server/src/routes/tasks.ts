import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { randomToken } from '../crypto.js';
import { exec, one } from '../db.js';
import { sendChannel } from '../notify/channels.js';
import { botUsername, sendDigest, sendTest, telegramEnabled } from '../notify/telegram.js';
import { parseQuickTask } from '../tasks/parse.js';
import {
  completeTask, createTask, deleteTask, listTasks, reopenTask, repeatRule, skipTask, snoozeTask, updateTask,
} from '../tasks/service.js';

const taskBody = z.object({
  title: z.string().trim().min(1, '请填写事项').max(500),
  notes: z.string().max(5000).nullish(),
  dueAt: z.coerce.date().nullish(),
  remindBefore: z.number().int().min(0).max(10080).optional(),
  repeat: repeatRule.nullish(),
  priority: z.number().int().min(0).max(2).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  nagInterval: z.number().int().min(0).max(1440).optional(),
});

type IdParams = { Params: { id: string } };

export async function taskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/tasks', async (req) => {
    const { status } = z.object({ status: z.enum(['open', 'done']).default('open') }).parse(req.query);
    return listTasks(req.user.id, status);
  });

  app.post('/api/tasks', async (req) => {
    const body = taskBody.parse(req.body);
    return createTask(req.user.id, req.user.timezone, {
      ...body,
      nagInterval: body.nagInterval ?? req.user.settings.nagInterval,
    });
  });

  /** 一句话快速添加，与 Telegram 里直接发消息是同一套解析 */
  app.post('/api/tasks/quick', async (req) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(500) }).parse(req.body);
    const quick = parseQuickTask(text, req.user.timezone);
    return createTask(req.user.id, req.user.timezone, { ...quick, nagInterval: req.user.settings.nagInterval });
  });

  app.post<IdParams>('/api/messages/:id/task', async (req, reply) => {
    const m = await one<{ subject: string; message_id: string | null }>(
      'SELECT subject, message_id FROM messages WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id],
    );
    if (!m) return reply.code(404).send({ error: '邮件不存在' });
    const body = taskBody.partial().parse(req.body ?? {});
    return createTask(req.user.id, req.user.timezone, {
      ...body,
      title: body.title || `处理邮件：${m.subject || '(无主题)'}`.slice(0, 500),
      nagInterval: body.nagInterval ?? req.user.settings.nagInterval,
      mailRef: m.message_id,
      mailSubject: m.subject,
    });
  });

  app.patch<IdParams>('/api/tasks/:id', async (req, reply) => {
    const task = await updateTask(req.user.id, req.user.timezone, Number(req.params.id), taskBody.partial().parse(req.body));
    return task ?? reply.code(404).send({ error: '任务不存在' });
  });

  app.delete<IdParams>('/api/tasks/:id', async (req, reply) => {
    const ok = await deleteTask(req.user.id, Number(req.params.id));
    return ok ? { ok } : reply.code(404).send({ error: '任务不存在' });
  });

  app.post<IdParams>('/api/tasks/:id/:action', async (req, reply) => {
    const id = Number(req.params.id);
    const { id: userId, timezone } = req.user;
    const action = (req.params as any).action as string;
    let task;
    if (action === 'complete') task = await completeTask(userId, timezone, id);
    else if (action === 'skip') task = await skipTask(userId, timezone, id);
    else if (action === 'reopen') task = await reopenTask(userId, id);
    else if (action === 'snooze') {
      const { minutes } = z.object({ minutes: z.number().int().min(1).max(43200) }).parse(req.body);
      task = await snoozeTask(userId, id, new Date(Date.now() + minutes * 60_000));
    } else return reply.code(404).send({ error: '未知操作' });
    return task ?? reply.code(404).send({ error: '任务不存在' });
  });

  app.get('/api/telegram', async (req) => {
    const link = await one<{ username: string }>('SELECT username FROM tg_links WHERE user_id = ?', [req.user.id]);
    return { enabled: telegramEnabled(), bot: botUsername(), linked: link ?? null };
  });

  app.post('/api/telegram/link', async (req, reply) => {
    if (!telegramEnabled()) return reply.code(400).send({ error: '服务器未配置 Telegram 机器人' });
    const code = randomToken(16);
    await exec('DELETE FROM tg_link_codes WHERE user_id = ? OR expires_at < UTC_TIMESTAMP()', [req.user.id]);
    await exec('INSERT INTO tg_link_codes (code, user_id, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 15 MINUTE)', [
      code,
      req.user.id,
    ]);
    return { url: `https://t.me/${botUsername()}?start=${code}` };
  });

  app.delete('/api/telegram', async (req) => {
    await exec('DELETE FROM tg_links WHERE user_id = ?', [req.user.id]);
    return { ok: true };
  });

  app.post('/api/telegram/test', async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(['ping', 'digest']).default('ping') }).parse(req.body ?? {});
    const sent = kind === 'digest' ? await sendDigest(req.user) : await sendTest(req.user.id);
    return sent ? { ok: true } : reply.code(400).send({ error: '尚未绑定 Telegram' });
  });

  // 保存前先试发一条，地址填错能立刻发现
  app.post('/api/notify/test', async (req, reply) => {
    const body = z
      .object({ channel: z.enum(['bark', 'ntfy', 'webhook']), target: z.string().trim().url().max(500) })
      .parse(req.body);
    try {
      await sendChannel(body.channel, body.target, { title: 'Orbox 测试通知', body: '看到这条说明通道已连通。' });
    } catch (e: any) {
      return reply.code(400).send({ error: `发送失败：${e.message}` });
    }
    return { ok: true };
  });
}
