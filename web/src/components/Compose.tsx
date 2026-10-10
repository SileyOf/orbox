import { Bold, Italic, Link2, List, Paperclip, Quote, Underline, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Account } from '../api';
import { fileSize, toast, toastError } from '../lib';

export interface Draft {
  accountId: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  replyTo?: number;
  forwardOf?: number;
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

async function deliver(d: Draft, text: string) {
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
    }),
  );
  for (const f of d.files) form.append('file', f, f.name);
  await api('/send', { form });
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
  const persist = !initial.replyTo && !initial.forwardOf;

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

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const cmd = (name: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(name, false, value);
    set('html', editor.current!.innerHTML);
  };
  const addFiles = (list: FileList | null) => list && set('files', [...d.files, ...list]);

  function discard() {
    if (persist) localStorage.removeItem(DRAFT_KEY);
    onClose();
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
        if (e.key === 'Escape') onClose();
        e.stopPropagation();
      }}
    >
      <div className="compose-head">
        <span className="grow">{d.replyTo ? '回复' : d.forwardOf ? '转发' : '写邮件'}</span>
        <button className="icon-btn" onClick={onClose} title={persist ? '收起（内容会保留为草稿）' : '关闭'}>
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
        <button className="icon-btn" title="添加附件" onClick={() => fileInput.current?.click()}>
          <Paperclip size={18} />
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
        {d.forwardOf && <span className="muted small">原邮件的附件会一并转发</span>}
        <span className="grow" />
        <button className="btn ghost sm danger" onClick={discard}>
          丢弃
        </button>
      </div>
    </div>
  );
}
