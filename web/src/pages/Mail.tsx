import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import {
  AlertOctagon, Archive, ArrowLeft, CalendarPlus, File, Folder as FolderIcon, Forward, Inbox, Mail, MailOpen,
  Menu, Paperclip, PenLine, RefreshCw, Reply, ReplyAll, Search, Send, Star, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAccounts, useUser } from '../App';
import { api, folderLabel } from '../api';
import type { Account, Folder, MessageFull, MessageItem } from '../api';
import { Compose, loadSavedDraft } from '../components/Compose';
import type { Draft } from '../components/Compose';
import { MessageBody, sanitizeMail } from '../components/MessageBody';
import { escapeHtml, fileSize, fullDate, shortDate, toast, toastError } from '../lib';

interface Page {
  items: MessageItem[];
  next: string | null;
}

const ROLE_ICONS = { inbox: Inbox, sent: Send, drafts: File, archive: Archive, junk: AlertOctagon, trash: Trash2 };
const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];
const sortFolders = (folders: Folder[]) =>
  [...folders].sort((a, b) => {
    const [ia, ib] = [a, b].map((f) => (f.role ? ROLE_ORDER.indexOf(f.role) : 99));
    return ia - ib || a.path.localeCompare(b.path);
  });

function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 48%)`;
}

const addrText = (list: { name: string; address: string }[]) => list.map((a) => a.name || a.address).join('、');
const withPrefix = (prefix: string, subject: string) =>
  new RegExp(`^${prefix}\\s*[:：]`, 'i').test(subject) ? subject : `${prefix}: ${subject}`;

function signatureHtml(a?: Account): string {
  return a?.signature ? `<br><br><div>-- <br>${escapeHtml(a.signature).replace(/\n/g, '<br>')}</div>` : '';
}

function quoted(m: MessageFull): string {
  const body = m.body_html
    ? new DOMParser().parseFromString(sanitizeMail(m.body_html), 'text/html').body.innerHTML
    : escapeHtml(m.body_text || '').replace(/\n/g, '<br>');
  return `<br><div>${fullDate(m.date)}，${escapeHtml(m.from_name || m.from_addr)} 写道：</div><blockquote style="margin:8px 0;padding-left:12px;border-left:3px solid #d5d9d2;color:#666">${body}</blockquote>`;
}

export function MailPage() {
  const user = useUser();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const [compose, setCompose] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [drawer, setDrawer] = useState(false);
  const [searchText, setSearchText] = useState(params.get('q') || '');
  const searchRef = useRef<HTMLInputElement>(null);

  const view = params.get('v') || 'inbox';
  const folderId = Number(params.get('f')) || undefined;
  const accountId = Number(params.get('a')) || undefined;
  const q = params.get('q') || '';
  const openId = Number(params.get('open')) || undefined;

  const go = (next: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== '') p.set(k, String(v));
    setParams(p);
    setSelected(new Set());
    setDrawer(false);
  };
  const open = (id?: number) => {
    const p = new URLSearchParams(params);
    id ? p.set('open', String(id)) : p.delete('open');
    setParams(p);
  };

  const listKey = { view, folderId, accountId, q };
  const list = useInfiniteQuery({
    queryKey: ['messages', listKey],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ view });
      if (folderId) p.set('folderId', String(folderId));
      if (accountId) p.set('accountId', String(accountId));
      if (q) p.set('q', q);
      if (pageParam) p.set('before', pageParam);
      return api<Page>(`/messages?${p}`);
    },
    getNextPageParam: (last) => last.next,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const message = useQuery({
    queryKey: ['message', openId],
    queryFn: () => api<MessageFull>(`/messages/${openId}`),
    enabled: !!openId,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const current = message.data;
  const accountOf = (id: number) => accounts.find((a) => a.id === id);

  /** 先改本地缓存让界面立刻响应，服务端结果随后通过事件推送校正 */
  const patchLists = (fn: (items: MessageItem[]) => MessageItem[]) =>
    qc.setQueriesData<InfiniteData<Page>>({ queryKey: ['messages'] }, (data) =>
      data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: fn(p.items) })) } : data,
    );

  async function setFlag(ids: number[], patch: { seen?: boolean; flagged?: boolean }) {
    const fields = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, +v!]));
    patchLists((list) => list.map((m) => (ids.includes(m.id) ? { ...m, ...fields } : m)));
    if (current && ids.includes(current.id)) qc.setQueryData(['message', current.id], { ...current, ...fields });
    await api('/messages/flags', { body: { ids, ...patch } }).catch(toastError);
  }

  async function move(ids: number[], to: 'archive' | 'trash' | 'junk' | 'inbox') {
    // 当前打开的邮件被移走后，自动跳到列表里的下一封
    if (openId && ids.includes(openId)) {
      const rest = items.filter((m) => !ids.includes(m.id) || m.id === openId);
      const i = rest.findIndex((m) => m.id === openId);
      open((rest[i + 1] || rest[i - 1])?.id);
    }
    patchLists((list) => list.filter((m) => !ids.includes(m.id)));
    setSelected(new Set());
    try {
      await api('/messages/move', { body: { ids, to } });
    } catch (e) {
      toastError(e);
      qc.invalidateQueries({ queryKey: ['messages'] });
    }
  }

  // 打开即标记已读
  useEffect(() => {
    if (current && !current.seen) void setFlag([current.id], { seen: true });
  }, [current?.id]);

  function startCompose(kind: 'new' | 'reply' | 'replyAll' | 'forward', m?: MessageFull) {
    if (!accounts.length) return toast('请先在设置里添加邮箱', { kind: 'error' });
    const account = (m && accountOf(m.account_id)) || accountOf(accountId || 0) || accounts[0];
    const blank: Draft = { accountId: account.id, to: '', cc: '', bcc: '', subject: '', html: signatureHtml(account), files: [] };
    if (kind === 'new' || !m) {
      const saved = loadSavedDraft();
      return setCompose(saved && accountOf(saved.accountId) ? { ...saved, files: [] } : blank);
    }
    if (kind === 'forward') {
      return setCompose({ ...blank, subject: withPrefix('Fwd', m.subject), html: signatureHtml(account) + quoted(m), forwardOf: m.id });
    }
    const mine = account.email.toLowerCase();
    const others = [...m.to, ...m.cc].map((a) => a.address).filter((a) => a && a.toLowerCase() !== mine);
    setCompose({
      ...blank,
      to: m.reply_to || m.from_addr,
      cc: kind === 'replyAll' ? [...new Set(others)].join(', ') : '',
      subject: withPrefix('Re', m.subject),
      html: signatureHtml(account) + quoted(m),
      replyTo: m.id,
    });
  }

  async function toTask(m: MessageFull) {
    try {
      await api(`/messages/${m.id}/task`, { body: {} });
      toast('已加入待办', { action: { label: '去计划里设置时间', run: () => navigate('/planner') } });
    } catch (e) {
      toastError(e);
    }
  }

  // 键盘快捷键：j/k 上下，e 归档，# 删除，s 星标，u 未读，r 回复，c 写信，/ 搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const i = items.findIndex((m) => m.id === openId);
      const actions: Record<string, () => void> = {
        j: () => open((items[i + 1] || items[i] || items[0])?.id),
        k: () => i > 0 && open(items[i - 1].id),
        c: () => startCompose('new'),
        '/': () => searchRef.current?.focus(),
        Escape: () => open(undefined),
      };
      if (current) {
        Object.assign(actions, {
          e: () => move([current.id], 'archive'),
          '#': () => move([current.id], 'trash'),
          s: () => setFlag([current.id], { flagged: !current.flagged }),
          u: () => (setFlag([current.id], { seen: false }), open(undefined)),
          r: () => startCompose('reply', current),
          a: () => startCompose('replyAll', current),
          f: () => startCompose('forward', current),
        });
      }
      const run = actions[e.key];
      if (run) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const folder = folderId ? accounts.flatMap((a) => a.folders).find((f) => f.id === folderId) : undefined;
  const title =
    view === 'search' ? `搜索"${q}"` : view === 'unread' ? '未读' : view === 'starred' ? '星标' : folder ? folderLabel(folder) : '收件箱';
  const scope = accountId && view !== 'folder' ? accountOf(accountId)?.name : folder ? accountOf(folder.account_id)?.name : accounts.length > 1 ? '全部邮箱' : '';
  const inboxUnread = accounts.flatMap((a) => a.folders).filter((f) => f.role === 'inbox').reduce((n, f) => n + f.unread, 0);
  const selectedIds = [...selected];
  const inTrash = folder?.role === 'trash';

  return (
    <div className={`mail${openId ? ' reading' : ''}${drawer ? ' drawer' : ''}`}>
      {drawer && <div className="drawer-mask" onClick={() => setDrawer(false)} />}
      <aside className="side">
        <button className="btn accent block" style={{ marginBottom: 8 }} onClick={() => startCompose('new')}>
          <PenLine size={16} /> 写邮件
        </button>
        <SideItem icon={Inbox} label="全部收件箱" count={inboxUnread} active={view === 'inbox' && !accountId} onClick={() => go({})} />
        <SideItem icon={Mail} label="未读" active={view === 'unread'} onClick={() => go({ v: 'unread' })} />
        <SideItem icon={Star} label="星标" active={view === 'starred'} onClick={() => go({ v: 'starred' })} />
        {accounts.map((a) => (
          <div key={a.id}>
            <div className="side-title">
              <span className="dot" style={{ background: a.color }} />
              <span className="truncate grow" title={a.email}>{a.name}</span>
              <button
                className="icon-btn"
                style={{ width: 24, height: 24 }}
                title={a.sync_state === 'syncing' ? '同步中…' : '立即同步'}
                onClick={() => api(`/accounts/${a.id}/sync`, { method: 'POST' }).catch(toastError)}
              >
                <RefreshCw size={13} className={a.sync_state === 'syncing' ? 'spin' : ''} />
              </button>
            </div>
            {a.sync_state === 'error' && <div className="side-error">连接失败：{a.last_error}</div>}
            {sortFolders(a.folders).map((f) => (
              <SideItem
                key={f.id}
                icon={(f.role && ROLE_ICONS[f.role]) || FolderIcon}
                label={folderLabel(f)}
                count={f.role === 'sent' || f.role === 'trash' || f.role === 'archive' ? 0 : f.unread}
                active={view === 'folder' && folderId === f.id}
                onClick={() => go({ v: 'folder', f: f.id })}
              />
            ))}
          </div>
        ))}
        {!accounts.length && !accountsLoading && (
          <div className="muted small" style={{ padding: 12 }}>
            还没有邮箱。
            <a href="/settings" onClick={(e) => (e.preventDefault(), navigate('/settings'))}>
              去添加
            </a>
          </div>
        )}
      </aside>

      <section className={`list-pane${selected.size ? ' selecting' : ''}`}>
        <div className="list-head">
          <button className="icon-btn only-mobile" onClick={() => setDrawer(true)} title="文件夹">
            <Menu size={19} />
          </button>
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              searchText.trim() ? go({ v: 'search', q: searchText.trim() }) : go({});
            }}
          >
            <Search size={16} />
            <input ref={searchRef} className="input" placeholder="搜索邮件" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
          </form>
        </div>
        {selected.size ? (
          <div className="bulk">
            <span className="small grow" style={{ paddingLeft: 6 }}>已选 {selected.size} 封</span>
            <button className="icon-btn" title="标为已读" onClick={() => (setFlag(selectedIds, { seen: true }), setSelected(new Set()))}><MailOpen size={17} /></button>
            <button className="icon-btn" title="标为未读" onClick={() => (setFlag(selectedIds, { seen: false }), setSelected(new Set()))}><Mail size={17} /></button>
            <button className="icon-btn" title="归档" onClick={() => move(selectedIds, 'archive')}><Archive size={17} /></button>
            <button className="icon-btn" title="删除" onClick={() => move(selectedIds, 'trash')}><Trash2 size={17} /></button>
            <button className="btn ghost sm" onClick={() => setSelected(new Set())}>取消</button>
          </div>
        ) : (
          <div className="list-title">
            <h2>{title}</h2>
            <span className="muted small">{scope}</span>
          </div>
        )}
        <div
          className="list-scroll"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 400 && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
          }}
        >
          {items.map((m) => {
            const outgoing = m.folder_role === 'sent' || m.folder_role === 'drafts';
            return (
              <div key={m.id} className={`msg${m.seen ? '' : ' unread'}${m.id === openId ? ' active' : ''}`} onClick={() => open(m.id)}>
                {accounts.length > 1 && <span className="msg-bar" style={{ background: accountOf(m.account_id)?.color }} />}
                <label className="msg-mark" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(m.id)}
                    onChange={() => {
                      const next = new Set(selected);
                      next.has(m.id) ? next.delete(m.id) : next.add(m.id);
                      setSelected(next);
                    }}
                  />
                  {!m.seen && <span className="dot" />}
                </label>
                <div style={{ minWidth: 0 }}>
                  <div className="msg-top">
                    <span className="msg-from truncate">{outgoing ? `收件人：${addrText(m.to)}` : m.from_name || m.from_addr}</span>
                    <span className="msg-date">{shortDate(m.date)}</span>
                  </div>
                  <div className="msg-subject">
                    <span className="truncate grow">{m.subject || '(无主题)'}</span>
                    {m.answered ? <Reply size={13} /> : null}
                    {m.has_attachments ? <Paperclip size={13} /> : null}
                    {m.flagged ? <Star size={13} className="star" /> : null}
                  </div>
                  <div className="msg-snippet truncate">
                    {view !== 'folder' && view !== 'inbox' && view !== 'unread' && <span className="chip" style={{ height: 18, marginRight: 6 }}>{folderLabel({ role: m.folder_role, name: m.folder_name })}</span>}
                    {m.snippet || ' '}
                  </div>
                </div>
              </div>
            );
          })}
          {list.isFetchingNextPage && <div className="muted small" style={{ padding: 16, textAlign: 'center' }}>加载中…</div>}
          {!list.isLoading && !items.length && (
            <div className="empty">
              <Inbox size={40} />
              {view === 'search' ? '没有找到匹配的邮件' : accounts.length || accountsLoading ? '这里空空如也' : '添加邮箱后邮件会出现在这里'}
            </div>
          )}
        </div>
        <button className="fab only-mobile" onClick={() => startCompose('new')} title="写邮件"><PenLine size={20} /></button>
      </section>

      <section className="reader">
        {current ? (
          <>
            <div className="reader-bar">
              <button className="icon-btn only-mobile" onClick={() => open(undefined)} title="返回"><ArrowLeft size={19} /></button>
              <button className="icon-btn" title="回复 (r)" onClick={() => startCompose('reply', current)}><Reply size={18} /></button>
              <button className="icon-btn" title="回复全部 (a)" onClick={() => startCompose('replyAll', current)}><ReplyAll size={18} /></button>
              <button className="icon-btn" title="转发 (f)" onClick={() => startCompose('forward', current)}><Forward size={18} /></button>
              <span className="grow" />
              <button className="icon-btn" title="转为待办" onClick={() => toTask(current)}><CalendarPlus size={18} /></button>
              <button className={`icon-btn${current.flagged ? ' on' : ''}`} title="星标 (s)" onClick={() => setFlag([current.id], { flagged: !current.flagged })}>
                <Star size={18} className={current.flagged ? 'star' : ''} />
              </button>
              <button className="icon-btn" title="标为未读 (u)" onClick={() => (setFlag([current.id], { seen: false }), open(undefined))}><Mail size={18} /></button>
              {current.folder_role !== 'archive' && current.folder_role !== 'sent' && (
                <button className="icon-btn" title="归档 (e)" onClick={() => move([current.id], 'archive')}><Archive size={18} /></button>
              )}
              <button className="icon-btn" title={current.folder_role === 'trash' ? '彻底删除' : '删除 (#)'} onClick={() => move([current.id], 'trash')}><Trash2 size={18} /></button>
            </div>
            <div className="reader-scroll" key={current.id}>
              <article className="reader-inner">
                <h1 className="reader-subject">{current.subject || '(无主题)'}</h1>
                <div className="reader-meta">
                  <div className="avatar" style={{ background: avatarColor(current.from_addr) }}>
                    {(current.from_name || current.from_addr || '?').trim()[0]?.toUpperCase()}
                  </div>
                  <div className="grow">
                    <div>
                      <b>{current.from_name || current.from_addr}</b>{' '}
                      {current.from_name && <span className="muted small">&lt;{current.from_addr}&gt;</span>}
                    </div>
                    <div className="muted small">
                      发给 {addrText(current.to) || '(未公开)'}
                      {current.cc.length > 0 && `，抄送 ${addrText(current.cc)}`}
                    </div>
                    <div className="muted small">
                      {fullDate(current.date)}
                      {accounts.length > 1 && ` · ${accountOf(current.account_id)?.name}`}
                    </div>
                  </div>
                </div>
                <MessageBody key={`${current.id}-${user.settings.theme}`} message={current} blockRemote={user.settings.blockRemoteImages} />
                {current.attachments.length > 0 && (
                  <div className="atts">
                    {current.attachments.map((a) => (
                      <a key={a.i} className="att" href={`/api/messages/${current.id}/attachments/${a.i}`} download={a.filename}>
                        <Paperclip size={16} />
                        <span style={{ minWidth: 0 }}>
                          <div className="truncate">{a.filename}</div>
                          <div className="muted small">{fileSize(a.size)}</div>
                        </span>
                      </a>
                    ))}
                  </div>
                )}
              </article>
            </div>
          </>
        ) : (
          <div className="empty">
            {openId && message.isLoading ? '加载中…' : openId && message.isError ? '邮件不存在或已被移动' : (
              <>
                <MailOpen size={44} />
                {inTrash ? '废纸篓里的邮件再次删除会被彻底清除' : '选择一封邮件开始阅读'}
              </>
            )}
          </div>
        )}
      </section>

      {compose && (
        <Compose
          key={`${compose.replyTo}-${compose.forwardOf}-${compose.html.length}`}
          initial={compose}
          accounts={accounts}
          onClose={() => setCompose(null)}
          onReopen={setCompose}
        />
      )}
    </div>
  );
}

function SideItem(props: { icon: typeof Inbox; label: string; count?: number; active: boolean; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <button className={`side-item${props.active ? ' active' : ''}`} onClick={props.onClick}>
      <Icon size={16} />
      <span className="truncate">{props.label}</span>
      {!!props.count && <span className="count">{props.count}</span>}
    </button>
  );
}
