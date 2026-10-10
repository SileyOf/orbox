export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  accent: string;
  notifyMail: boolean;
  quietStart: string;
  quietEnd: string;
  digestTime: string;
  nagInterval: number;
  blockRemoteImages: boolean;
}

export interface User {
  id: number;
  email: string;
  name: string;
  isAdmin: boolean;
  timezone: string;
  settings: UserSettings;
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
  bodyError: string | null;
}

export interface RepeatRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  weekdays?: number[];
}

export interface Task {
  id: number;
  title: string;
  notes: string | null;
  due_at: string | null;
  remind_before: number;
  repeat_rule: RepeatRule | null;
  priority: number;
  status: 'open' | 'done';
  completed_at: string | null;
  next_remind_at: string | null;
  nag_interval: number;
  mail_subject: string | null;
  mail_id: number | null;
}

export interface TaskInput {
  title: string;
  notes?: string | null;
  dueAt?: string | null;
  remindBefore?: number;
  repeat?: RepeatRule | null;
  priority?: number;
  nagInterval?: number;
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
