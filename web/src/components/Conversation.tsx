import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import type { MessageFull, MessageItem } from '../api';
import { shortDate } from '../lib';
import { MessageBody } from './MessageBody';

/** 会话里的其他邮件：比当前这封早的放在上面、晚的放在下面，默认折叠成一行，点开再加载正文 */
export function Conversation(props: { threadId: string; currentId: number; part: 'before' | 'after'; blockRemote: boolean; onOpen: (id: number) => void }) {
  const thread = useQuery({
    queryKey: ['thread', props.threadId],
    queryFn: () => api<MessageItem[]>(`/threads/${props.threadId}`),
    staleTime: 60_000,
  });
  const all = thread.data || [];
  const at = all.findIndex((m) => m.id === props.currentId);
  const others = at < 0 ? [] : props.part === 'before' ? all.slice(0, at) : all.slice(at + 1);
  const [showAll, setShowAll] = useState(false);
  if (!others.length) return null;
  // 很长的会话只露出离当前最近的几封，其余收起
  const visible = showAll ? others : props.part === 'before' ? others.slice(-3) : others.slice(0, 3);
  return (
    <div className={`conversation ${props.part}`}>
      {props.part === 'before' && <div className="muted small" style={{ marginBottom: 6 }}>这个会话共 {all.length} 封邮件</div>}
      {others.length > visible.length && (
        props.part === 'before' && <button className="btn ghost sm" onClick={() => setShowAll(true)}>显示更早的 {others.length - visible.length} 封</button>
      )}
      {props.part === 'after' && <div className="muted small">之后的回复</div>}
      {visible.map((m) => (
        <ConversationItem key={m.id} item={m} blockRemote={props.blockRemote} onOpen={props.onOpen} />
      ))}
      {props.part === 'after' && others.length > visible.length && (
        <button className="btn ghost sm" onClick={() => setShowAll(true)}>显示后面的 {others.length - visible.length} 封</button>
      )}
    </div>
  );
}

function ConversationItem({ item, blockRemote, onOpen }: { item: MessageItem; blockRemote: boolean; onOpen: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const full = useQuery({ queryKey: ['message', item.id], queryFn: () => api<MessageFull>(`/messages/${item.id}`), enabled: open });
  const outgoing = item.folder_role === 'sent';
  return (
    <div className={`conv-item${open ? ' open' : ''}`}>
      <button className="conv-head" onClick={() => setOpen(!open)}>
        <b className="truncate" style={{ maxWidth: 180 }}>{outgoing ? '我' : item.from_name || item.from_addr}</b>
        <span className="truncate grow muted">{open ? '' : item.snippet}</span>
        <span className="muted small">{shortDate(item.date)}</span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {full.data ? <MessageBody message={full.data} blockRemote={blockRemote} /> : <div className="muted small">加载中…</div>}
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => onOpen(item.id)}>单独打开这封</button>
        </div>
      )}
    </div>
  );
}
