import Anthropic from '@anthropic-ai/sdk';
import { exec } from '../db.js';

// 模型调用层：Claude 走官方 SDK，其余（OpenAI、DeepSeek、通义、Kimi、MiMo、OpenRouter、Ollama……）
// 走 OpenAI 兼容的 /chat/completions。上层通过 Target 指明"用哪个服务的哪个模型做哪项任务"。

export type ProviderKind = 'anthropic' | 'openai';

export interface Target {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 用于记录用量 */
  userId: number;
  task: string;
}

export class AiError extends Error {}

type Effort = 'low' | 'medium' | 'high';

// ---------------- 用量记录 ----------------

async function record(t: Target, usage: { input?: number; output?: number } | null, failed = false) {
  await exec(
    `INSERT INTO ai_usage (user_id, day, task, model, calls, failures, input_tokens, output_tokens)
     VALUES (?, UTC_DATE(), ?, ?, 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE calls = calls + 1, failures = failures + VALUES(failures),
       input_tokens = input_tokens + VALUES(input_tokens), output_tokens = output_tokens + VALUES(output_tokens)`,
    [t.userId, t.task, t.model.slice(0, 100), +failed, usage?.input || 0, usage?.output || 0],
  ).catch(() => {});
}

// ---------------- Claude ----------------

const clients = new Map<string, Anthropic>();
function anthropic(t: Pick<Target, 'baseUrl' | 'apiKey'>): Anthropic {
  const key = `${t.baseUrl}|${t.apiKey}`;
  let c = clients.get(key);
  if (!c) clients.set(key, (c = new Anthropic({ apiKey: t.apiKey, baseURL: t.baseUrl || undefined, maxRetries: 2, timeout: 120_000 })));
  return c;
}

/** 4.6 之后的型号支持 effort；更老的型号或代理上的其他模型不传，避免 400 */
const supportsEffort = (model: string) =>
  /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model) || /^claude-(opus-4-[5-8]|sonnet-4-6)/.test(model);

/** 直连官方 API 且模型支持时，开启服务器端拒答兜底：被安全策略拒绝时自动换模型重试 */
const supportsFallback = (t: Target) => !t.baseUrl && /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(t.model);

function claudeError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new AiError('API Key 无效');
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError('这个 Key 没有调用该模型的权限');
  if (e instanceof Anthropic.NotFoundError) return new AiError('模型不存在，请检查模型名');
  if (e instanceof Anthropic.RateLimitError) return new AiError('请求太频繁或额度用完，请稍后再试');
  if (e instanceof Anthropic.APIError) return new AiError(`模型服务错误（${e.status}）：${e.message}`);
  return new AiError(`无法连接模型服务：${(e as Error).message}`);
}

async function claude(
  t: Target,
  params: { system: string; messages: Anthropic.Beta.BetaMessageParam[]; tools?: Anthropic.Beta.BetaTool[]; maxTokens: number; effort: Effort },
): Promise<Anthropic.Beta.BetaMessage> {
  try {
    const res = await anthropic(t).beta.messages.create({
      model: t.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
      ...(params.tools?.length ? { tools: params.tools } : {}),
      ...(supportsEffort(t.model) ? { output_config: { effort: params.effort } } : {}),
      ...(supportsFallback(t) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    await record(t, { input: res.usage.input_tokens, output: res.usage.output_tokens });
    if (res.stop_reason === 'refusal') throw new AiError('模型拒绝处理这个请求');
    return res;
  } catch (e) {
    if (!(e instanceof AiError)) await record(t, null, true);
    throw claudeError(e);
  }
}

const claudeText = (res: Anthropic.Beta.BetaMessage) =>
  res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

// ---------------- OpenAI 兼容 ----------------

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** 部分服务（DeepSeek、MiMo 等推理模型）会额外返回思考内容，多轮调用时需要原样带回 */
  reasoning_content?: string;
}

const base = (t: Pick<Target, 'baseUrl'>) => (t.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
/** 不支持 response_format 的服务记下来，之后不再尝试 */
const noJsonMode = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openai(t: Target, body: { messages: OpenAIMessage[]; tools?: unknown[]; maxTokens: number; json?: boolean }): Promise<OpenAIMessage> {
  const json = body.json && !noJsonMode.has(base(t));
  // 新一代推理模型只认 max_completion_tokens
  const limitKey = /^(o\d|gpt-5)/.test(t.model) ? 'max_completion_tokens' : 'max_tokens';
  const payload = {
    model: t.model,
    messages: body.messages,
    [limitKey]: body.maxTokens,
    ...(body.tools?.length ? { tools: body.tools } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base(t)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}` },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      if (attempt < 2) {
        await sleep(1000 * 3 ** attempt);
        continue;
      }
      await record(t, null, true);
      throw new AiError(`无法连接模型服务：${(e as Error).message}`);
    }
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) {
      const msg = data.choices?.[0]?.message;
      await record(t, { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens });
      if (!msg) throw new AiError('模型服务没有返回内容');
      return msg;
    }
    const detail = data.error?.message || JSON.stringify(data).slice(0, 200);
    // 服务不支持 JSON 模式时去掉这个参数重试一次
    if (res.status === 400 && json && /response_format|json/i.test(detail)) {
      noJsonMode.add(base(t));
      return openai(t, { ...body, json: false });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(1000 * 3 ** attempt);
      continue;
    }
    await record(t, null, true);
    if (res.status === 401) throw new AiError('API Key 无效');
    if (res.status === 404) throw new AiError(`接口地址或模型名不对（404）：${detail}`);
    throw new AiError(`模型服务返回 ${res.status}：${detail}`);
  }
}

// ---------------- 统一入口 ----------------

export interface CompleteOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  effort?: Effort;
  /** 要求只输出 JSON（OpenAI 兼容接口会开启 JSON 模式） */
  json?: boolean;
}

export async function complete(t: Target, o: CompleteOptions): Promise<string> {
  const maxTokens = o.maxTokens ?? 8000;
  if (t.kind === 'anthropic') {
    const res = await claude(t, { system: o.system, messages: [{ role: 'user', content: o.prompt }], maxTokens, effort: o.effort ?? 'low' });
    return claudeText(res);
  }
  const msg = await openai(t, {
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: o.prompt },
    ],
    maxTokens,
    json: o.json,
  });
  return (msg.content || '').trim();
}

/** 从模型输出里取出 JSON（容忍外面包了 ```json 代码块、前后有说明文字或推理模型的思考标签） */
export function parseJson<T>(text: string): T {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const start = Math.min(...['{', '['].map((c) => (cleaned.indexOf(c) < 0 ? Infinity : cleaned.indexOf(c))));
  const raw = fenced ?? (Number.isFinite(start) ? cleaned.slice(start) : cleaned);
  try {
    return JSON.parse(raw.trim());
  } catch {
    throw new AiError('模型返回的格式无法解析，请重试或换一个模型');
  }
}

/** 列出服务上可用的模型，便于用户选择 */
export async function listModels(t: Pick<Target, 'kind' | 'baseUrl' | 'apiKey'>): Promise<string[]> {
  if (t.kind === 'anthropic') {
    try {
      const ids: string[] = [];
      for await (const m of anthropic(t).models.list({ limit: 100 })) ids.push(m.id);
      return ids;
    } catch (e) {
      throw claudeError(e);
    }
  }
  const res = await fetch(`${base(t)}/models`, { headers: { Authorization: `Bearer ${t.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) }).catch((e) => {
    throw new AiError(`无法连接模型服务：${e.message}`);
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AiError('API Key 无效');
  if (!res.ok) throw new AiError(`这个服务不支持列出模型（${res.status}），请手动填写模型名`);
  return (data.data || data.models || []).map((m: any) => m.id || m.name).filter(Boolean).sort();
}

// ---------------- 工具调用循环 ----------------

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（type: object） */
  parameters: Record<string, unknown>;
}

export type ToolRunner = (name: string, input: Record<string, unknown>) => Promise<string>;

/**
 * 一次对话的原始消息历史，按各家接口的原生格式保存。
 * 只追加不修改：Claude 要求把带思考块的回复原样回传，改动历史会让思考块失效。
 */
export interface Conversation {
  key: string;
  messages: unknown[];
}

const MAX_STEPS = 8;

export async function runTools(t: Target, conv: Conversation, system: string, userText: string, tools: ToolSpec[], run: ToolRunner): Promise<string> {
  if (t.kind === 'anthropic') {
    const messages = conv.messages as Anthropic.Beta.BetaMessageParam[];
    const defs: Anthropic.Beta.BetaTool[] = tools.map((x) => ({
      name: x.name,
      description: x.description,
      input_schema: x.parameters as Anthropic.Beta.BetaTool.InputSchema,
    }));
    messages.push({ role: 'user', content: userText });
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await claude(t, { system, messages, tools: defs, maxTokens: 16000, effort: 'medium' });
      // 整个 content 原样追加，思考块也要一起回传
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'pause_turn') continue;
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !calls.length) return claudeText(res);
      // 同一轮的所有工具结果放进同一条用户消息
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        try {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: await run(call.name, (call.input || {}) as Record<string, unknown>) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `出错：${(e as Error).message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return '步骤太多，先停在这里。可以换个更具体的说法再试一次。';
  }

  const messages = conv.messages as OpenAIMessage[];
  if (!messages.length) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userText });
  const defs = tools.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.parameters } }));
  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await openai(t, { messages, tools: defs, maxTokens: 8000 });
    messages.push({
      role: 'assistant',
      content: msg.content ?? null,
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
    });
    if (!msg.tool_calls?.length) return (msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    for (const call of msg.tool_calls) {
      let output: string;
      try {
        output = await run(call.function.name, JSON.parse(call.function.arguments || '{}'));
      } catch (e) {
        output = `出错：${(e as Error).message}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
  return '步骤太多，先停在这里。可以换个更具体的说法再试一次。';
}
