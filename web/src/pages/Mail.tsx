import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import {
  AlarmClock, AlertOctagon, Archive, ArrowLeft, AtSign, BellOff, CalendarPlus, Clock, Copy, File, FolderInput, KeyRound, MailCheck, PenSquare, Search as SearchIcon, ShieldAlert, Star as StarIcon, Folder as FolderIcon, Forward, Inbox, Mail, MailOpen,
  Menu, Paperclip, PenLine, RefreshCw, Reply, ReplyAll, Search, Send, Star, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAccounts, useSaveSettings, useUser } from '../App';
import { api, folderLabel } from '../api';
import type { Account, AiInfo, Folder, MessageFull, MessageItem, OutboxItem } from '../api';
import { Compose, loadSavedDraft } from '../components/Compose';
import type { Draft } from '../components/Compose';
import { AiBar } from '../components/AiBar';
import { ContextMenu } from '../components/ContextMenu';
import type { MenuItem } from '../components/ContextMenu';
import { useSelection } from '../hooks/useSelection';
import { Conversation } from '../components/Conversation';
import { LinksPanel } from '../components/LinksPanel';
import { MessageBody, sanitizeForEditor } from '../components/MessageBody';
import { copyText, dueLabel, escapeHtml, fileSize, fullDate, shortDate, toast, toastError } from '../lib';

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

/** 稍后处理的快捷时间点 */
function snoozeOptions(): { label: string; at: Date }[] {
  const now = new Date();
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour);
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    { label: '3 小时后', at: new Date(now.getTime() + 3 * 3600_000) },
    ...(now.getHours() < 19 ? [{ label: '今晚 20:00', at: at(0, 20) }] : []),
    { label: '明早 9:00', at: at(1, 9) },
    { label: '下周一 9:00', at: at(toMonday, 9) },
  ];
}

function signatureHtml(a?: Account): string {
  return a?.signature ? `<br><br><div>-- <br>${escapeHtml(a.signature).replace(/\n/g, '<br>')}</div>` : '';
}

function quoted(m: MessageFull, blockRemote: boolean): string {
  const body = m.body_html ? sanitizeForEditor(m.body_html, blockRemote) : escapeHtml(m.body_text || '').replace(/\n/g, '<br>');
  return `<br><div>${fullDate(m.date)}，${escapeHtml(m.from_name || m.from_addr)} 写道：</div><blockquote style="margin:8px 0;padding-left:12px;border-left:3px solid #d5d9d2;color:#666">${body}</blockquote>`;
}

export function MailPage() {
  const user = useUser();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();
  const [compose, setCompose] = useState<Draft | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [snoozeMenu, setSnoozeMenu] = useState(false);
  const outbox = useQuery({ queryKey: ['outbox'], queryFn: () => api<OutboxItem[]>('/outbox') });
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

  // 搜索结果总是逐封列出，其余视图按设置折叠成会话
  const grouped = user.settings.threads && view !== 'search' && view !== 'outbox';
  const listKey = { view, folderId, accountId, q, grouped };
  const ai = useQuery({ queryKey: ['ai'], queryFn: () => api<AiInfo>('/ai'), staleTime: 5 * 60_000 });
  const list = useInfiniteQuery({
    queryKey: ['messages', listKey],
    enabled: view !== 'outbox',
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ view });
      if (folderId) p.set('folderId', String(folderId));
      if (accountId) p.set('accountId', String(accountId));
      if (q) p.set('q', q);
      if (grouped) p.set('threads', '1');
      if (pageParam) p.set('before', pageParam);
      return api<Page>(`/messages?${p}`);
    },
    getNextPageParam: (last) => last.next,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const sel = useSelection(useMemo(() => (view === 'outbox' ? [] : items.map((m) => m.id)), [items, view]), listRef);
  const { selected } = sel;
  const setSelected = sel.setSelected;

  const message = useQuery({
    queryKey: ['message', openId],
    queryFn: () => api<MessageFull>(`/messages/${openId}`),
    enabled: !!openId && params.get('v') !== 'outbox',
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

  async function setFlag(ids: number[], patch: { seen?: boolean; flagged?: boolean }, threads = false) {
    const fields = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, +v!]));
    patchLists((list) => list.map((m) => (ids.includes(m.id) ? { ...m, ...fields } : m)));
    if (current && ids.includes(current.id)) qc.setQueryData(['message', current.id], { ...current, ...fields });
    await api('/messages/flags', { body: { ids, ...patch, threads } }).catch(toastError);
  }

  async function move(ids: number[], to: 'archive' | 'trash' | 'junk' | 'inbox' | number) {
    // 当前打开的邮件被移走后，自动跳到列表里的下一封
    if (openId && ids.includes(openId)) {
      const rest = items.filter((m) => !ids.includes(m.id) || m.id === openId);
      const i = rest.findIndex((m) => m.id === openId);
      open((rest[i + 1] || rest[i - 1])?.id);
    }
    patchLists((list) => list.filter((m) => !ids.includes(m.id)));
    setSelected(new Set());
    try {
      // 会话视图下归档/删除一行等于处理整个会话（只限同一个文件夹里的邮件）
      await api('/messages/move', { body: { ids, to, threads: grouped } });
    } catch (e) {
      toastError(e);
      qc.invalidateQueries({ queryKey: ['messages'] });
    }
  }

  async function snooze(ids: number[], until: Date | null) {
    setSnoozeMenu(false);
    if (until) {
      if (openId && ids.includes(openId)) open(undefined);
      if (view !== 'snoozed') patchLists((list) => list.filter((m) => !ids.includes(m.id)));
    }
    try {
      await api('/messages/snooze', { body: { ids, until: until?.toISOString() ?? null } });
      toast(until ? `${dueLabel(until.toISOString())}再提醒你` : '已取消稍后处理');
    } catch (e) {
      toastError(e);
    }
    qc.invalidateQueries({ queryKey: ['messages'] });
  }

  /** 从草稿箱继续编辑：正文和收件人填回写信窗口，附件由服务器在发送时从原草稿带上 */
  function editDraft(m: MessageFull) {
    setCompose({
      accountId: m.account_id,
      to: m.to.map((a) => a.address).join(', '),
      cc: m.cc.map((a) => a.address).join(', '),
      bcc: '',
      subject: m.subject,
      // 草稿是自己写的，但也可能是从别的客户端存进来的转发内容，同样清理一遍
      html: m.body_html ? sanitizeForEditor(m.body_html, user.settings.blockRemoteImages) : escapeHtml(m.body_text || '').replace(/\n/g, '<br>'),
      draftOf: m.id,
      files: [],
    });
    open(undefined);
  }

  useEffect(() => {
    if (params.get('compose') && accounts.length) {
      startCompose('new');
      go({});
    }
  }, [accounts.length]);

  // 打开即标记已读
  useEffect(() => {
    if (current && !current.seen) void setFlag([current.id], { seen: true });
  }, [current?.id]);

  function startCompose(kind: 'new' | 'reply' | 'replyAll' | 'forward', m?: MessageFull, prefill = '') {
    if (!accounts.length) return toast('请先在设置里添加邮箱', { kind: 'error' });
    const account = (m && accountOf(m.account_id)) || accountOf(accountId || 0) || accounts[0];
    const blank: Draft = { accountId: account.id, to: '', cc: '', bcc: '', subject: '', html: signatureHtml(account), files: [] };
    if (kind === 'new' || !m) {
      const saved = loadSavedDraft();
      return setCompose(saved && accountOf(saved.accountId) ? { ...saved, files: [] } : blank);
    }
    if (kind === 'forward') {
      return setCompose({ ...blank, subject: withPrefix('Fwd', m.subject), html: signatureHtml(account) + quoted(m, user.settings.blockRemoteImages), forwardOf: m.id });
    }
    const mine = account.email.toLowerCase();
    const others = [...m.to, ...m.cc].map((a) => a.address).filter((a) => a && a.toLowerCase() !== mine);
    setCompose({
      ...blank,
      to: m.reply_to || m.from_addr,
      cc: kind === 'replyAll' ? [...new Set(others)].join(', ') : '',
      subject: withPrefix('Re', m.subject),
      html: (prefill ? escapeHtml(prefill).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('') : '') + signatureHtml(account) + quoted(m, user.settings.blockRemoteImages),
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

  const saveSettings = useSaveSettings();

  /** 右键菜单：右键点在已选中的行上时作用于全部选中的邮件，否则只作用于这一封 */
  function mailMenu(m: MessageItem): MenuItem[] {
    const ids = selected.has(m.id) && selected.size > 1 ? [...selected] : [m.id];
    const single = ids.length === 1;
    const rows = items.filter((x) => ids.includes(x.id));
    const sameAccount = rows.every((x) => x.account_id === m.account_id);
    const acct = accountOf(m.account_id);
    const full = () => qc.fetchQuery({ queryKey: ['message', m.id], queryFn: () => api<MessageFull>(`/messages/${m.id}`) });
    const reply = (kind: 'reply' | 'replyAll' | 'forward') => full().then((f) => startCompose(kind, f)).catch(toastError);
    const sender = m.from_addr.toLowerCase();
    const s = user.settings;
    const anyUnread = rows.some((x) => !x.seen || x.thread_unread);
    const anyUnflagged = rows.some((x) => !x.flagged);
    const inJunk = m.folder_role === 'junk';
    const inTrashFolder = m.folder_role === 'trash';
    const menu: MenuItem[] = [];
    if (!single) menu.push({ heading: true, label: `已选 ${ids.length} 封` });
    if (single) {
      menu.push(
        { label: '打开', icon: MailOpen, onClick: () => open(m.id) },
        { label: '回复', icon: Reply, hint: 'R', onClick: () => reply('reply') },
        { label: '回复全部', icon: ReplyAll, hint: 'A', onClick: () => reply('replyAll') },
        { label: '转发', icon: Forward, hint: 'F', onClick: () => reply('forward') },
        { separator: true },
      );
    }
    menu.push(
      anyUnread
        ? { label: '标为已读', icon: MailCheck, onClick: () => setFlag(ids, { seen: true }, grouped) }
        : { label: '标为未读', icon: Mail, hint: 'U', onClick: () => setFlag(ids, { seen: false }, grouped) },
      anyUnflagged
        ? { label: '加星标', icon: StarIcon, hint: 'S', onClick: () => setFlag(ids, { flagged: true }, grouped) }
        : { label: '取消星标', icon: StarIcon, onClick: () => setFlag(ids, { flagged: false }, grouped) },
      { label: '稍后处理', icon: AlarmClock, children: snoozeOptions().map((o) => ({ label: o.label, onClick: () => snooze(ids, o.at) })) },
    );
    if (single) {
      menu.push({
        label: '转为待办',
        icon: CalendarPlus,
        onClick: () => api(`/messages/${m.id}/task`, { body: {} }).then(() => toast('已加入待办', { action: { label: '去计划', run: () => navigate('/planner') } })).catch(toastError),
      });
    }
    menu.push({ separator: true });
    if (m.folder_role !== 'archive' && m.folder_role !== 'sent') menu.push({ label: '归档', icon: Archive, hint: 'E', onClick: () => move(ids, 'archive') });
    if (sameAccount && acct) {
      menu.push({
        label: '移动到',
        icon: FolderInput,
        children: sortFolders(acct.folders)
          .filter((f) => f.id !== m.folder_id)
          .map((f) => ({ label: folderLabel(f), onClick: () => move(ids, f.id) })),
      });
    }
    menu.push(
      inJunk
        ? { label: '不是垃圾邮件', icon: Inbox, onClick: () => move(ids, 'inbox') }
        : { label: '标为垃圾邮件', icon: ShieldAlert, onClick: () => move(ids, 'junk') },
      { label: inTrashFolder ? '彻底删除' : '删除', icon: Trash2, danger: true, hint: '#', onClick: () => move(ids, 'trash') },
    );
    if (single) {
      menu.push({ separator: true });
      if (m.code) menu.push({ label: `复制验证码 ${m.code}`, icon: KeyRound, onClick: () => copyText(m.code!) });
      menu.push(
        { label: '复制发件人地址', icon: AtSign, onClick: () => copyText(m.from_addr) },
        { label: '这个发件人的所有邮件', icon: SearchIcon, onClick: () => go({ v: 'search', q: m.from_addr }) },
        s.vipSenders.includes(sender)
          ? { label: '取消重点发件人', icon: StarIcon, onClick: () => saveSettings({ settings: { vipSenders: s.vipSenders.filter((x) => x !== sender) } }).then(() => toast('已取消')) }
          : { label: '设为重点发件人', icon: StarIcon, onClick: () => saveSettings({ settings: { vipSenders: [...s.vipSenders, sender] } }).then(() => toast('以后这个发件人的邮件始终通知')) },
        s.mutedSenders.includes(sender)
          ? { label: '恢复这个发件人的通知', icon: BellOff, onClick: () => saveSettings({ settings: { mutedSenders: s.mutedSenders.filter((x) => x !== sender) } }).then(() => toast('已恢复通知')) }
          : { label: '不再推送这个发件人', icon: BellOff, onClick: () => saveSettings({ settings: { mutedSenders: [...s.mutedSenders, sender] } }).then(() => toast('邮件照常接收，但不再推送')) },
      );
    }
    return menu;
  }

  // 键盘快捷键：j/k 上下，e 归档，# 删除，s 星标，u 未读，r 回复，c 写信，/ 搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      // Ctrl/⌘ + A 全选当前列表；有选中时 Delete 删除、Esc 取消
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && view !== 'outbox') {
        e.preventDefault();
        sel.setSelected(new Set(items.map((m) => m.id)));
        return;
      }
      if (selected.size && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        move([...selected], 'trash');
        return;
      }
      if (selected.size && e.key === 'Escape') return sel.clear();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
    view === 'search' ? `搜索"${q}"` : view === 'unread' ? '未读' : view === 'starred' ? '星标' : view === 'snoozed' ? '稍后处理' : view === 'outbox' ? '定时发送' : folder ? folderLabel(folder) : '收件箱';
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
        <SideItem icon={AlarmClock} label="稍后处理" active={view === 'snoozed'} onClick={() => go({ v: 'snoozed' })} />
        {(outbox.data?.length || view === 'outbox') ? (
          <SideItem icon={Clock} label="定时发送" count={outbox.data?.length} active={view === 'outbox'} onClick={() => go({ v: 'outbox' })} />
        ) : null}
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
                count={f.role === 'sent' || f.role === 'trash' || f.role === 'archive' || f.role === 'junk' ? 0 : f.unread}
                active={view === 'folder' && folderId === f.id}
                onClick={() => go({ v: 'folder', f: f.id })}
              />
            ))}
          </div>
        ))}
        {!accounts.length && !accountsLoading && (
          <div className="muted small" style={{ padding: 12 }}>
            还没有邮箱。
            <a href="/settings/mailboxes" onClick={(e) => (e.preventDefault(), navigate('/settings/mailboxes'))}>
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
            <label className="select-all" title={sel.allSelected ? '取消全选' : '全选'}><input type="checkbox" checked={sel.allSelected} onChange={sel.toggleAll} /></label>
            <span className="small grow" style={{ paddingLeft: 6 }}>已选 {selected.size} 封{list.hasNextPage ? '（已加载的）' : ''}</span>
            <button className="icon-btn" title="加星标" onClick={() => setFlag(selectedIds, { flagged: true }, grouped)}><Star size={17} /></button>
            <button className="icon-btn" title="标为已读" onClick={() => (setFlag(selectedIds, { seen: true }, grouped), setSelected(new Set()))}><MailOpen size={17} /></button>
            <button className="icon-btn" title="标为未读" onClick={() => (setFlag(selectedIds, { seen: false }, grouped), setSelected(new Set()))}><Mail size={17} /></button>
            <button className="icon-btn" title="归档" onClick={() => move(selectedIds, 'archive')}><Archive size={17} /></button>
            <button className="icon-btn" title="删除" onClick={() => move(selectedIds, 'trash')}><Trash2 size={17} /></button>
            <button className="btn ghost sm" onClick={() => setSelected(new Set())}>取消</button>
          </div>
        ) : (
          <div className="list-title">
            {view !== 'outbox' && items.length > 0 && (
              <label className="select-all" title="全选（Ctrl/⌘ + A）"><input type="checkbox" checked={false} onChange={sel.toggleAll} /></label>
            )}
            <h2>{title}</h2>
            <span className="muted small">{scope}</span>
          </div>
        )}
        <div
          ref={listRef}
          className={`list-scroll${sel.dragging ? ' selecting-drag' : ''}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 400 && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
          }}
        >
          {view === 'outbox' &&
            (outbox.data || []).map((o) => (
              <div key={o.id} className="msg" style={{ cursor: 'default' }}>
                <span />
                <div style={{ minWidth: 0 }}>
                  <div className="msg-top">
                    <span className="msg-from truncate">收件人：{o.recipients}</span>
                    <span className="msg-date">{dueLabel(o.send_at)}</span>
                  </div>
                  <div className="msg-subject"><span className="truncate grow">{o.subject || '(无主题)'}</span></div>
                  <div className="row" style={{ marginTop: 6, gap: 6 }}>
                    <span className={`chip${o.status === 'failed' ? ' danger' : ' accent'}`}>
                      {o.status === 'failed' ? `发送失败：${o.error}` : o.status === 'sending' ? '发送中…' : `${accountOf(o.account_id)?.name || ''} · 等待发送`}
                    </span>
                    <span className="grow" />
                    <button className="btn sm ghost" onClick={() => api(`/outbox/${o.id}/send`, { method: 'POST' }).then(() => toast('已发送')).catch(toastError)}>立即发送</button>
                    <button className="btn sm ghost danger" onClick={() => confirm('取消这封定时邮件？内容不会保留。') && api(`/outbox/${o.id}`, { method: 'DELETE' }).catch(toastError)}>取消</button>
                  </div>
                </div>
              </div>
            ))}
          {view !== 'outbox' && items.map((m, index) => {
            const outgoing = m.folder_role === 'sent' || m.folder_role === 'drafts';
            return (
              <div
                key={m.id}
                data-index={index}
                className={`msg${m.seen && !m.thread_unread ? '' : ' unread'}${m.id === openId ? ' active' : ''}${selected.has(m.id) ? ' selected' : ''}`}
                onMouseDown={(e) => sel.onRowMouseDown(e, index)}
                onClick={(e) => sel.onRowClick(e, index) && open(m.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, items: mailMenu(m) });
                }}
              >
                {accounts.length > 1 && <span className="msg-bar" style={{ background: accountOf(m.account_id)?.color }} />}
                <label className="msg-mark" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(m.id)}
                    onChange={() => sel.toggle(m.id)}
                  />
                  {!m.seen && <span className="dot" />}
                </label>
                <div style={{ minWidth: 0 }}>
                  <div className="msg-top">
                    <span className="msg-from truncate">{outgoing ? `收件人：${addrText(m.to)}` : m.from_name || m.from_addr}</span>
                    {(m.thread_count ?? 1) > 1 && <span className="thread-count">{m.thread_count}</span>}
                    <span className="msg-date">{shortDate(m.date)}</span>
                  </div>
                  <div className="msg-subject">
                    <span className="truncate grow">{m.subject || '(无主题)'}</span>
                    {m.answered ? <Reply size={13} /> : null}
                    {m.has_attachments ? <Paperclip size={13} /> : null}
                    {m.flagged ? <Star size={13} className="star" /> : null}
                  </div>
                  <div className="msg-snippet truncate">
                    {view !== 'folder' && view !== 'inbox' && view !== 'unread' && view !== 'snoozed' && <span className="chip" style={{ height: 18, marginRight: 6 }}>{folderLabel({ role: m.folder_role, name: m.folder_name })}</span>}
                    {m.code && (
                      <button
                        className="code-chip"
                        title="点击复制验证码"
                        onClick={(e) => (e.stopPropagation(), copyText(m.code!))}
                      >
                        <KeyRound size={11} /> {m.code}
                      </button>
                    )}
                    {m.snoozed_until && <span className="chip accent" style={{ height: 18, marginRight: 6 }}>{dueLabel(m.snoozed_until)}</span>}
                    {m.snippet || ' '}
                  </div>
                </div>
              </div>
            );
          })}
          {list.isFetchingNextPage && <div className="muted small" style={{ padding: 16, textAlign: 'center' }}>加载中…</div>}
          {view === 'outbox' && !outbox.data?.length && <div className="empty"><Clock size={40} />没有等待发送的邮件</div>}
          {view !== 'outbox' && !list.isLoading && !items.length && (
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
              {current.folder_role === 'drafts' && (
                <button className="btn sm accent" onClick={() => editDraft(current)}><PenSquare size={15} /> 继续编辑</button>
              )}
              <div className="menu" onMouseLeave={() => setSnoozeMenu(false)}>
                <button className={`icon-btn${current.snoozed_until ? ' on' : ''}`} title="稍后处理" onClick={() => setSnoozeMenu(!snoozeMenu)}><AlarmClock size={18} /></button>
                {snoozeMenu && (
                  <div className="card menu-pop">
                    {snoozeOptions().map((o) => (
                      <button key={o.label} onClick={() => snooze([current.id], o.at)}>{o.label}</button>
                    ))}
                    {current.snoozed_until && <button onClick={() => snooze([current.id], null)}>取消稍后处理</button>}
                  </div>
                )}
              </div>
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
                {current.thread_id && (
                  <Conversation threadId={current.thread_id} currentId={current.id} part="before" blockRemote={user.settings.blockRemoteImages} onOpen={(id) => open(id)} />
                )}
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
                {current.code && (
                  <button className="code-banner" onClick={() => copyText(current.code!)} title="点击复制">
                    <KeyRound size={18} />
                    <span className="muted">验证码</span>
                    <b>{current.code}</b>
                    <span className="grow" />
                    <Copy size={15} /> 复制
                  </button>
                )}
                {ai.data && accountOf(current.account_id)?.ai_enabled ? (
                  <AiBar key={current.id} message={current} active={ai.data.active} translateTo={user.settings.translateTo} onReply={(text) => startCompose('reply', current, text)} />
                ) : null}
                <LinksPanel links={current.links} />
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
                {current.thread_id && (
                  <Conversation threadId={current.thread_id} currentId={current.id} part="after" blockRemote={user.settings.blockRemoteImages} onOpen={(id) => open(id)} />
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

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
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
