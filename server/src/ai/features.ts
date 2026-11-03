import { DateTime } from 'luxon';
import type { User } from '../auth.js';
import { exec, one } from '../db.js';
import { worker } from '../mail/manager.js';
import { AiError, complete, parseJson } from './provider.js';
import { requireTask } from './tasks.js';

// 针对单封邮件的 AI 功能。结果按 Message-ID 缓存，同一封邮件不会重复花钱。

/** 交给模型的正文上限。超出时明确告诉模型（和用户）只看了前面一部分 */
const BODY_LIMIT = 40_000;

export interface MailForAi {
  id: number;
  account_id: number;
  message_id: string | null;
  subject: string;
  from_name: string;
  from_addr: string;
  date: Date;
  body_text: string | null;
  body_fetched: number;
  ai_enabled: number;
}

export async function loadMailForAi(userId: number, id: number): Promise<MailForAi> {
  const load = () =>
    one<MailForAi>(
      `SELECT m.id, m.account_id, m.message_id, m.subject, m.from_name, m.from_addr, m.date, m.body_text, m.body_fetched,
              a.ai_enabled
       FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.user_id = ?`,
      [id, userId],
    );
  let m = await load();
  if (!m) throw new AiError('邮件不存在');
  // 隐私开关：邮件内容会发给第三方模型，必须在这个邮箱上明确开启
  if (!m.ai_enabled) throw new AiError('这个邮箱没有开启 AI，可以在 设置 → 邮箱账号 里打开');
  if (!m.body_fetched) {
    await worker(m.account_id).loadBody(m.id);
    m = (await load())!;
  }
  return m;
}

export function mailBlock(m: MailForAi): { text: string; truncated: boolean } {
  const body = (m.body_text || '').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = body.length > BODY_LIMIT;
  return {
    truncated,
    text: [
      `发件人：${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}`,
      `时间：${new Date(m.date).toISOString()}`,
      `主题：${m.subject || '(无主题)'}`,
      '',
      truncated ? `${body.slice(0, BODY_LIMIT)}\n\n[正文过长，以上只是前 ${BODY_LIMIT} 个字符]` : body || '(无正文)',
    ].join('\n'),
  };
}

const refOf = (m: MailForAi) => (m.message_id || `row:${m.id}`).slice(0, 190);

async function cached(user: User, m: MailForAi, kind: string, param: string, make: () => Promise<string>): Promise<string> {
  const hit = await one<{ content: string }>(
    'SELECT content FROM ai_cache WHERE user_id = ? AND ref = ? AND kind = ? AND param = ?',
    [user.id, refOf(m), kind, param],
  );
  if (hit) return hit.content;
  const content = await make();
  await exec(
    `INSERT INTO ai_cache (user_id, ref, kind, param, content) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content), created_at = UTC_TIMESTAMP()`,
    [user.id, refOf(m), kind, param, content],
  );
  return content;
}

export async function summarize(user: User, id: number, fresh = false): Promise<string> {
  const cfg = await requireTask(user, 'summary');
  const m = await loadMailForAi(user.id, id);
  if (fresh) await exec(`DELETE FROM ai_cache WHERE user_id = ? AND ref = ? AND kind = 'summary'`, [user.id, refOf(m)]);
  return cached(user, m, 'summary', '', async () => {
    const mail = mailBlock(m);
    return complete(cfg, {
      system:
        '你是邮件助手。用简体中文为用户总结邮件：先用一句话说清这封邮件是什么、要用户做什么；' +
        '再用不超过 4 条要点列出关键信息（时间、金额、截止日期、链接用途等）。' +
        '没有需要用户做的事就直说"无需处理"。不要编造邮件里没有的内容，不要客套。',
      prompt: mail.text,
      maxTokens: 2000,
    });
  });
}

export async function translate(user: User, id: number, lang?: string): Promise<string> {
  const cfg = await requireTask(user, 'translate');
  const target = lang || user.settings.translateTo || '简体中文';
  const m = await loadMailForAi(user.id, id);
  return cached(user, m, 'translate', target.slice(0, 32), async () => {
    const mail = mailBlock(m);
    return complete(cfg, {
      system:
        `把用户给的邮件翻译成${target}。保留原有的段落和列表结构，链接、代码、验证码、金额、专有名词保持原样。` +
        `第一行输出翻译后的主题，以"主题："开头，空一行后是正文译文。只输出译文，不要解释。`,
      prompt: `主题：${m.subject}\n\n${mail.text.split('\n').slice(4).join('\n')}`,
      maxTokens: 16000,
    });
  });
}

export interface TodoSuggestion {
  title: string;
  /** 用户时区的本地时间，形如 2026-10-20T15:00；没有明确时间则为 null */
  due: string | null;
  notes: string;
}

export async function extractTodos(user: User, id: number): Promise<TodoSuggestion[]> {
  const cfg = await requireTask(user, 'todos');
  const m = await loadMailForAi(user.id, id);
  const now = DateTime.now().setZone(user.timezone);
  const text = await cached(user, m, 'todos', now.toISODate()!, async () =>
    complete(cfg, {
      system:
        `从邮件里找出需要收件人去做的事，只要明确的行动项（回复、付款、提交、参加、续费……），没有就返回空数组。` +
        `现在是 ${now.toFormat("yyyy-LL-dd'T'HH:mm")}（${user.timezone}，${now.setLocale('zh-CN').toFormat('cccc')}）。` +
        `把邮件里的相对时间换算成这个时区的本地时间。` +
        `只输出 JSON：{"items":[{"title":"简短的动宾短语","due":"YYYY-MM-DDTHH:mm 或 null","notes":"一句话补充，可为空"}]}`,
      prompt: mailBlock(m).text,
      maxTokens: 2000,
      json: true,
    }),
  );
  const parsed = parseJson<TodoSuggestion[] | { items?: TodoSuggestion[] }>(text);
  // JSON 模式下有的模型会包一层对象
  const list = Array.isArray(parsed) ? parsed : parsed.items || [];
  return Array.isArray(list)
    ? list
        .filter((t) => t && typeof t.title === 'string')
        .slice(0, 8)
        .map((t) => ({
          title: t.title.slice(0, 200),
          due: typeof t.due === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(t.due) ? t.due.slice(0, 16) : null,
          notes: typeof t.notes === 'string' ? t.notes.slice(0, 500) : '',
        }))
    : [];
}

export async function draftReply(user: User, id: number, instruction: string): Promise<string> {
  const cfg = await requireTask(user, 'reply');
  const m = await loadMailForAi(user.id, id);
  return complete(cfg, {
    system:
      `你替用户 ${user.name} 起草邮件回复。用和原邮件相同的语言，语气得体、简洁，不要编造事实，` +
      `需要用户补充的信息用【】标出。只输出回复正文，不要主题，不要引用原文，不要加签名。`,
    prompt: `${mailBlock(m).text}\n\n---\n用户对回复的要求：${instruction.trim() || '礼貌地回复，确认收到并给出下一步'}`,
    maxTokens: 4000,
    effort: 'medium',
  });
}

