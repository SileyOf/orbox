import { DateTime } from 'luxon';
import { getUser } from '../auth.js';
import type { User } from '../auth.js';
import { config } from '../config.js';
import { one } from '../db.js';
import { emit } from '../events.js';
import type { AccountRow } from '../mail/manager.js';
import { formatWhen } from '../tasks/parse.js';
import type { TaskRow } from '../tasks/service.js';
import { pushChannels } from './channels.js';
import { sendMailCard, sendTaskReminder } from './telegram.js';
import type { MailCard } from './telegram.js';

// 通知的统一入口：在这里应用规则（屏蔽、VIP、免打扰、验证码），再分发到各个通道

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

const loadCard = (messageId: number) =>
  one<MailCard>('SELECT id, subject, from_name, from_addr, snippet, code FROM messages WHERE id = ?', [messageId]);

export async function dispatchNewMail(account: AccountRow, messageId: number): Promise<void> {
  const m = await loadCard(messageId);
  const user = await getUser(account.user_id);
  if (!m || !user) return;
  const sender = m.from_name || m.from_addr;
  // 打开着的网页总是实时提示，不受推送规则影响
  emit(user.id, { type: 'new-mail', id: m.id, from: sender, subject: m.subject, code: m.code });

  const s = user.settings;
  if (!account.notify || !s.notifyMail || matchesSender(s.mutedSenders, m.from_addr)) return;
  const vip = matchesSender(s.vipSenders, m.from_addr);
  // 验证码是用户自己刚触发的，VIP 是用户点名要看的，这两类不受免打扰限制
  if (inQuietHours(user) && !vip && !(m.code && s.codeAlways)) return;

  await Promise.all([
    sendMailCard(user, account.name, m, { vip }).catch((e) => console.error('[telegram]', e.message)),
    pushChannels(user, {
      title: m.code ? `验证码 ${m.code}` : `${vip ? '⭐ ' : ''}${sender}`,
      body: m.code ? `${sender} · ${m.subject}` : `${m.subject || '(无主题)'}\n${m.snippet.slice(0, 160)}`,
      url: mailUrl(m.id),
      code: m.code,
    }),
  ]);
}

/** 稍后处理的邮件到点重新出现 */
export async function dispatchResurfaced(userId: number, accountName: string, messageId: number): Promise<void> {
  const m = await loadCard(messageId);
  const user = await getUser(userId);
  if (!m || !user) return;
  await Promise.all([
    sendMailCard(user, accountName, { ...m, code: null }, { resurfaced: true }).catch((e) => console.error('[telegram]', e.message)),
    pushChannels(user, { title: '⏰ 稍后处理的邮件', body: `${m.from_name || m.from_addr}\n${m.subject}`, url: mailUrl(m.id) }),
  ]);
}

export async function dispatchTaskReminder(task: TaskRow, nth: number): Promise<void> {
  const user = await getUser(task.user_id);
  if (!user) return;
  await Promise.all([
    sendTaskReminder(user, task, nth).catch((e) => console.error('[telegram]', e.message)),
    pushChannels(user, {
      title: nth > 0 ? `🔔 还没完成：${task.title}` : `⏰ ${task.title}`,
      body: [task.due_at && formatWhen(task.due_at, user.timezone), task.notes].filter(Boolean).join('\n') || '计划提醒',
      url: config.publicUrl.startsWith('https://') ? `${config.publicUrl}/planner` : undefined,
    }),
  ]);
}
