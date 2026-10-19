import Anthropic from '@anthropic-ai/sdk';
import type { User } from '../auth.js';
import { config } from '../config.js';
import { decrypt } from '../crypto.js';

// 模型接入层：Claude 走官方 SDK，其余（OpenAI、DeepSeek、通义、Kimi、Ollama、OpenRouter……）
// 走 OpenAI 兼容的 /chat/completions。上层只看到统一的 complete() 和 runTools()。

export type ProviderKind = 'anthropic' | 'openai';

export interface AiConfig {
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 分类等高频小任务用的模型，留空则与主模型相同 */
  fastModel: string;
}

export const DEFAULT_MODEL: Record<ProviderKind, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-5' };

/** 用户自己的配置优先；没配时若管理员开放了服务器默认配置就用它 */
export function aiConfigOf(user: User): AiConfig | null {
  const own = user.settings.ai;
  if (own?.provider && own.apiKeyEnc) {
    return {
      provider: own.provider,
      baseUrl: own.baseUrl || '',
      apiKey: decrypt(own.apiKeyEnc),
      model: own.model || DEFAULT_MODEL[own.provider],
      fastModel: own.fastModel || own.model || DEFAULT_MODEL[own.provider],
    };
  }
  const s = config.ai;
  if (s.shared && s.provider && s.apiKey) {
    return { provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, fastModel: s.fastModel || s.model };
  }
  return null;
}

export class AiError extends Error {}

// ---------------- Claude ----------------

const clients = new Map<string, Anthropic>();
function anthropic(cfg: AiConfig): Anthropic {
  const key = `${cfg.baseUrl}|${cfg.apiKey}`;
  let c = clients.get(key);
  if (!c) clients.set(key, (c = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined, maxRetries: 2 })));
  return c;
}

/** 4.6 之后的型号支持 effort；更老的型号或代理上的其他模型不传，避免 400 */
const supportsEffort = (model: string) =>
  /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model) || /^claude-(opus-4-[5-8]|sonnet-4-6)/.test(model);

/** 直连官方 API 且模型支持时，开启服务器端拒答兜底，被安全策略拒绝时自动换模型重试 */
const supportsFallback = (cfg: AiConfig, model: string) =>
  !cfg.baseUrl && /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(model);

type Effort = 'low' | 'medium' | 'high';

async function claude(
  cfg: AiConfig,
  model: string,
  params: { system: string; messages: Anthropic.Beta.BetaMessageParam[]; tools?: Anthropic.Beta.BetaTool[]; maxTokens: number; effort: Effort },
): Promise<Anthropic.Beta.BetaMessage> {
  const fallback = supportsFallback(cfg, model);
  try {
    const res = await anthropic(cfg).beta.messages.create({
      model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
      ...(params.tools?.length ? { tools: params.tools } : {}),
      ...(supportsEffort(model) ? { output_config: { effort: params.effort } } : {}),
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    if (res.stop_reason === 'refusal') throw new AiError('模型拒绝处理这个请求');
    return res;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('Claude API Key 无效');
    if (e instanceof Anthropic.RateLimitError) throw new AiError('Claude API 请求太频繁，请稍后再试');
    if (e instanceof Anthropic.APIError) throw new AiError(`Claude API 错误（${e.status}）：${e.message}`);
    throw new AiError(`无法连接 Claude API：${(e as Error).message}`);
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
}

async function openai(
  cfg: AiConfig,
  model: string,
  body: { messages: OpenAIMessage[]; tools?: unknown[]; maxTokens: number },
): Promise<OpenAIMessage> {
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  // 新一代推理模型只认 max_completion_tokens
  const limitKey = /^(o\d|gpt-5)/.test(model) ? 'max_completion_tokens' : 'max_tokens';
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        messages: body.messages,
        [limitKey]: body.maxTokens,
        ...(body.tools?.length ? { tools: body.tools } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new AiError(`无法连接模型服务：${(e as Error).message}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new AiError(`模型服务返回 ${res.status}：${data.error?.message || JSON.stringify(data).slice(0, 200)}`);
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new AiError('模型服务没有返回内容');
  return msg;
}

// ---------------- 统一入口 ----------------

export interface CompleteOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** 'fast' 用于分类这类高频小任务 */
  tier?: 'main' | 'fast';
  effort?: Effort;
}

export async function complete(cfg: AiConfig, o: CompleteOptions): Promise<string> {
  const model = o.tier === 'fast' ? cfg.fastModel : cfg.model;
  const maxTokens = o.maxTokens ?? 8000;
  if (cfg.provider === 'anthropic') {
    const res = await claude(cfg, model, {
      system: o.system,
      messages: [{ role: 'user', content: o.prompt }],
      maxTokens,
      effort: o.effort ?? 'low',
    });
    return claudeText(res);
  }
  const msg = await openai(cfg, model, {
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: o.prompt },
    ],
    maxTokens,
  });
  return (msg.content || '').trim();
}

/** 从模型输出里取出 JSON（容忍外面包了 ```json 代码块或前后有说明文字） */
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const raw = fenced ?? text.slice(Math.min(...['{', '['].map((c) => (text.indexOf(c) < 0 ? Infinity : text.indexOf(c)))));
  try {
    return JSON.parse(raw.trim());
  } catch {
    throw new AiError('模型返回的格式无法解析，请重试');
  }
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
  provider: ProviderKind;
  model: string;
  messages: unknown[];
}

export function newConversation(cfg: AiConfig): Conversation {
  return { provider: cfg.provider, model: cfg.model, messages: [] };
}

const MAX_STEPS = 8;

export async function runTools(
  cfg: AiConfig,
  conv: Conversation,
  system: string,
  userText: string,
  tools: ToolSpec[],
  run: ToolRunner,
): Promise<string> {
  if (cfg.provider === 'anthropic') {
    const messages = conv.messages as Anthropic.Beta.BetaMessageParam[];
    const defs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    }));
    messages.push({ role: 'user', content: userText });
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await claude(cfg, conv.model, { system, messages, tools: defs, maxTokens: 16000, effort: 'medium' });
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
  const defs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await openai(cfg, conv.model, { messages, tools: defs, maxTokens: 8000 });
    messages.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) return (msg.content || '').trim();
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
