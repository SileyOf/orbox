import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getUser, publicUser, requireUser } from '../auth.js';
import { askAssistant, resetSession } from '../ai/agent.js';
import { draftReply, extractTodos, summarize, translate } from '../ai/features.js';
import { AiError, DEFAULT_MODEL, aiConfigOf, complete } from '../ai/provider.js';
import type { AiConfig } from '../ai/provider.js';
import { takePending } from '../ai/tools.js';
import { config } from '../config.js';
import { encrypt, randomToken, sha256 } from '../crypto.js';
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

  app.get('/api/ai/config', async (req) => ({
    ...publicUser(req.user).settings.ai,
    defaults: DEFAULT_MODEL,
    // 管理员开放了服务器默认模型时，用户不填也能用
    shared: config.ai.shared && !!config.ai.apiKey ? { provider: config.ai.provider, model: config.ai.model } : null,
    active: !!aiConfigOf(req.user),
  }));

  app.put('/api/ai/config', async (req) => {
    const body = z
      .object({
        provider: z.enum(['anthropic', 'openai']),
        baseUrl: z.string().trim().max(300).refine((v) => v === '' || /^https?:\/\//.test(v), '接口地址必须以 http:// 或 https:// 开头'),
        model: z.string().trim().max(100),
        fastModel: z.string().trim().max(100).default(''),
        /** 留空表示沿用已保存的 Key */
        apiKey: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const prev = req.user.settings.ai;
    const apiKeyEnc = body.apiKey ? encrypt(body.apiKey) : prev?.provider === body.provider ? prev.apiKeyEnc : '';
    if (!apiKeyEnc) throw new AiError('请填写 API Key');
    const ai = { provider: body.provider, baseUrl: body.baseUrl, model: body.model, fastModel: body.fastModel, apiKeyEnc };
    await exec('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify({ ...req.user.settings, ai }), req.user.id]);
    return publicUser((await getUser(req.user.id))!);
  });

  app.delete('/api/ai/config', async (req) => {
    const { ai: _drop, ...rest } = req.user.settings;
    await exec('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(rest), req.user.id]);
    return publicUser((await getUser(req.user.id))!);
  });

  /** 用一个极短的请求验证模型配置能不能用 */
  app.post('/api/ai/test', async (req) => {
    const cfg: AiConfig | null = aiConfigOf(req.user);
    if (!cfg) throw new AiError('还没有配置 AI 模型');
    const started = Date.now();
    const text = await complete(cfg, { system: '只回答"好"。', prompt: '测试连接，请回答：好', maxTokens: 200 });
    return { ok: true, model: cfg.model, reply: text.slice(0, 50), ms: Date.now() - started };
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
