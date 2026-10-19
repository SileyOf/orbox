import { Eraser, Send, Sparkles, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { PendingMail } from '../api';
import { toast, toastError } from '../lib';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  pending?: (PendingMail & { state?: 'sent' | 'dropped' })[];
}

const STORE = 'orbox.assistant';
const SUGGESTIONS = ['今天有哪些重要邮件？', '这周有什么账单要付？', '把最近的验证码邮件都标为已读', '明天下午三点提醒我给妈妈打电话'];

/** 只处理加粗、行内代码和链接三种标记 */
function rich(text: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<b key={m.index}>{m[1]}</b>);
    else if (m[2] !== undefined) out.push(<code key={m.index}>{m[2]}</code>);
    else out.push(<a key={m.index} href={m[4]} target="_blank" rel="noopener noreferrer">{m[3]}</a>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

export function Assistant({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [turns, setTurns] = useState<Turn[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(STORE) || '[]');
    } catch {
      return [];
    }
  });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(turns.slice(-40)));
    } catch {}
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setText('');
    setTurns((t) => [...t, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const r = await api<{ text: string; pending: PendingMail[] }>('/ai/chat', { body: { text: q } });
      setTurns((t) => [...t, { role: 'assistant', text: r.text, pending: r.pending }]);
    } catch (e: any) {
      setTurns((t) => [...t, { role: 'assistant', text: `⚠️ ${e.message}` }]);
      if (/还没有配置/.test(e.message)) toast('先在设置里配置 AI 模型', { action: { label: '去设置', run: () => navigate('/settings#ai') } });
    } finally {
      setBusy(false);
    }
  }

  async function decide(turn: number, id: string, verb: 'send' | 'drop') {
    try {
      await api(`/ai/pending/${id}/${verb}`, { method: 'POST' });
      toast(verb === 'send' ? '已发送' : '已取消');
      setTurns((t) => t.map((x, i) => (i === turn ? { ...x, pending: x.pending?.map((p) => (p.id === id ? { ...p, state: verb === 'send' ? 'sent' : 'dropped' } : p)) } : x)));
    } catch (e) {
      toastError(e);
    }
  }

  async function reset() {
    await api('/ai/reset', { method: 'POST' }).catch(() => {});
    setTurns([]);
  }

  return (
    <aside className="assistant">
      <div className="assistant-head">
        <Sparkles size={17} />
        <b className="grow">助手</b>
        <button className="icon-btn" title="开始新对话" onClick={reset}><Eraser size={16} /></button>
        <button className="icon-btn" title="关闭" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="assistant-body" ref={scroller}>
        {!turns.length && (
          <div className="assistant-empty">
            <p className="muted">我能查邮件、读邮件、整理计划、帮你起草回复。起草的邮件要你点"发送"才会发出。</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="btn sm" onClick={() => ask(s)}>{s}</button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`bubble ${t.role === 'user' ? 'from-user' : 'from-ai'}`}>
            <div className="bubble-text">{rich(t.text)}</div>
            {t.pending?.map((p) => (
              <div key={p.id} className="pending-mail">
                <div className="small muted">待确认的邮件</div>
                <pre>{p.summary}</pre>
                {p.state ? (
                  <div className="small muted">{p.state === 'sent' ? '✉️ 已发送' : '已取消'}</div>
                ) : (
                  <div className="row">
                    <button className="btn sm primary" onClick={() => decide(i, p.id, 'send')}><Send size={13} /> 发送</button>
                    <button className="btn sm ghost" onClick={() => decide(i, p.id, 'drop')}>取消</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {busy && <div className="bubble from-ai"><div className="ai-loading"><Sparkles size={15} className="spin" /> 正在处理…</div></div>}
      </div>
      <form
        className="assistant-input"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <textarea
          className="textarea"
          rows={2}
          placeholder="问点什么，回车发送，Shift+回车换行"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              ask(text);
            }
            e.stopPropagation();
          }}
        />
        <button className="btn accent" disabled={busy || !text.trim()}><Send size={15} /></button>
      </form>
    </aside>
  );
}
