import { z } from 'zod';
import type { User } from '../auth.js';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { exec, one, query } from '../db.js';
import { siteConfig } from '../site.js';
import { AiError } from './provider.js';
import type { ProviderKind, Target } from './provider.js';

// 多个模型服务 + 按任务分配：便宜快速的模型做过滤、验证码、链接这类高频小活，
// 强一些的模型做摘要、翻译、回复和助手。每项任务都可以单独关掉，关掉时用本地规则（能用的话）。

export const TASKS = {
  filter: { label: '通知过滤', hint: '判断新邮件是否重要，配合"只推送重要邮件"', tier: 'fast', local: '关键词和发件人规则' },
  code: { label: '验证码提取', hint: '本地规则识别不到时让模型补充', tier: 'fast', local: '本地规则' },
  links: { label: '链接整理', hint: '从邮件链接里挑出续费、验证等关键链接并标注', tier: 'fast', local: '本地规则' },
  summary: { label: '摘要', hint: '邮件里的"摘要"按钮和机器人里的 AI 摘要', tier: 'strong', local: null },
  translate: { label: '翻译', hint: '邮件里的"翻译"按钮', tier: 'strong', local: null },
  todos: { label: '提取待办', hint: '从邮件里找出需要你做的事', tier: 'strong', local: null },
  reply: { label: '起草回复', hint: '按你的要求写回复', tier: 'strong', local: null },
  assistant: { label: '助手', hint: '网页和聊天机器人里的对话与工具调用，需要模型支持函数调用', tier: 'strong', local: null },
} as const;
export type TaskName = keyof typeof TASKS;
export const TASK_NAMES = Object.keys(TASKS) as TaskName[];

export const taskSettingSchema = z.object({
  enabled: z.boolean(),
  providerId: z.number().int().nullable(),
  /** 留空用服务的默认模型 */
  model: z.string().trim().max(100),
});
export type TaskSetting = z.infer<typeof taskSettingSchema>;

export interface ProviderRow {
  id: number;
  user_id: number | null;
  name: string;
  kind: ProviderKind;
  base_url: string;
  api_key_enc: string;
  default_model: string;
  models: string[] | null;
}

/** 用户能用的服务：自己的 + 管理员开放的共享服务 */
export async function providersOf(user: User): Promise<ProviderRow[]> {
  const shared = user.isAdmin || (siteConfig().shareAi && user.perms.sharedAi);
  return query<ProviderRow>(
    `SELECT * FROM ai_providers WHERE user_id = ? ${shared ? 'OR user_id IS NULL' : ''} ORDER BY user_id IS NULL, id`,
    [user.id],
  );
}

/**
 * 每项任务的有效配置。没单独设置过的任务：强任务默认开启并用第一个可用服务，
 * 快任务默认关闭（用本地规则），这样只填一个模型服务就能直接用上主要功能。
 */
export async function taskSettings(user: User): Promise<Record<TaskName, TaskSetting>> {
  const providers = await providersOf(user);
  const saved = user.settings.aiTasks || {};
  return Object.fromEntries(
    TASK_NAMES.map((t) => {
      const s = saved[t];
      const valid = s && (s.providerId === null || providers.some((p) => p.id === s.providerId));
      const fallback: TaskSetting = { enabled: TASKS[t].tier === 'strong' && providers.length > 0, providerId: providers[0]?.id ?? null, model: '' };
      return [t, valid ? s : fallback];
    }),
  ) as Record<TaskName, TaskSetting>;
}

/** 这项任务现在能不能用 AI：开启了，且对应的服务存在 */
export async function resolveTask(user: User, task: TaskName): Promise<Target | null> {
  const s = (await taskSettings(user))[task];
  if (!s.enabled || !s.providerId) return null;
  const p = (await providersOf(user)).find((x) => x.id === s.providerId);
  if (!p) return null;
  return { kind: p.kind, baseUrl: p.base_url, apiKey: decrypt(p.api_key_enc), model: s.model || p.default_model, userId: user.id, task };
}

export async function requireTask(user: User, task: TaskName): Promise<Target> {
  const t = await resolveTask(user, task);
  if (!t) throw new AiError(`"${TASKS[task].label}"没有启用或没有可用的模型，请在 设置 → AI 里配置`);
  return t;
}

export const anyAi = async (user: User) => (await providersOf(user)).length > 0;

export const providerInput = z.object({
  name: z.string().trim().min(1, '请填写名称').max(60),
  kind: z.enum(['anthropic', 'openai']),
  baseUrl: z.string().trim().max(300).refine((v) => v === '' || /^https?:\/\//.test(v), '接口地址必须以 http:// 或 https:// 开头'),
  defaultModel: z.string().trim().min(1, '请填写默认模型').max(100),
  /** 编辑时留空表示沿用已保存的 Key */
  apiKey: z.string().trim().max(500).optional(),
});

export async function saveProvider(ownerId: number | null, id: number | null, input: z.infer<typeof providerInput>): Promise<number> {
  if (id) {
    const cur = await one<ProviderRow>('SELECT * FROM ai_providers WHERE id = ? AND user_id <=> ?', [id, ownerId]);
    if (!cur) throw new AiError('模型服务不存在');
    await exec('UPDATE ai_providers SET name = ?, kind = ?, base_url = ?, default_model = ?, api_key_enc = ? WHERE id = ?', [
      input.name,
      input.kind,
      input.baseUrl,
      input.defaultModel,
      input.apiKey ? encrypt(input.apiKey) : cur.api_key_enc,
      id,
    ]);
    return id;
  }
  if (!input.apiKey && !/localhost|127\.0\.0\.1|host\.docker\.internal/.test(input.baseUrl)) throw new AiError('请填写 API Key');
  const res = await exec('INSERT INTO ai_providers (user_id, name, kind, base_url, api_key_enc, default_model) VALUES (?, ?, ?, ?, ?, ?)', [
    ownerId,
    input.name,
    input.kind,
    input.baseUrl,
    encrypt(input.apiKey || 'none'),
    input.defaultModel,
  ]);
  return res.insertId;
}

export const providerTarget = (p: ProviderRow, userId: number, model?: string): Target => ({
  kind: p.kind,
  baseUrl: p.base_url,
  apiKey: decrypt(p.api_key_enc),
  model: model || p.default_model,
  userId,
  task: 'test',
});

/** 给前端的服务信息：不含 Key */
export const publicProvider = (p: ProviderRow) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  baseUrl: p.base_url,
  defaultModel: p.default_model,
  models: p.models || [],
  shared: p.user_id === null,
});

const KNOWN_HOSTS: [RegExp, string][] = [
  [/deepseek/, 'DeepSeek'],
  [/xiaomimimo|mimo/, '小米 MiMo'],
  [/dashscope|aliyuncs/, '通义千问'],
  [/moonshot|kimi/, 'Kimi'],
  [/openrouter/, 'OpenRouter'],
  [/bigmodel|zhipu/, '智谱'],
  [/volces|ark\./, '豆包'],
  [/siliconflow/, '硅基流动'],
  [/openai\.com/, 'OpenAI'],
  [/anthropic\.com/, 'Claude'],
  [/localhost|127\.0\.0\.1|host\.docker\.internal|:11434/, '本地模型'],
];

/** 按接口地址猜一个好认的服务名 */
export function providerName(kind: ProviderKind, baseUrl: string): string {
  if (kind === 'anthropic' && !baseUrl) return 'Claude';
  if (!baseUrl) return 'OpenAI';
  return KNOWN_HOSTS.find(([re]) => re.test(baseUrl))?.[1] ?? (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return 'OpenAI 兼容';
    }
  })();
}

/**
 * 0.3 及之前只有一个模型配置（settings.ai）。启动时把它转换成一个模型服务和对应的任务分配，
 * .env 里的服务器默认模型转换成共享服务。只执行一次。
 */
export async function migrateLegacyAi(): Promise<void> {
  const users = await query<{ id: number; settings: any }>(`SELECT id, settings FROM users WHERE JSON_EXTRACT(settings, '$.ai.apiKeyEnc') IS NOT NULL`);
  for (const u of users) {
    const ai = u.settings.ai;
    const res = await exec('INSERT INTO ai_providers (user_id, name, kind, base_url, api_key_enc, default_model) VALUES (?, ?, ?, ?, ?, ?)', [
      u.id,
      providerName(ai.provider, ai.baseUrl || ''),
      ai.provider,
      ai.baseUrl || '',
      ai.apiKeyEnc,
      ai.model,
    ]);
    const pid = res.insertId;
    const fast = ai.fastModel && ai.fastModel !== ai.model ? ai.fastModel : '';
    const aiTasks = Object.fromEntries(
      TASK_NAMES.map((t) => [
        t,
        TASKS[t].tier === 'strong'
          ? { enabled: true, providerId: pid, model: '' }
          : { enabled: t === 'filter' && !!u.settings.aiFilter, providerId: pid, model: fast },
      ]),
    );
    const { ai: _old, aiFilter, ...rest } = u.settings;
    await exec('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify({ ...rest, importantOnly: !!aiFilter, aiTasks }), u.id]);
    console.log(`[ai] 用户 ${u.id} 的模型配置已迁移为模型服务「${ai.provider}」`);
  }
  const env = config.ai;
  if (env.provider && env.apiKey && !(await one('SELECT id FROM ai_providers WHERE user_id IS NULL LIMIT 1'))) {
    await exec('INSERT INTO ai_providers (user_id, name, kind, base_url, api_key_enc, default_model) VALUES (NULL, ?, ?, ?, ?, ?)', [
      '服务器默认',
      env.provider,
      env.baseUrl,
      encrypt(env.apiKey),
      env.model,
    ]);
    console.log('[ai] .env 里的服务器默认模型已转换为共享模型服务');
  }
}
