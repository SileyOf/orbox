import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { askAssistant, resetSession } from '../ai/agent.js';
import { draftReply, extractTodos, summarize, translate } from '../ai/features.js';
import { AiError, complete, listModels } from '../ai/provider.js';
import { TASKS, TASK_NAMES, providerInput, providerTarget, providersOf, publicProvider, saveProvider, taskSettingSchema, taskSettings } from '../ai/tasks.js';
import { siteConfig } from '../site.js';
import { takePending } from '../ai/tools.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../crypto.js';
import { exec, query } from '../db.js';
import { sendMail } from '../mail/send.js';

type IdParams = { Params: { id: string } };

export async function aiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // AI 的错误（没配置、Key 不对、模型拒绝……）都是用户能处理的，原样返回 400
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AiError) return reply.code(400).send({ error: err.message });
    if (err?.issues) return reply.code(400).send({ error: err.issues[0]?.message || '参数不正确' });
    console.error('[ai]', err);
    return reply.code(500).send({ error: err.message || '服务器内部错误' });
  });

  /** AI 设置页需要的全部信息：模型服务、任务分配、每项任务的说明 */
  app.get('/api/ai', async (req) => {
    const providers = await providersOf(req.user);
    const tasks = await taskSettings(req.user);
    return {
      providers: providers.map(publicProvider),
      tasks,
      meta: TASKS,
      // 前端据此决定显示哪些 AI 按钮
      active: Object.fromEntries(TASK_NAMES.map((t) => [t, tasks[t].enabled && !!tasks[t].providerId])),
      shareAi: siteConfig().shareAi,
    };
  });

  app.post('/api/ai/providers', async (req) => ({ id: await saveProvider(req.user.id, null, providerInput.parse(req.body)) }));

  app.put<IdParams>('/api/ai/providers/:id', async (req) => ({ id: await saveProvider(req.user.id, Number(req.params.id), providerInput.parse(req.body)) }));

  app.delete<IdParams>('/api/ai/providers/:id', async (req) => {
    await exec('DELETE FROM ai_providers WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    return { ok: true };
  });

  /** 测试一个模型服务：可以是还没保存的（带 apiKey），也可以是已保存的（带 id，Key 用保存的） */
  app.post('/api/ai/providers/test', async (req) => {
    const body = providerInput.partial({ name: true }).extend({ id: z.number().int().optional() }).parse(req.body);
    let target;
    if (body.id && !body.apiKey) {
      const p = (await providersOf(req.user)).find((x) => x.id === body.id);
      if (!p) throw new AiError('模型服务不存在');
      target = { ...providerTarget(p, req.user.id, body.defaultModel), kind: body.kind, baseUrl: body.baseUrl };
    } else {
      target = { kind: body.kind, baseUrl: body.baseUrl, apiKey: body.apiKey || 'none', model: body.defaultModel, userId: req.user.id, task: 'test' };
    }
    const started = Date.now();
    const reply = await complete(target, { system: '只回答"好"。', prompt: '测试连接，请回答：好', maxTokens: 300 });
    return { ok: true, reply: reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, 40), ms: Date.now() - started };
  });

  /** 拉取服务上的模型列表并缓存，供下拉选择 */
  app.post<IdParams>('/api/ai/providers/:id/models', async (req) => {
    const p = (await providersOf(req.user)).find((x) => x.id === Number(req.params.id));
    if (!p) throw new AiError('模型服务不存在');
    const models = await listModels(providerTarget(p, req.user.id));
    if (p.user_id !== null || req.user.isAdmin) await exec('UPDATE ai_providers SET models = ? WHERE id = ?', [JSON.stringify(models.slice(0, 500)), p.id]);
    return { models };
  });

  app.put('/api/ai/tasks', async (req) => {
    const body = z.object({ tasks: z.record(z.string(), taskSettingSchema) }).parse(req.body);
    const providers = await providersOf(req.user);
    const tasks = Object.fromEntries(
      Object.entries(body.tasks)
        .filter(([t]) => (TASK_NAMES as string[]).includes(t))
        .map(([t, v]) => [t, { ...v, providerId: providers.some((p) => p.id === v.providerId) ? v.providerId : null }]),
    );
    await exec('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify({ ...req.user.settings, aiTasks: tasks }), req.user.id]);
    return { ok: true };
  });

  /** 最近一段时间每项任务、每个模型的调用次数和 token 用量 */
  app.get('/api/ai/usage', async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    return query(
      `SELECT task, model, SUM(calls) AS calls, SUM(failures) AS failures, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
       FROM ai_usage WHERE user_id = ? AND day >= UTC_DATE() - INTERVAL ? DAY GROUP BY task, model ORDER BY calls DESC`,
      [req.user.id, days],
    );
  });

  app.post<IdParams>('/api/messages/:id/ai/summary', async (req) => {
    const { fresh } = z.object({ fresh: z.boolean().default(false) }).parse(req.body ?? {});
    return { text: await summarize(req.user, Number(req.params.id), fresh) };
  });

  app.post<IdParams>('/api/messages/:id/ai/translate', async (req) => {
    const { lang } = z.object({ lang: z.string().trim().min(2).max(30).optional() }).parse(req.body ?? {});
    return { text: await translate(req.user, Number(req.params.id), lang), lang: lang || req.user.settings.translateTo };
  });

  app.post<IdParams>('/api/messages/:id/ai/todos', async (req) => ({ items: await extractTodos(req.user, Number(req.params.id)) }));

  app.post<IdParams>('/api/messages/:id/ai/reply', async (req) => {
    const { instruction } = z.object({ instruction: z.string().max(2000).default('') }).parse(req.body ?? {});
    return { text: await draftReply(req.user, Number(req.params.id), instruction) };
  });

  app.post('/api/ai/chat', async (req) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    return askAssistant(req.user, '网页', text);
  });

  app.post('/api/ai/reset', async (req) => {
    resetSession(req.user.id, '网页');
    return { ok: true };
  });

  app.post<{ Params: { id: string; verb: string } }>('/api/ai/pending/:id/:verb', async (req, reply) => {
    const p = takePending(req.user.id, req.params.id);
    if (!p) return reply.code(404).send({ error: '这封草稿已经处理过或已过期' });
    if (req.params.verb === 'send') await sendMail(req.user, p.input, []);
    return { ok: true };
  });

  // ---- 给外部 AI（Hermes、Claude Desktop 等）用的 MCP 访问令牌 ----

  app.get('/api/tokens', (req) =>
    query('SELECT id, name, allow_send, last_used_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC', [req.user.id]),
  );

  app.post('/api/tokens', async (req) => {
    const body = z.object({ name: z.string().trim().min(1, '请填写名称').max(100), allowSend: z.boolean().default(false) }).parse(req.body);
    const token = `orbox_${randomToken(24)}`;
    await exec('INSERT INTO api_tokens (user_id, name, token_hash, allow_send) VALUES (?, ?, ?, ?)', [
      req.user.id,
      body.name,
      sha256(token),
      +body.allowSend,
    ]);
    // 明文令牌只在创建时返回这一次
    return { token, mcpUrl: `${config.publicUrl}/mcp` };
  });

  app.delete<IdParams>('/api/tokens/:id', async (req) => {
    await exec('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    return { ok: true };
  });
}
