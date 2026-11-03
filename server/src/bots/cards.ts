import { DateTime } from 'luxon';
import type { User } from '../auth.js';
import { one, query } from '../db.js';
import { LINK_LABELS, primaryLink } from '../mail/links.js';
import type { LinkInfo } from '../mail/links.js';
import { webviewUrl } from '../mail/webview.js';
import { siteConfig } from '../site.js';
import { formatWhen } from '../tasks/parse.js';
import { dueToday } from '../tasks/service.js';
import type { TaskRow } from '../tasks/service.js';
import type { Button, Card } from './types.js';
import { plain } from './types.js';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface MailRow {
  id: number;
  account_id: number;
  subject: string;
  from_name: string;
  from_addr: string;
  to_json: { name: string; address: string }[] | null;
  cc_json: { name: string; address: string }[] | null;
  date: Date;
  snippet: string;
  code: string | null;
  links: LinkInfo[] | null;
  attachments: { i: number; filename: string; size: number; inline: boolean }[] | null;
  body_text: string | null;
  body_fetched: number;
  seen: number;
  ai_enabled: number;
  account_name: string;
}

export const loadMail = (userId: number, id: number) =>
  one<MailRow>(
    `SELECT m.id, m.account_id, m.subject, m.from_name, m.from_addr, m.to_json, m.cc_json, m.date, m.snippet, m.code,
            m.links, m.attachments, m.body_text, m.body_fetched, m.seen, a.ai_enabled, a.name AS account_name
     FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.user_id = ?`,
    [id, userId],
  );

const sender = (m: MailRow) => m.from_name || m.from_addr;
const addrs = (list: MailRow['to_json']) => (list || []).map((a) => a.name || a.address).join('、');

/** 新邮件通知卡片 */
export interface AiButtons {
  summary: boolean;
  translate: boolean;
}

export function mailCard(user: User, m: MailRow, opts: { vip?: boolean; resurfaced?: boolean; ai?: AiButtons } = {}): Card {
  const ai = { summary: !!opts.ai?.summary && !!m.ai_enabled, translate: !!opts.ai?.translate && !!m.ai_enabled };
  const rows: Button[][] = [];
  if (m.code) rows.push([{ text: `复制 ${m.code}`, copy: m.code }]);
  const key = primaryLink(m.links);
  const read: Button[] = [{ text: '阅读全文', action: `m:f:${m.id}` }];
  if (ai.summary) read.push({ text: 'AI 摘要', action: `m:s:${m.id}` });
  if (ai.translate) read.push({ text: '翻译', action: `m:tr:${m.id}` });
  rows.push(read);
  const ops: Button[] = [{ text: '已读', action: `m:r:${m.id}` }, { text: '归档', action: `m:a:${m.id}` }];
  if (!m.code) ops.push({ text: '转为待办', action: `m:t:${m.id}` });
  rows.push(ops);
  const extra: Button[] = [];
  if (key) extra.push({ text: `${key.label || LINK_LABELS[key.kind].split(' ')[0]} · ${key.domain}`, url: key.url });
  if (m.links?.length) extra.push({ text: `链接（${m.links.length}）`, action: `m:l:${m.id}` });
  if (extra.length) rows.push(extra);

  if (m.code) {
    return {
      tone: 'code',
      title: `验证码 ${m.code}`,
      text: `\`${m.code}\`\n**${plain(sender(m))}** · ${plain(m.subject || '(无主题)')}\n${plain(m.account_name)}`,
      buttons: rows,
    };
  }
  const head = opts.resurfaced ? '⏰ 稍后处理的邮件到时间了' : opts.vip ? '⭐ 重点发件人' : '📬 新邮件';
  return {
    tone: 'mail',
    title: head,
    text:
      `**${plain(sender(m))}** <${m.from_addr}>\n**${plain(m.subject || '(无主题)')}**\n\n${plain(clip(m.snippet, 300))}` +
      `\n\n${plain(m.account_name)}`,
    buttons: rows,
  };
}

/** 正文里很长的网址缩成"域名"链接，聊天窗口里更好读 */
function tidyBody(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => {
      if (url.length <= 60) return url;
      try {
        return `[${new URL(url).hostname} 的链接](${url})`;
      } catch {
        return url;
      }
    })
    .replace(/[*`]/g, (c) => (c === '*' ? '∗' : 'ˋ'))
    .trim();
}

/** 完整阅读：头部信息 + 全部正文（由适配器按平台长度限制拆成多条） + 操作按钮 */
export function fullMailCard(user: User, m: MailRow): Card {
  const atts = (m.attachments || []).filter((a) => !a.inline);
  const header = [
    `**${plain(m.subject || '(无主题)')}**`,
    `发件人：${plain(sender(m))} <${m.from_addr}>`,
    `收件人：${plain(addrs(m.to_json)) || '(未公开)'}`,
    ...(m.cc_json?.length ? [`抄送：${plain(addrs(m.cc_json))}`] : []),
    `时间：${DateTime.fromJSDate(new Date(m.date), { zone: user.timezone }).toFormat('yyyy-LL-dd HH:mm')}`,
    ...(atts.length ? [`附件：${atts.map((a) => plain(a.filename)).join('、')}`] : []),
  ].join('\n');
  const rows: Button[][] = [];
  const first: Button[] = [];
  if (atts.length) first.push({ text: `下载附件（${atts.length}）`, action: `m:at:${m.id}` });
  if (m.links?.length) first.push({ text: '链接', action: `m:l:${m.id}` });
  const web = webviewUrl(m.id, user.id);
  if (web) first.push({ text: '浏览器打开原文', url: web });
  if (first.length) rows.push(first);
  rows.push([
    { text: '已读', action: `m:r:${m.id}` },
    { text: '归档', action: `m:a:${m.id}` },
    { text: '转为待办', action: `m:t:${m.id}` },
  ]);
  return { tone: 'mail', text: `${header}\n\n${tidyBody(m.body_text || '(无正文)')}`, buttons: rows };
}

export function linksCard(m: MailRow): Card {
  const links = m.links || [];
  if (!links.length) return { tone: 'info', text: '这封邮件里没有链接。' };
  const lines: string[] = [];
  let kind = '';
  for (const l of links.slice(0, 25)) {
    if (l.kind !== kind) {
      kind = l.kind;
      lines.push(`\n**${LINK_LABELS[l.kind]}**`);
    }
    const label = plain(clip(l.text || l.domain, 40));
    lines.push(`• [${label}](${l.url}) · ${l.domain}${l.suspicious ? '  ⚠️ 显示的地址和实际跳转不一致，可能是钓鱼链接' : ''}`);
  }
  const top = links.filter((l) => !l.suspicious && l.kind !== 'unsubscribe' && l.kind !== 'other').slice(0, 3);
  return {
    tone: 'info',
    title: `邮件里的链接（${links.length}）`,
    text: `${plain(clip(m.subject, 60))}\n${lines.join('\n')}${links.length > 25 ? `\n…还有 ${links.length - 25} 个` : ''}`,
    buttons: top.length ? [top.map((l) => ({ text: clip(l.text || LINK_LABELS[l.kind], 20), url: l.url }))] : undefined,
  };
}

export function taskButtons(id: number): Button[][] {
  return [
    [{ text: '✅ 完成', action: `t:d:${id}` }, { text: '跳过', action: `t:k:${id}` }],
    [
      { text: '10 分钟后', action: `t:s:${id}:10` },
      { text: '1 小时后', action: `t:s:${id}:60` },
      { text: '明天', action: `t:s:${id}:1440` },
    ],
  ];
}

export function taskCard(user: User, task: TaskRow, nth = 0): Card {
  const when = task.due_at ? `\n🕐 ${formatWhen(task.due_at, user.timezone)}` : '';
  const notes = task.notes ? `\n${plain(clip(task.notes, 300))}` : '';
  return {
    tone: 'task',
    title: nth > 0 ? `🔔 还没完成（第 ${nth + 1} 次提醒）` : '⏰ 提醒',
    text: `**${plain(task.title)}**${when}${notes}`,
    buttons: taskButtons(task.id),
  };
}

export async function digestCard(user: User): Promise<Card> {
  const tasks = await dueToday(user.id, user.timezone);
  const unread = (await one<{ n: number }>(
    `SELECT COALESCE(SUM(f.unread), 0) AS n FROM folders f JOIN accounts a ON a.id = f.account_id
     WHERE a.user_id = ? AND f.role = 'inbox'`,
    [user.id],
  ))!.n;
  const now = DateTime.now().setZone(user.timezone);
  const lines = tasks.map((t) => {
    const due = DateTime.fromJSDate(t.due_at!, { zone: user.timezone });
    const overdue = due < now.startOf('day');
    return `${overdue ? '⚠️' : '•'} ${overdue ? due.toFormat('M/d') : due.toFormat('HH:mm')}  ${plain(clip(t.title, 80))}`;
  });
  return {
    tone: 'info',
    title: `☀️ 早上好，${user.name}`,
    text:
      `${now.setLocale('zh-CN').toFormat('M月d日 cccc')}\n\n**今日计划（${tasks.length}）**\n` +
      `${lines.length ? lines.join('\n') : '今天没有安排，轻松一点。'}\n\n📬 收件箱未读 ${unread} 封`,
    buttons: [[{ text: '查看未读邮件', action: 'inbox' }]],
  };
}

/** /inbox：最近的未读邮件，每封一行，点按钮阅读 */
export async function inboxCard(user: User): Promise<Card> {
  const rows = await query<{ id: number; from_name: string; from_addr: string; subject: string; date: Date; code: string | null }>(
    `SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, m.code FROM messages m JOIN folders f ON f.id = m.folder_id
     WHERE m.user_id = ? AND f.role = 'inbox' AND m.seen = 0 AND m.snoozed_until IS NULL ORDER BY m.date DESC LIMIT 8`,
    [user.id],
  );
  if (!rows.length) return { tone: 'info', text: '收件箱没有未读邮件 🎉' };
  return {
    tone: 'mail',
    title: `未读邮件（最近 ${rows.length} 封）`,
    text: rows
      .map(
        (r, i) =>
          `${i + 1}. **${plain(clip(r.from_name || r.from_addr, 24))}** · ${plain(clip(r.subject || '(无主题)', 50))}` +
          `${r.code ? `  \`${r.code}\`` : ''}  ${DateTime.fromJSDate(new Date(r.date), { zone: user.timezone }).toFormat('M/d HH:mm')}`,
      )
      .join('\n'),
    buttons: chunk(
      rows.map((r, i) => ({ text: `读 ${i + 1}`, action: `m:f:${r.id}` })),
      4,
    ),
  };
}

export function chunk<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export const helpText = () => `我是 ${siteConfig().name} 助手，可以：

• 新邮件到达时推送，直接阅读全文、看附件和链接、翻译、摘要
• 计划到点提醒，点按钮完成或稍后再提醒
• 开启 AI 后直接用自然语言问我，例如"这周有哪些账单要付""帮我回复老板说明天交"

命令：
/inbox 未读邮件
/today 今日计划
/add 明天9点 交报告 —— 快速新建计划
/reset 开始新的 AI 对话
/unlink 解除绑定`;
