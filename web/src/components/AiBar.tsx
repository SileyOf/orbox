import { useMutation } from '@tanstack/react-query';
import { CalendarPlus, FileText, Languages, PenLine, RefreshCw, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import type { AiTaskName, MessageFull, TodoSuggestion } from '../api';
import { toast, toastError } from '../lib';

type Panel = 'summary' | 'translate' | 'todos' | 'reply' | null;

/**
 * 阅读区里的 AI 工具条：摘要、翻译、提取待办、AI 起草回复。
 * 只有配置了模型、并且这个邮箱开启了"允许 AI 读取"时才出现。
 */
export function AiBar(props: { message: MessageFull; active: Record<AiTaskName, boolean>; translateTo: string; onReply: (text: string) => void }) {
  const { message: m } = props;
  const [panel, setPanel] = useState<Panel>(null);
  const [instruction, setInstruction] = useState('');
  const summary = useMutation({ mutationFn: (fresh: boolean) => api<{ text: string }>(`/messages/${m.id}/ai/summary`, { body: { fresh } }) });
  const translation = useMutation({ mutationFn: () => api<{ text: string }>(`/messages/${m.id}/ai/translate`, { body: {} }) });
  const todos = useMutation({ mutationFn: () => api<{ items: TodoSuggestion[] }>(`/messages/${m.id}/ai/todos`, { body: {} }) });
  const reply = useMutation({
    mutationFn: () => api<{ text: string }>(`/messages/${m.id}/ai/reply`, { body: { instruction } }),
    onSuccess: (r) => {
      props.onReply(r.text);
      setPanel(null);
    },
    onError: toastError,
  });

  function open(p: Exclude<Panel, null>) {
    setPanel(panel === p ? null : p);
    if (p === 'summary' && !summary.data) summary.mutate(false);
    if (p === 'translate' && !translation.data) translation.mutate();
    if (p === 'todos' && !todos.data) todos.mutate();
  }

  async function addTodo(t: TodoSuggestion) {
    try {
      await api(`/messages/${m.id}/task`, {
        body: { title: t.title, notes: t.notes || null, dueAt: t.due ? new Date(t.due).toISOString() : null },
      });
      toast(`已加入计划：${t.title}`);
    } catch (e) {
      toastError(e);
    }
  }

  const busy = (q: { isPending: boolean }) => q.isPending && <div className="ai-loading"><Sparkles size={15} className="spin" /> 正在思考…</div>;
  const failed = (q: { error: Error | null }) => q.error && <div className="ai-error">{q.error.message}</div>;

  if (!props.active.summary && !props.active.translate && !props.active.todos && !props.active.reply) return null;
  return (
    <div className="ai-bar">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {props.active.summary && <button className={`btn sm${panel === 'summary' ? ' accent' : ''}`} onClick={() => open('summary')}><FileText size={14} /> 摘要</button>}
        {props.active.translate && <button className={`btn sm${panel === 'translate' ? ' accent' : ''}`} onClick={() => open('translate')}><Languages size={14} /> 翻译成{props.translateTo}</button>}
        {props.active.todos && <button className={`btn sm${panel === 'todos' ? ' accent' : ''}`} onClick={() => open('todos')}><CalendarPlus size={14} /> 提取待办</button>}
        {props.active.reply && <button className={`btn sm${panel === 'reply' ? ' accent' : ''}`} onClick={() => setPanel(panel === 'reply' ? null : 'reply')}><PenLine size={14} /> AI 回复</button>}
      </div>
      {panel && (
        <div className="ai-panel">
          <button className="icon-btn ai-close" onClick={() => setPanel(null)} title="收起"><X size={15} /></button>
          {panel === 'summary' && (
            <>
              {busy(summary)}
              {failed(summary)}
              {summary.data && (
                <>
                  <div className="ai-text">{summary.data.text}</div>
                  <button className="btn ghost sm" onClick={() => summary.mutate(true)}><RefreshCw size={13} /> 重新生成</button>
                </>
              )}
            </>
          )}
          {panel === 'translate' && (
            <>
              {busy(translation)}
              {failed(translation)}
              {translation.data && <div className="ai-text">{translation.data.text}</div>}
            </>
          )}
          {panel === 'todos' && (
            <>
              {busy(todos)}
              {failed(todos)}
              {todos.data && !todos.data.items.length && <div className="muted">这封邮件里没有需要你去做的事。</div>}
              {todos.data?.items.map((t, i) => (
                <div className="ai-todo" key={i}>
                  <div className="grow">
                    <b>{t.title}</b>
                    <div className="muted small">{[t.due && t.due.replace('T', ' '), t.notes].filter(Boolean).join(' · ') || '没有明确时间'}</div>
                  </div>
                  <button className="btn sm" onClick={() => addTodo(t)}>加入计划</button>
                </div>
              ))}
            </>
          )}
          {panel === 'reply' && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                reply.mutate();
              }}
            >
              <input
                className="input grow"
                autoFocus
                placeholder="想怎么回？例如：答应周三前反馈，顺便问下预算（可留空）"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
              <button className="btn primary" disabled={reply.isPending}>{reply.isPending ? '起草中…' : '起草'}</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
