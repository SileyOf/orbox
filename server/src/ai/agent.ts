import { DateTime } from 'luxon';
import type { User } from '../auth.js';
import { query } from '../db.js';
import { AiError, aiConfigOf, newConversation, runTools } from './provider.js';
import type { Conversation } from './provider.js';
import { peekPending, runTool, toolSpecs } from './tools.js';

// 内置 AI 助手：网页和各个聊天机器人共用。每个"渠道"（网页、Telegram、飞书……）各自保持一段对话。

interface Session {
  conv: Conversation;
  turns: number;
  updated: number;
}

const sessions = new Map<string, Session>();
/** 对话超过这么久没动静或轮数太多就重新开始。只开新对话、不裁剪旧消息，历史保持只追加 */
const IDLE_MS = 30 * 60_000;
const MAX_TURNS = 20;

export const resetSession = (userId: number, channel: string) => sessions.delete(`${userId}:${channel}`);

async function systemPrompt(user: User, channel: string): Promise<string> {
  const now = DateTime.now().setZone(user.timezone);
  const accounts = await query<{ id: number; name: string; email: string }>(
    'SELECT id, name, email FROM accounts WHERE user_id = ? AND ai_enabled = 1',
    [user.id],
  );
  return [
    `你是 Orbox 里的邮件与计划助手，正在通过「${channel}」和用户 ${user.name} 对话。`,
    `现在是 ${now.toFormat('yyyy-LL-dd HH:mm')}（${user.timezone}，${now.setLocale('zh-CN').toFormat('cccc')}）。`,
    accounts.length
      ? `你能访问的邮箱：${accounts.map((a) => `${a.name} <${a.email}>（id ${a.id}）`).join('；')}。`
      : '用户还没有为任何邮箱开启 AI 访问，邮件相关的工具会失败，请提示用户到 设置 → 邮箱账号 里开启。',
    '用工具查邮件和计划，不要凭空回答邮件内容。需要发邮件时只能用 draft_email 起草，由用户确认后才会发出，绝不要说已经发出。',
    '回答用用户的语言，简洁直接。聊天软件里只用简单的 Markdown（加粗、列表、链接），不要用表格和标题。',
    '提到邮件时带上主题，方便用户对应；时间用用户时区。',
  ].join('\n');
}

export interface AgentReply {
  text: string;
  /** 本轮起草、等待用户确认的邮件 */
  pending: { id: string; summary: string }[];
}

export async function askAssistant(user: User, channel: string, text: string): Promise<AgentReply> {
  const cfg = aiConfigOf(user);
  if (!cfg) throw new AiError('还没有配置 AI 模型，请在 设置 → AI 里填写');
  const key = `${user.id}:${channel}`;
  let s = sessions.get(key);
  if (!s || s.updated < Date.now() - IDLE_MS || s.turns >= MAX_TURNS || s.conv.provider !== cfg.provider || s.conv.model !== cfg.model) {
    s = { conv: newConversation(cfg), turns: 0, updated: Date.now() };
    sessions.set(key, s);
  }
  const drafted: string[] = [];
  const ctx = { user, mode: 'assistant' as const, allowSend: false };
  const reply = await runTools(cfg, s.conv, await systemPrompt(user, channel), text, toolSpecs(ctx), async (name, input) => {
    const out = await runTool(name, input, ctx);
    if (name === 'draft_email') {
      const id = JSON.parse(out).pending_id;
      if (id) drafted.push(id);
    }
    return out;
  });
  s.turns++;
  s.updated = Date.now();
  return {
    text: reply || '（没有回复内容）',
    pending: drafted.map((id) => ({ id, summary: peekPending(user.id, id)?.summary || '' })).filter((p) => p.summary),
  };
}
