import { DateTime } from 'luxon';
import { getUser } from '../auth.js';
import type { User } from '../auth.js';
import { resolveTask } from '../ai/tasks.js';
import { NOTIFY_LABELS, localLabel, triage } from '../ai/triage.js';
import type { TriageResult } from '../ai/triage.js';
import { loadMail, mailCard, taskCard } from '../bots/cards.js';
import type { AiButtons } from '../bots/cards.js';
import { sendToUser } from '../bots/hub.js';
import { config } from '../config.js';
import { emit } from '../events.js';
import type { AccountRow } from '../mail/manager.js';
import { primaryLink } from '../mail/links.js';
import { formatWhen } from '../tasks/parse.js';
import type { TaskRow } from '../tasks/service.js';
import { pushChannels } from './channels.js';

// 通知的统一入口：先分拣（AI 或本地规则），再应用规则（屏蔽、VIP、免打扰、只推重要），最后按每个渠道的事件设置分发

function inQuietHours(user: User): boolean {
  const { quietStart, quietEnd } = user.settings;
  if (quietStart === quietEnd) return false;
  const now = DateTime.now().setZone(user.timezone).toFormat('HH:mm');
  return quietStart < quietEnd ? now >= quietStart && now < quietEnd : now >= quietStart || now < quietEnd;
}

/** 规则可以写完整地址（a@b.com）或域名（b.com / @b.com） */
export function matchesSender(rules: string[], address: string): boolean {
  const addr = address.toLowerCase();
  const domain = addr.split('@')[1] || '';
  return rules.some((raw) => {
    const rule = raw.trim().toLowerCase().replace(/^@/, '');
    if (!rule) return false;
    return rule.includes('@') ? rule === addr : domain === rule || domain.endsWith(`.${rule}`);
  });
}

const mailUrl = (id: number) => (config.publicUrl.startsWith('https://') ? `${config.publicUrl}/mail?open=${id}` : undefined);

/** AI 分拣最多等这么久，超时就按本地规则继续推送，不让通知被模型拖慢 */
const TRIAGE_BUDGET = 8_000;

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

export async function aiButtons(user: User): Promise<AiButtons> {
  return { summary: !!(await resolveTask(user, 'summary')), translate: !!(await resolveTask(user, 'translate')) };
}

export async function dispatchNewMail(account: AccountRow, messageId: number): Promise<void> {
  const user = await getUser(account.user_id);
  if (!user) return;
  const tri: TriageResult | null = await withTimeout(triage(user, messageId), TRIAGE_BUDGET).catch(() => null);
  // 分拣可能补上了验证码、整理了链接，重新读一次
  const m = await loadMail(user.id, messageId);
  if (!m) return;
  const sender = m.from_name || m.from_addr;
  // 打开着的网页总是实时提示，不受推送规则影响
  emit(user.id, { type: 'new-mail', id: m.id, from: sender, subject: m.subject, code: m.code });

  const s = user.settings;
  if (!account.notify || !s.notifyMail || matchesSender(s.mutedSenders, m.from_addr)) return;
  const vip = matchesSender(s.vipSenders, m.from_addr);
  // 验证码是用户自己刚触发的，VIP 是用户点名要看的，这两类不受免打扰和过滤限制
  const always = vip || !!(m.code && s.codeAlways);
  if (inQuietHours(user) && !always) return;
  if (s.importantOnly && !always) {
    const label = tri?.label ?? localLabel(m);
    if (!NOTIFY_LABELS.includes(label)) return;
  }

  const kind = m.code ? 'code' : 'mail';
  const key = primaryLink(m.links);
  await Promise.all([
    sendToUser(user.id, mailCard(user, m, { vip, ai: await aiButtons(user) }), kind),
    pushChannels(
      user,
      {
        title: m.code ? `验证码 ${m.code}` : `${vip ? '⭐ ' : ''}${sender}`,
        body: m.code ? `${sender} · ${m.subject}` : `${m.subject || '(无主题)'}\n${m.snippet.slice(0, 160)}`,
        url: key?.url || mailUrl(m.id),
        code: m.code,
      },
      kind,
    ),
  ]);
}

/** 稍后处理的邮件到点重新出现 */
export async function dispatchResurfaced(userId: number, messageId: number): Promise<void> {
  const user = await getUser(userId);
  const m = user && (await loadMail(userId, messageId));
  if (!user || !m) return;
  await Promise.all([
    sendToUser(user.id, mailCard(user, { ...m, code: null }, { resurfaced: true, ai: await aiButtons(user) }), 'snooze'),
    pushChannels(user, { title: '⏰ 稍后处理的邮件', body: `${m.from_name || m.from_addr}\n${m.subject}`, url: mailUrl(m.id) }, 'snooze'),
  ]);
}

export async function dispatchTaskReminder(task: TaskRow, nth: number): Promise<void> {
  const user = await getUser(task.user_id);
  if (!user) return;
  await Promise.all([
    sendToUser(user.id, taskCard(user, task, nth), 'task'),
    pushChannels(
      user,
      {
        title: nth > 0 ? `🔔 还没完成：${task.title}` : `⏰ ${task.title}`,
        body: [task.due_at && formatWhen(task.due_at, user.timezone), task.notes].filter(Boolean).join('\n') || '计划提醒',
        url: config.publicUrl.startsWith('https://') ? `${config.publicUrl}/planner` : undefined,
      },
      'task',
    ),
  ]);
}
