import type { User } from '../auth.js';
import { exec, one } from '../db.js';
import type { LinkInfo, LinkKind } from '../mail/links.js';
import { complete, parseJson } from './provider.js';
import type { Target } from './provider.js';
import { resolveTask } from './tasks.js';
import type { TaskName } from './tasks.js';

// 新邮件分拣：判断重要性、补充验证码、整理链接。
// 每项都可以单独选择用 AI（便宜的快速模型）或本地规则；同一个模型上的几项合成一次调用，省钱也省时间。

export const LABELS = {
  important: '重要',
  reply: '需回复',
  bill: '账单',
  notice: '通知',
  promo: '营销',
  social: '社交',
  code: '验证码',
} as const;
export type Label = keyof typeof LABELS;

/** 值得推送的标签 */
export const NOTIFY_LABELS: Label[] = ['important', 'reply', 'bill', 'code'];

interface Mail {
  id: number;
  subject: string;
  from_name: string;
  from_addr: string;
  snippet: string;
  body_text: string | null;
  code: string | null;
  links: LinkInfo[] | null;
  ai_enabled: number;
}

const SOCIAL = /(^|\.)(facebook|facebookmail|twitter|x|linkedin|instagram|weibo|zhihu|douban|bilibili|xiaohongshu|discord|reddit|quora|pinterest|tiktok|douyin|youtube)\.(com|cn)$/i;

/** 本地规则：不调用模型时用它判断重要性，准确率有限但零成本 */
export function localLabel(m: Pick<Mail, 'subject' | 'from_addr' | 'from_name' | 'snippet' | 'code' | 'links'>): Label {
  if (m.code) return 'code';
  const text = `${m.subject} ${m.snippet}`;
  if (/账单|发票|付款|支付|扣款|续费|到期|订单|收据|缴费|invoice|receipt|payment|billing|renew|subscription|your order|charged/i.test(text)) return 'bill';
  const domain = m.from_addr.split('@')[1] || '';
  if (SOCIAL.test(domain)) return 'social';
  if (m.links?.some((l) => l.kind === 'unsubscribe') || /newsletter|digest|促销|优惠|折扣|限时|特价|会员日|sale|% off|deal|webinar|周报|月刊/i.test(text)) return 'promo';
  if (/^(no-?reply|notifications?|alerts?|mailer-daemon|postmaster|system|bounce)[^@]*@/i.test(m.from_addr) || /通知|提醒|alert|notification|automated/i.test(m.subject)) return 'notice';
  return 'important';
}

const KINDS: LinkKind[] = ['billing', 'verify', 'account', 'tracking', 'download', 'unsubscribe', 'other'];

/** 模型给出的验证码必须真的出现在邮件里，防止编造 */
function validCode(code: unknown, text: string): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim();
  if (!/^[A-Za-z0-9-]{4,12}$/.test(c)) return null;
  const squash = (s: string) => s.replace(/[\s-]/g, '');
  return text.includes(c) || squash(text).includes(squash(c)) ? c : null;
}

interface Group {
  target: Target;
  tasks: TaskName[];
}

export interface TriageResult {
  label: Label;
  /** 标签来自 AI 还是本地规则 */
  byAi: boolean;
}

export async function triage(user: User, messageId: number): Promise<TriageResult | null> {
  const m = await one<Mail>(
    `SELECT m.id, m.subject, m.from_name, m.from_addr, m.snippet, m.body_text, m.code, m.links, a.ai_enabled
     FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.user_id = ?`,
    [messageId, user.id],
  );
  if (!m) return null;
  const local = localLabel(m);
  if (!m.ai_enabled) return { label: local, byAi: false };

  const links = (m.links || []).slice(0, 25);
  // 只为确实需要的任务调用模型：本地已经找到验证码就不再问，没有链接就不整理
  const wanted: TaskName[] = ['filter'];
  if (!m.code) wanted.push('code');
  if (links.length >= 2) wanted.push('links');
  const groups = new Map<string, Group>();
  for (const task of wanted) {
    const target = await resolveTask(user, task);
    if (!target) continue;
    const key = `${target.kind}|${target.baseUrl}|${target.model}`;
    const g = groups.get(key) || { target: { ...target, task: 'triage' }, tasks: [] };
    g.tasks.push(task);
    groups.set(key, g);
  }
  if (!groups.size) return { label: local, byAi: false };

  const text = (m.body_text || m.snippet || '').slice(0, 4000);
  let label: Label | null = null;
  for (const g of groups.values()) {
    const fields: string[] = [];
    if (g.tasks.includes('filter')) {
      fields.push(
        '"category": important（个人或工作上需要关注的）| reply（对方在等回复）| bill（账单/付款/续费/订单）| notice（系统通知、自动提醒）| promo（营销推广、newsletter）| social（社交网络动态）| code（验证码）',
      );
    }
    if (g.tasks.includes('code')) fields.push('"code": 邮件里的验证码 / 一次性密码原文，没有就填 null');
    if (g.tasks.includes('links')) {
      fields.push(`"links": 最多 5 个用户最可能要点的链接，按重要性排序：[{"i": 链接编号, "kind": ${KINDS.join('|')}, "label": "不超过 10 个字的用途说明"}]`);
    }
    const linkList = g.tasks.includes('links') ? `\n\n链接（编号 文字 — 域名）：\n${links.map((l, i) => `[${i}] ${l.text || '(无文字)'} — ${l.domain}`).join('\n')}` : '';
    try {
      const out = await complete(g.target, {
        system: `你是邮件分拣器。只输出一个 JSON 对象，包含这些字段：\n${fields.join('\n')}`,
        prompt: `发件人：${m.from_name} <${m.from_addr}>\n主题：${m.subject}\n\n${text}${linkList}`,
        maxTokens: 600,
        json: true,
      });
      const r = parseJson<{ category?: string; code?: unknown; links?: { i: number; kind: string; label?: string }[] }>(out);
      if (g.tasks.includes('filter') && r.category && r.category in LABELS) label = r.category as Label;
      if (g.tasks.includes('code')) {
        const code = validCode(r.code, `${m.subject}\n${text}`);
        if (code) await exec('UPDATE messages SET code = ? WHERE id = ? AND code IS NULL', [code, m.id]);
        if (code && !label) label = 'code';
      }
      if (g.tasks.includes('links') && Array.isArray(r.links)) {
        const picked: LinkInfo[] = [];
        for (const x of r.links.slice(0, 5)) {
          const l = links[Number(x?.i)];
          if (!l || picked.includes(l)) continue;
          picked.push({ ...l, kind: KINDS.includes(x.kind as LinkKind) ? (x.kind as LinkKind) : l.kind, ...(x.label ? { label: String(x.label).slice(0, 20) } : {}), ai: true });
        }
        if (picked.length) {
          const rest = (m.links || []).filter((l) => !picked.some((p) => p.url === l.url));
          await exec('UPDATE messages SET links = ? WHERE id = ?', [JSON.stringify([...picked, ...rest]), m.id]);
        }
      }
    } catch (e) {
      // 分拣失败不影响通知，退回本地规则
      console.error('[ai triage]', (e as Error).message);
    }
  }
  const final = label || local;
  await exec('UPDATE messages SET ai_label = ? WHERE id = ?', [final, m.id]);
  return { label: final, byAi: !!label };
}
