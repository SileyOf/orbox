import { Bold, Clock, Italic, Link2, List, Paperclip, Quote, Underline, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Account } from '../api';
import { dueLabel, fileSize, toLocalInput, toast, toastError } from '../lib';

export interface Draft {
  accountId: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  replyTo?: number;
  forwardOf?: number;
  /** 正在继续编辑的服务器草稿 */
  draftOf?: number;
  files: File[];
}

const DRAFT_KEY = 'orbox.draft';
const UNDO_MS = 5000;

/** 新邮件的未发送草稿存在浏览器本地，防止误关丢失 */
export function loadSavedDraft(): Omit<Draft, 'files'> | null {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    return null;
  }
}

const splitAddrs = (s: string) => s.split(/[,;，；\n]+/).map((a) => a.trim()).filter(Boolean);

/** 定时发送的快捷时间点 */
function presets(): { label: string; at: Date }[] {
  const now = new Date();
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour);
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    ...(now.getHours() < 19 ? [{ label: '今晚 20:00', at: at(0, 20) }] : []),
    { label: '明早 9:00', at: at(1, 9) },
    { label: '下周一 9:00', at: at(toMonday, 9) },
  ];
}

async function deliver(d: Draft, text: string, opts: { sendAt?: Date; asDraft?: boolean } = {}) {
  const form = new FormData();
  form.append(
    'payload',
    JSON.stringify({
      accountId: d.accountId,
      to: splitAddrs(d.to),
      cc: splitAddrs(d.cc),
      bcc: splitAddrs(d.bcc),
      subject: d.subject,
      html: d.html,
      text,
      replyTo: d.replyTo,
      forwardOf: d.forwardOf,
      draftOf: d.draftOf,
      sendAt: opts.sendAt?.toISOString(),
    }),
  );
  for (const f of d.files) form.append('file', f, f.name);
  await api(opts.asDraft ? '/drafts' : '/send', { form });
}

interface Props {
  initial: Draft;
  accounts: Account[];
  onClose: () => void;
  /** 发送失败或撤销时带着内容重新打开 */
  onReopen: (d: Draft) => void;
}

export function Compose({ initial, accounts, onClose, onReopen }: Props) {
  const [d, setD] = useState(initial);
  const [showCc, setShowCc] = useState(!!(initial.cc || initial.bcc));
  const editor = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const persist = !initial.replyTo && !initial.forwardOf && !initial.draftOf;
  const [menu, setMenu] = useState(false);
  const [customAt, setCustomAt] = useState('');
  const dirty = useRef(false);

  useEffect(() => {
    if (editor.current) editor.current.innerHTML = initial.html;
    // 回复时光标落在正文开头，新邮件先填收件人
    if (initial.to) editor.current?.focus();
  }, []);

  useEffect(() => {
    if (!persist) return;
    const { files, ...rest } = d;
    const t = setTimeout(() => localStorage.setItem(DRAFT_KEY, JSON.stringify(rest)), 400);
    return () => clearTimeout(t);
  }, [d, persist]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    dirty.current = true;
    setD((prev) => ({ ...prev, [k]: v }));
  };
  const cmd = (name: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(name, false, value);
    set('html', editor.current!.innerHTML);
  };
  const addFiles = (list: FileList | null) => list && set('files', [...d.files, ...list]);

  function discard() {
    if (persist) localStorage.removeItem(DRAFT_KEY);
    if (d.draftOf) api('/messages/move', { body: { ids: [d.draftOf], to: 'trash' } }).catch(toastError);
    onClose();
  }

  /** 关闭时把改动存进邮箱的草稿箱，换设备也能接着写 */
  function closeAndSave() {
    const draft = { ...d, html: editor.current!.innerHTML };
    const text = editor.current!.innerText;
    onClose();
    if (!dirty.current || !(draft.to || draft.subject || text.trim())) return;
    deliver(draft, text, { asDraft: true })
      .then(() => {
        if (persist) localStorage.removeItem(DRAFT_KEY);
        toast('已存入草稿箱');
      })
      .catch(toastError);
  }

  function schedule(at: Date) {
    if (!splitAddrs(d.to + ',' + d.cc + ',' + d.bcc).length) return toast('请填写收件人', { kind: 'error' });
    if (at.getTime() < Date.now() + 60_000) return toast('请选择一个将来的时间', { kind: 'error' });
    const draft = { ...d, html: editor.current!.innerHTML };
    const text = editor.current!.innerText;
    onClose();
    deliver(draft, text, { sendAt: at })
      .then(() => {
        if (persist) localStorage.removeItem(DRAFT_KEY);
        toast(`已安排在${dueLabel(at.toISOString())}发送`);
      })
      .catch((e) => {
        toastError(e);
        onReopen(draft);
      });
  }

  function send() {
    if (!splitAddrs(d.to + ',' + d.cc + ',' + d.bcc).length) return toast('请填写收件人', { kind: 'error' });
    if (!d.subject.trim() && !confirm('主题为空，确定发送吗？')) return;
    const draft = { ...d, html: editor.current!.innerHTML };
    const text = editor.current!.innerText;
    onClose();
    // 延迟几秒再真正发出，给撤销留出时间
    let cancelled = false;
    toast('正在发送…', {
      ms: UNDO_MS,
      action: {
        label: '撤销',
        run: () => {
          cancelled = true;
          onReopen(draft);
        },
      },
    });
    setTimeout(async () => {
      if (cancelled) return;
      try {
        await deliver(draft, text);
        if (persist) localStorage.removeItem(DRAFT_KEY);
        toast('已发送');
      } catch (e) {
        toastError(e);
        onReopen(draft);
      }
    }, UNDO_MS);
  }

  return (
    <div
      className="compose"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
        if (e.key === 'Escape') closeAndSave();
        e.stopPropagation();
      }}
    >
      <div className="compose-head">
        <span className="grow">{d.replyTo ? '回复' : d.forwardOf ? '转发' : d.draftOf ? '编辑草稿' : '写邮件'}</span>
        <button className="icon-btn" onClick={closeAndSave} title="关闭（有改动会存入草稿箱）">
          <X size={18} />
        </button>
      </div>
      {accounts.length > 1 && (
        <div className="compose-row">
          <label>发件人</label>
          <select value={d.accountId} onChange={(e) => set('accountId', Number(e.target.value))}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} &lt;{a.email}&gt;
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="compose-row">
        <label>收件人</label>
        <input value={d.to} onChange={(e) => set('to', e.target.value)} placeholder="多个地址用逗号分隔" autoFocus={!initial.to} />
        {!showCc && (
          <button className="btn ghost sm" onClick={() => setShowCc(true)}>
            抄送
          </button>
        )}
      </div>
      {showCc && (
        <>
          <div className="compose-row">
            <label>抄送</label>
            <input value={d.cc} onChange={(e) => set('cc', e.target.value)} />
          </div>
          <div className="compose-row">
            <label>密送</label>
            <input value={d.bcc} onChange={(e) => set('bcc', e.target.value)} />
          </div>
        </>
      )}
      <div className="compose-row">
        <label>主题</label>
        <input value={d.subject} onChange={(e) => set('subject', e.target.value)} />
      </div>
      <div className="editor-bar">
        <button className="icon-btn" title="加粗" onClick={() => cmd('bold')}><Bold size={16} /></button>
        <button className="icon-btn" title="斜体" onClick={() => cmd('italic')}><Italic size={16} /></button>
        <button className="icon-btn" title="下划线" onClick={() => cmd('underline')}><Underline size={16} /></button>
        <button className="icon-btn" title="列表" onClick={() => cmd('insertUnorderedList')}><List size={16} /></button>
        <button className="icon-btn" title="引用" onClick={() => cmd('formatBlock', 'blockquote')}><Quote size={16} /></button>
        <button
          className="icon-btn"
          title="链接"
          onClick={() => {
            const url = prompt('链接地址', 'https://');
            if (url && /^https?:\/\//i.test(url)) cmd('createLink', url);
          }}
        >
          <Link2 size={16} />
        </button>
      </div>
      <div
        ref={editor}
        className="editor"
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => set('html', e.currentTarget.innerHTML)}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }
        }}
      />
      {d.files.length > 0 && (
        <div className="compose-atts">
          {d.files.map((f, i) => (
            <span className="chip" key={i}>
              {f.name} · {fileSize(f.size)}
              <X size={13} style={{ cursor: 'pointer' }} onClick={() => set('files', d.files.filter((_, j) => j !== i))} />
            </span>
          ))}
        </div>
      )}
      <div className="compose-foot">
        <button className="btn accent" onClick={send}>
          发送
        </button>
        <div className="menu" onMouseLeave={() => setMenu(false)}>
          <button className="icon-btn" title="定时发送" onClick={() => setMenu(!menu)}>
            <Clock size={18} />
          </button>
          {menu && (
            <div className="card menu-pop up">
              {presets().map((p) => (
                <button key={p.label} onClick={() => schedule(p.at)}>{p.label}</button>
              ))}
              <div className="menu-custom">
                <input
                  className="input"
                  type="datetime-local"
                  min={toLocalInput(new Date().toISOString())}
                  value={customAt}
                  onChange={(e) => setCustomAt(e.target.value)}
                />
                <button className="btn sm primary" disabled={!customAt} onClick={() => schedule(new Date(customAt))}>确定</button>
              </div>
            </div>
          )}
        </div>
        <button className="icon-btn" title="添加附件" onClick={() => fileInput.current?.click()}>
          <Paperclip size={18} />
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
        {d.forwardOf && <span className="muted small">原邮件的附件会一并转发</span>}
        {d.draftOf && <span className="muted small">草稿里已有的附件会保留</span>}
        <span className="grow" />
        <button className="btn ghost sm danger" onClick={discard}>
          丢弃
        </button>
      </div>
    </div>
  );
}
