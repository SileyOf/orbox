export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  accent: string;
  surface: 'clear' | 'solid';
  selection: string;
  followSite: boolean;
  motion: boolean;
  trip?: { name: string; start: string };
  notifyMail: boolean;
  quietStart: string;
  quietEnd: string;
  digestTime: string;
  nagInterval: number;
  blockRemoteImages: boolean;
  vipSenders: string[];
  mutedSenders: string[];
  codeAlways: boolean;
  channels: { bark: string; ntfy: string; webhook: string };
  threads: boolean;
  translateTo: string;
  importantOnly: boolean;
  aiTasks?: Partial<Record<AiTaskName, AiTaskSetting>>;
  routing?: Record<string, Partial<Record<EventKind, boolean>>>;
}

export type EventKind = 'mail' | 'code' | 'task' | 'digest' | 'snooze';

export type AiTaskName = 'filter' | 'code' | 'links' | 'summary' | 'translate' | 'todos' | 'reply' | 'assistant';

export interface AiTaskSetting {
  enabled: boolean;
  providerId: number | null;
  model: string;
}

export interface AiProvider {
  id: number;
  name: string;
  kind: 'anthropic' | 'openai';
  baseUrl: string;
  defaultModel: string;
  models: string[];
  shared: boolean;
}

export interface AiInfo {
  providers: AiProvider[];
  tasks: Record<AiTaskName, AiTaskSetting>;
  meta: Record<AiTaskName, { label: string; hint: string; tier: 'fast' | 'strong'; local: string | null }>;
  active: Record<AiTaskName, boolean>;
  shareAi: boolean;
}

export interface SiteInfo {
  name: string;
  subtitle: string;
  loginText: string;
  footer: string;
  accent: string;
  theme: 'system' | 'light' | 'dark';
  registration: 'open' | 'invite' | 'closed';
  hasLogo: boolean;
}

export interface User {
  id: number;
  email: string;
  name: string;
  isAdmin: boolean;
  timezone: string;
  settings: UserSettings;
  /** 只有管理员有：后台页面的地址 */
  adminPath?: string;
  /** 管理员给这个用户开放的功能 */
  perms: { maxAccounts: number; sharedAi: boolean; ownAi: boolean; bots: boolean; mcp: boolean; privateHosts: boolean };
}

export interface Folder {
  id: number;
  account_id: number;
  path: string;
  name: string;
  role: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | null;
  total: number;
  unread: number;
}

export interface Account {
  id: number;
  name: string;
  email: string;
  from_name: string;
  color: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  username: string;
  auth_type: 'password' | 'oauth';
  ai_enabled: number;
  sieve_port?: number;
  signature: string | null;
  notify: number;
  save_sent: number;
  sync_state: 'idle' | 'ok' | 'syncing' | 'error';
  last_error: string | null;
  last_sync_at: string | null;
  folders: Folder[];
}

export interface Address {
  name: string;
  address: string;
}

export interface MessageItem {
  id: number;
  account_id: number;
  folder_id: number;
  subject: string;
  from_name: string;
  from_addr: string;
  to: Address[];
  date: string;
  seen: number;
  flagged: number;
  answered: number;
  has_attachments: number;
  snippet: string;
  code: string | null;
  snoozed_until: string | null;
  thread_id: string | null;
  /** 会话视图下才有 */
  thread_count?: number;
  thread_unread?: number;
  folder_role: Folder['role'];
  folder_name: string;
}

export interface Attachment {
  i: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageFull extends MessageItem {
  message_id: string | null;
  cc: Address[];
  reply_to: string | null;
  size: number;
  body_text: string | null;
  body_html: string | null;
  attachments: Attachment[];
  links: LinkInfo[] | null;
  bodyError: string | null;
}

export type LinkKind = 'billing' | 'verify' | 'account' | 'tracking' | 'download' | 'unsubscribe' | 'other';

export interface LinkInfo {
  url: string;
  text: string;
  domain: string;
  kind: LinkKind;
  suspicious?: boolean;
  label?: string;
  ai?: boolean;
}

export const LINK_LABELS: Record<LinkKind, string> = {
  billing: '续费 / 付款',
  verify: '验证 / 确认',
  account: '账户 / 登录',
  tracking: '物流',
  download: '下载 / 查看',
  unsubscribe: '退订',
  other: '其他',
};

export interface TodoSuggestion {
  title: string;
  due: string | null;
  notes: string;
}

export interface PendingMail {
  id: string;
  summary: string;
}

export interface RepeatRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  weekdays?: number[];
}

export type TaskKind = 'task' | 'bill' | 'birthday';

export interface TaskMeta {
  amount?: number;
  currency?: string;
  payUrl?: string;
  payMethod?: string;
  autoNote?: boolean;
  person?: string;
  relation?: string;
  birthYear?: number | null;
  lunar?: { month: number; day: number } | null;
}

export interface Task {
  id: number;
  kind: TaskKind;
  meta: TaskMeta | null;
  title: string;
  notes: string | null;
  due_at: string | null;
  remind_before: number;
  repeat_rule: RepeatRule | null;
  priority: number;
  tags: string[] | null;
  status: 'open' | 'done';
  completed_at: string | null;
  next_remind_at: string | null;
  nag_interval: number;
  mail_subject: string | null;
  mail_id: number | null;
}

export interface TaskInput {
  kind?: TaskKind;
  meta?: TaskMeta | null;
  title: string;
  notes?: string | null;
  dueAt?: string | null;
  remindBefore?: number;
  repeat?: RepeatRule | null;
  priority?: number;
  tags?: string[];
  nagInterval?: number;
}

export interface OutboxItem {
  id: number;
  account_id: number;
  send_at: string;
  subject: string;
  recipients: string;
  status: 'pending' | 'sending' | 'failed';
  error: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method || (init.body !== undefined || init.form ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `请求失败（${res.status}）`, res.status);
  return data as T;
}

export const ROLE_NAMES: Record<string, string> = {
  inbox: '收件箱',
  sent: '已发送',
  drafts: '草稿',
  archive: '归档',
  junk: '垃圾邮件',
  trash: '废纸篓',
};

export const folderLabel = (f: Pick<Folder, 'role' | 'name'>) => (f.role && ROLE_NAMES[f.role]) || f.name;

export interface Note {
  id: number;
  day: string;
  content: string;
  amount: string | null;
  currency: string;
  category: string;
  tags: string[] | null;
  reimbursable: number;
  reimbursed: number;
  source: string;
  created_at: string;
}

export interface NoteSummary {
  count: number;
  spent: number;
  byCurrency: Record<string, { total: number; reimbursable: number; pending: number; byCategory: Record<string, number> }>;
  byTag: Record<string, Record<string, number>>;
}
