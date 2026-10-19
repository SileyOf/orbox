import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, FetchQueryObject, MessageAddressObject, MessageStructureObject } from 'imapflow';
import nodemailer from 'nodemailer';
import { decrypt } from '../crypto.js';
import { exec, one, query } from '../db.js';
import { emit } from '../events.js';
import { forgetAccessToken, getAccessToken } from './oauth.js';
import { extractCode } from './code.js';
import { extractLinks } from './links.js';
import { parseRefs, subjectKey } from './thread-keys.js';
import { assignThreads } from './threads.js';
import { htmlToPlain, makeSnippet, parseSource, structureHasAttachments } from './parse.js';
import type { ParsedBody } from './parse.js';

export interface AccountRow {
  id: number;
  user_id: number;
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
  password_enc: string;
  oauth_refresh_enc: string | null;
  signature: string | null;
  notify: number;
  save_sent: number;
  ai_enabled: number;
  sieve_port: number;
}

export interface FolderRow {
  id: number;
  account_id: number;
  path: string;
  name: string;
  role: string | null;
  uid_validity: string | number | null;
  last_uid: number;
  highest_modseq: string | number | null;
  total: number;
  unread: number;
}

export interface ConnParams {
  imap_host: string;
  imap_port: number;
  imap_secure: number | boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number | boolean;
  username: string;
  /** 密码和 OAuth 访问令牌二选一 */
  password?: string;
  accessToken?: string;
}

const SYNC_INTERVAL = 5 * 60_000;
const ENVELOPE_CHUNK = 200;
const PREFETCH_PER_SYNC = 30;
const MAX_NOTIFY_PER_SYNC = 8;
/** 快速通道只取正文开头这么多字节，足够生成摘要和提取验证码 */
const PEEK_BYTES = 128 * 1024;

const ENVELOPE_COLUMNS = `user_id, account_id, folder_id, uid, message_id, in_reply_to, refs, subject, subject_key,
  from_name, from_addr, to_json, cc_json, reply_to, date, size, seen, flagged, answered, has_attachments, notified`;

const ENVELOPE_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  size: true,
  internalDate: true,
  headers: ['references'],
};

const recountFolder = (folderId: number) =>
  exec(
    `UPDATE folders f SET
       total = (SELECT COUNT(*) FROM messages WHERE folder_id = f.id),
       unread = (SELECT COUNT(*) FROM messages WHERE folder_id = f.id AND seen = 0)
     WHERE id = ?`,
    [folderId],
  );

const ROLES: Record<string, string> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
};

type NewMailHandler = (account: AccountRow, messageId: number) => Promise<void>;
let onNewMail: NewMailHandler = async () => {};
export const setNewMailHandler = (fn: NewMailHandler) => void (onNewMail = fn);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: any) => String(e?.responseText || e?.message || e).slice(0, 500);

function imapClient(p: ConnParams, autoIdleDelay?: number): ImapFlow {
  const client = new ImapFlow({
    autoIdleDelay,
    host: p.imap_host,
    port: p.imap_port,
    secure: !!p.imap_secure,
    auth: p.accessToken ? { user: p.username, accessToken: p.accessToken } : { user: p.username, pass: p.password },
    logger: false,
    clientInfo: { name: 'Orbox' },
  });
  // ImapFlow 会把连接错误作为事件抛出，不监听会直接让进程崩溃
  client.on('error', () => {});
  return client;
}

export function smtpTransport(p: ConnParams) {
  return nodemailer.createTransport({
    host: p.smtp_host,
    port: p.smtp_port,
    secure: !!p.smtp_secure,
    auth: p.accessToken
      ? { type: 'OAuth2', user: p.username, accessToken: p.accessToken }
      : { user: p.username, pass: p.password },
    connectionTimeout: 15_000,
  });
}

export async function connParams(a: AccountRow): Promise<ConnParams> {
  const { imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username } = a;
  const base = { imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username };
  return a.auth_type === 'oauth'
    ? { ...base, accessToken: await getAccessToken(a) }
    : { ...base, password: decrypt(a.password_enc) };
}

/** 保存邮箱前先验证 IMAP 和 SMTP 都能登录 */
export async function testConnection(p: ConnParams): Promise<void> {
  const client = imapClient(p);
  try {
    await client.connect();
    await client.logout();
  } catch (e) {
    client.close();
    throw new Error(`IMAP 连接失败：${errMsg(e)}`);
  }
  try {
    await smtpTransport(p).verify();
  } catch (e) {
    throw new Error(`SMTP 连接失败：${errMsg(e)}`);
  }
}

const addrList = (list?: MessageAddressObject[]) =>
  JSON.stringify((list || []).map((a) => ({ name: a.name || '', address: a.address || '' })));

function toDate(...candidates: (Date | string | undefined)[]): Date {
  for (const c of candidates) {
    const d = c instanceof Date ? c : c ? new Date(c) : null;
    if (d && !isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** 在 BODYSTRUCTURE 里找正文部分（优先纯文本），跳过附件 */
function findTextPart(node: MessageStructureObject | undefined, want: string): string | null {
  if (!node) return null;
  if (node.disposition?.toLowerCase() === 'attachment') return null;
  if (node.type === want) return node.part || '1';
  for (const child of node.childNodes || []) {
    const hit = findTextPart(child, want);
    if (hit) return hit;
  }
  return null;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class AccountWorker {
  private stopped = false;
  private idle?: ImapFlow;
  private ops?: ImapFlow;
  private opsConnecting?: Promise<ImapFlow>;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private inboxKick?: NodeJS.Timeout;
  private fastBusy = false;
  private fastAgain = false;

  constructor(public account: AccountRow) {}

  start() {
    void this.runIdle();
    this.timer = setInterval(() => this.requestSync(), SYNC_INTERVAL);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.inboxKick);
    this.idle?.close();
    this.ops?.close();
  }

  /** 同步任务串行执行，避免同一文件夹被并发对账 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch((e) => console.error(`[sync ${this.account.email}]`, errMsg(e)));
    return run;
  }

  requestSync() {
    return this.enqueue(() => this.syncAll());
  }

  private async setState(state: 'ok' | 'syncing' | 'error', error: string | null = null) {
    await exec(
      `UPDATE accounts SET sync_state = ?, last_error = ?,
         last_sync_at = IF(? = 'ok', UTC_TIMESTAMP(), last_sync_at) WHERE id = ?`,
      [state, error, state, this.account.id],
    );
    emit(this.account.user_id, { type: 'accounts' });
  }

  private async client(): Promise<ImapFlow> {
    if (this.ops?.usable) return this.ops;
    this.opsConnecting ??= (async () => {
      const c = imapClient(await connParams(this.account));
      c.on('close', () => {
        if (this.ops === c) this.ops = undefined;
      });
      await c.connect();
      return (this.ops = c);
    })().finally(() => (this.opsConnecting = undefined));
    return this.opsConnecting;
  }

  private async withFolder<T>(path: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = await this.client();
    const lock = await c.getMailboxLock(path);
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  }

  /** 专用长连接挂在 INBOX 上 IDLE，只负责感知变化并触发同步 */
  private async runIdle() {
    let backoff = 2_000;
    while (!this.stopped) {
      let c: ImapFlow | undefined;
      try {
        // 取令牌也可能失败（授权失效、网络不通），和连接失败一样走退避重试
        // 这条连接上偶尔也会发命令（见 fastInbox），命令结束后要尽快回到 IDLE，
        // 库默认要等 15 秒，期间到达的邮件不会被感知
        const client = (c = this.idle = imapClient(await connParams(this.account), 500));
        const closed = new Promise<void>((res) => client.once('close', () => res()));
        await c.connect();
        await c.mailboxOpen('INBOX');
        backoff = 2_000;
        const kick = () => {
          clearTimeout(this.inboxKick);
          this.inboxKick = setTimeout(() => this.enqueue(() => this.syncInbox()), 400);
        };
        c.on('exists', () => void this.fastInbox(client, kick));
        c.on('flags', kick);
        c.on('expunge', kick);
        await this.requestSync();
        await closed;
      } catch (e) {
        c?.close();
        // 被服务器拒绝时丢掉缓存的令牌，下次重连重新换取
        if (this.account.auth_type === 'oauth') forgetAccessToken(this.account.id);
        if (!this.stopped) await this.setState('error', errMsg(e));
      }
      if (this.stopped) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10 * 60_000);
    }
  }

  /**
   * 新邮件快速通道：不排同步队列，直接在 IDLE 连接上取新邮件的信封和正文开头，
   * 入库后立刻通知。完整对账和正文缓存随后由常规同步补上。
   */
  private async fastInbox(c: ImapFlow, thenSync: () => void) {
    if (this.fastBusy) {
      this.fastAgain = true;
      return;
    }
    this.fastBusy = true;
    const { id: accountId, user_id: userId } = this.account;
    try {
      do {
        this.fastAgain = false;
        const inbox = await one<FolderRow & { max_uid: number | null }>(
          `SELECT f.*, (SELECT MAX(uid) FROM messages WHERE folder_id = f.id) AS max_uid
           FROM folders f WHERE f.account_id = ? AND f.role = 'inbox'`,
          [accountId],
        );
        // 首次全量同步还没完成时交给常规同步，避免把历史邮件当成新邮件
        if (!inbox || inbox.uid_validity == null) break;
        const last = Math.max(inbox.last_uid, inbox.max_uid || 0);
        const fresh = (
          await c.fetchAll(
            `${last + 1}:*`,
            ENVELOPE_QUERY,
            { uid: true },
          )
        ).filter((m) => m.uid > last);
        if (!fresh.length) continue;
        await exec(`INSERT IGNORE INTO messages (${ENVELOPE_COLUMNS}) VALUES ?`, [
          fresh.map((m) => this.envelopeRow(inbox.id, m, m.flags?.has('\\Seen') ? 1 : 0)),
        ]);
        await assignThreads(accountId);
        await exec('UPDATE folders SET last_uid = GREATEST(last_uid, ?) WHERE id = ?', [
          Math.max(...fresh.map((m) => m.uid)),
          inbox.id,
        ]);
        for (const m of fresh.slice(-MAX_NOTIFY_PER_SYNC)) {
          if (m.flags?.has('\\Seen')) continue;
          const row = await one<{ id: number }>('SELECT id FROM messages WHERE folder_id = ? AND uid = ?', [inbox.id, m.uid]);
          if (!row) continue;
          const peek = await this.peekText(c, m).catch(() => null);
          if (peek?.text) {
            await exec('UPDATE messages SET snippet = ?, code = ?, links = ? WHERE id = ? AND body_fetched = 0', [
              makeSnippet(peek.text),
              extractCode(m.envelope?.subject || '', peek.text),
              JSON.stringify(extractLinks(peek.html, peek.html ? null : peek.text)),
              row.id,
            ]);
          }
          await this.announce(row.id);
        }
        await recountFolder(inbox.id);
        emit(userId, { type: 'mail', accountId, folderId: inbox.id });
      } while (this.fastAgain && !this.stopped);
    } catch (e) {
      console.error(`[fast ${this.account.email}]`, errMsg(e));
    } finally {
      this.fastBusy = false;
      thenSync();
    }
  }

  /**
   * 只下载正文部分的开头。有 HTML 版本时取 HTML（链接的文字说明只在 HTML 里有），
   * 否则取纯文本。
   */
  private async peekText(c: ImapFlow, m: FetchMessageObject): Promise<{ text: string; html: string | null }> {
    const htmlPart = findTextPart(m.bodyStructure, 'text/html');
    const part = htmlPart || findTextPart(m.bodyStructure, 'text/plain');
    if (!part) return { text: '', html: null };
    const dl = await c.download(String(m.uid), part, { uid: true, maxBytes: PEEK_BYTES });
    if (!dl.content) return { text: '', html: null };
    const raw = (await readAll(dl.content)).toString('utf8');
    return htmlPart ? { text: htmlToPlain(raw), html: raw } : { text: raw, html: null };
  }

  /** 用带条件的更新认领通知权，快速通道和常规同步谁先到谁发，保证每封只通知一次 */
  private async announce(messageId: number) {
    const claimed = await exec('UPDATE messages SET notified = 1 WHERE id = ? AND notified = 0', [messageId]);
    if (claimed.affectedRows) {
      await onNewMail(this.account, messageId).catch((e) => console.error('[notify]', errMsg(e)));
    }
  }

  private folders() {
    return query<FolderRow>('SELECT * FROM folders WHERE account_id = ?', [this.account.id]);
  }

  private async syncInbox() {
    const inbox = (await this.folders()).find((f) => f.role === 'inbox');
    if (inbox) await this.syncFolder(inbox);
  }

  private async syncAll() {
    await this.setState('syncing');
    try {
      const c = await this.client();
      const listed = (await c.list()).filter((m) => !m.flags.has('\\Noselect'));
      const known = new Map((await this.folders()).map((f) => [f.path, f]));
      for (const m of listed) {
        const role = m.path.toUpperCase() === 'INBOX' ? 'inbox' : (m.specialUse && ROLES[m.specialUse]) || null;
        await exec(
          `INSERT INTO folders (account_id, path, name, role) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role)`,
          [this.account.id, m.path, m.name, role],
        );
        known.delete(m.path);
      }
      for (const gone of known.values()) await exec('DELETE FROM folders WHERE id = ?', [gone.id]);

      const order = ['inbox', 'sent', 'drafts', 'archive', null, 'junk', 'trash'];
      const folders = (await this.folders()).sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
      for (const f of folders) {
        if (this.stopped) return;
        await this.syncFolder(f);
      }
      // 升级前就存在的邮件还没有线程，借每轮同步的尾巴慢慢补上
      await assignThreads(this.account.id);
      await this.setState('ok');
    } catch (e) {
      await this.setState('error', errMsg(e));
      throw e;
    }
  }

  /**
   * 以服务器的 UID+标志全量清单为准与本地对账：删掉已不存在的、更新标志、
   * 再把缺失的信封从新到旧分块补齐。中断后下次会从断点继续。
   */
  private async syncFolder(folder: FolderRow) {
    const { id: accountId, user_id: userId } = this.account;
    let initial = folder.uid_validity == null;

    const head = await this.withFolder(folder.path, async (c) => {
      const mb = c.mailbox;
      if (!mb) throw new Error(`无法打开文件夹 ${folder.path}`);
      const validity = mb.uidValidity.toString();
      const modseq = mb.highestModseq?.toString() ?? null;
      if (!initial && String(folder.uid_validity) !== validity) {
        await exec('DELETE FROM messages WHERE folder_id = ?', [folder.id]);
        initial = true;
      }
      const unchanged =
        !initial && modseq !== null && modseq === String(folder.highest_modseq) && mb.exists === folder.total;
      if (unchanged) return null;
      const remote = new Map<number, Set<string>>();
      if (mb.exists > 0) {
        for await (const m of c.fetch('1:*', { uid: true, flags: true })) remote.set(m.uid, m.flags || new Set());
      }
      return { validity, modseq, remote };
    });

    if (head) {
      const { remote } = head;
      const local = await query<{ id: number; uid: number; seen: number; flagged: number; answered: number }>(
        'SELECT id, uid, seen, flagged, answered FROM messages WHERE folder_id = ?',
        [folder.id],
      );
      const gone: number[] = [];
      for (const row of local) {
        const flags = remote.get(row.uid);
        if (!flags) {
          gone.push(row.id);
          continue;
        }
        remote.delete(row.uid);
        const seen = +flags.has('\\Seen');
        const flagged = +flags.has('\\Flagged');
        const answered = +flags.has('\\Answered');
        if (seen !== row.seen || flagged !== row.flagged || answered !== row.answered) {
          await exec('UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE id = ?', [
            seen,
            flagged,
            answered,
            row.id,
          ]);
        }
      }
      for (let i = 0; i < gone.length; i += 500) {
        await exec('DELETE FROM messages WHERE id IN (?)', [gone.slice(i, i + 500)]);
      }

      const missing = [...remote.keys()].sort((a, b) => b - a);
      for (let i = 0; i < missing.length; i += ENVELOPE_CHUNK) {
        if (this.stopped) return;
        const uids = missing.slice(i, i + ENVELOPE_CHUNK);
        const fetched = await this.withFolder(folder.path, (c) =>
          c.fetchAll(
            uids.join(','),
            ENVELOPE_QUERY,
            { uid: true },
          ),
        );
        if (fetched.length) {
          // 只有非首次同步时收件箱里新出现的未读邮件才需要通知
          const pending = (m: FetchMessageObject) =>
            !initial && folder.role === 'inbox' && !m.flags?.has('\\Seen') ? 0 : 1;
          await exec(`INSERT IGNORE INTO messages (${ENVELOPE_COLUMNS}) VALUES ?`, [
            fetched.map((m) => this.envelopeRow(folder.id, m, pending(m))),
          ]);
        }
        // 大邮箱首次同步时让列表边同步边出现
        if (missing.length > ENVELOPE_CHUNK) emit(userId, { type: 'mail', accountId, folderId: folder.id });
      }

      if (missing.length) await assignThreads(accountId);
      const maxUid = (await one<{ m: number | null }>('SELECT MAX(uid) AS m FROM messages WHERE folder_id = ?', [
        folder.id,
      ]))!.m;
      await exec(
        `UPDATE folders f SET uid_validity = ?, highest_modseq = ?, last_uid = GREATEST(last_uid, ?),
           total = (SELECT COUNT(*) FROM messages WHERE folder_id = f.id),
           unread = (SELECT COUNT(*) FROM messages WHERE folder_id = f.id AND seen = 0)
         WHERE id = ?`,
        [head.validity, head.modseq, maxUid || 0, folder.id],
      );
      emit(userId, { type: 'mail', accountId, folderId: folder.id });

      if (folder.role === 'inbox') {
        const fresh = await query<{ id: number }>(
          'SELECT id FROM messages WHERE folder_id = ? AND notified = 0 ORDER BY uid DESC LIMIT ?',
          [folder.id, MAX_NOTIFY_PER_SYNC],
        );
        for (const { id } of fresh.reverse()) {
          await this.loadBody(id).catch(() => {});
          await this.announce(id);
        }
        // 一次涌入太多（比如停机很久之后）时只通知最新的几封，其余不再补发
        await exec('UPDATE messages SET notified = 1 WHERE folder_id = ? AND notified = 0', [folder.id]);
      }
    }

    // 每轮顺手缓存一批最新邮件的正文，摘要和全文搜索靠它
    const pending = await query<{ id: number }>(
      'SELECT id FROM messages WHERE folder_id = ? AND body_fetched = 0 ORDER BY date DESC LIMIT ?',
      [folder.id, PREFETCH_PER_SYNC],
    );
    for (const { id } of pending) {
      if (this.stopped) return;
      await this.loadBody(id).catch(() => {});
    }
    if (pending.length) emit(userId, { type: 'mail', accountId, folderId: folder.id });
  }

  private envelopeRow(folderId: number, m: FetchMessageObject, notified: number) {
    const env = m.envelope || {};
    const from = env.from?.[0];
    const flags = m.flags || new Set<string>();
    return [
      this.account.user_id,
      this.account.id,
      folderId,
      m.uid,
      env.messageId?.slice(0, 500) || null,
      env.inReplyTo?.slice(0, 500) || null,
      parseRefs(m.headers),
      (env.subject || '').slice(0, 1000),
      subjectKey(env.subject || ''),
      (from?.name || '').slice(0, 255),
      (from?.address || '').slice(0, 255),
      addrList(env.to),
      addrList(env.cc),
      env.replyTo?.[0]?.address?.slice(0, 255) || null,
      toDate(env.date, m.internalDate),
      m.size || 0,
      +flags.has('\\Seen'),
      +flags.has('\\Flagged'),
      +flags.has('\\Answered'),
      +structureHasAttachments(m.bodyStructure),
      notified,
    ];
  }

  private async locate(messageId: number) {
    const row = await one<{ uid: number; path: string; folder_id: number }>(
      `SELECT m.uid, m.folder_id, f.path FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.id = ? AND m.account_id = ?`,
      [messageId, this.account.id],
    );
    if (!row) throw new Error('邮件不存在');
    return row;
  }

  async fetchSource(messageId: number): Promise<ParsedBody> {
    const { uid, path } = await this.locate(messageId);
    const msg = await this.withFolder(path, (c) => c.fetchOne(String(uid), { source: true }, { uid: true }));
    if (!msg || !msg.source) throw new Error('邮件已不在服务器上');
    return parseSource(msg.source);
  }

  /** 下载并解析正文，写入本地缓存 */
  async loadBody(messageId: number): Promise<void> {
    const body = await this.fetchSource(messageId);
    const meta = await one<{ subject: string }>('SELECT subject FROM messages WHERE id = ?', [messageId]);
    await exec(
      `UPDATE messages SET body_fetched = 1, body_text = ?, body_html = ?, snippet = ?, code = ?, attachments = ?,
         has_attachments = ?, links = ? WHERE id = ?`,
      [
        body.text,
        body.html,
        body.snippet,
        extractCode(meta?.subject || '', body.text),
        JSON.stringify(body.attachments),
        +body.attachments.some((a) => !a.inline),
        JSON.stringify(extractLinks(body.html, body.html ? null : body.text)),
        messageId,
      ],
    );
  }

  async setFlags(folderPath: string, uids: number[], flag: '\\Seen' | '\\Flagged' | '\\Answered', on: boolean) {
    await this.withFolder(folderPath, (c) =>
      on
        ? c.messageFlagsAdd(uids.join(','), [flag], { uid: true })
        : c.messageFlagsRemove(uids.join(','), [flag], { uid: true }),
    );
  }

  async move(folderPath: string, uids: number[], destPath: string) {
    await this.withFolder(folderPath, (c) => c.messageMove(uids.join(','), destPath, { uid: true }));
    void this.requestSync();
  }

  async destroy(folderPath: string, uids: number[]) {
    await this.withFolder(folderPath, (c) => c.messageDelete(uids.join(','), { uid: true }));
  }

  /** 把一封完整的邮件存进指定角色的文件夹（已发送 / 草稿） */
  async appendTo(role: 'sent' | 'drafts', raw: Buffer) {
    const folder = (await this.folders()).find((f) => f.role === role);
    if (!folder) return false;
    const c = await this.client();
    await c.append(folder.path, raw, role === 'drafts' ? ['\\Seen', '\\Draft'] : ['\\Seen']);
    void this.enqueue(() => this.syncFolder(folder));
    return true;
  }
}

const workers = new Map<number, AccountWorker>();

export async function startAccount(accountId: number) {
  workers.get(accountId)?.stop();
  const account = await one<AccountRow>('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) return;
  const worker = new AccountWorker(account);
  workers.set(accountId, worker);
  worker.start();
}

export function stopAccount(accountId: number) {
  workers.get(accountId)?.stop();
  workers.delete(accountId);
}

export function worker(accountId: number): AccountWorker {
  const w = workers.get(accountId);
  if (!w) throw new Error('邮箱未连接');
  return w;
}

export async function startAllAccounts() {
  const rows = await query<{ id: number }>('SELECT id FROM accounts');
  for (const { id } of rows) await startAccount(id);
  console.log(`[mail] ${rows.length} 个邮箱开始同步`);
}

export function stopAllAccounts() {
  for (const w of workers.values()) w.stop();
  workers.clear();
}
