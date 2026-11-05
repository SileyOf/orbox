import { useQuery } from '@tanstack/react-query';
import { Briefcase, ChevronLeft, ChevronRight, Download, Hash, Pencil, Plus, Receipt, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import type { Note, NoteSummary, User } from '../api';
import { money, toast, toastError } from '../lib';

// 简单记：一句话记事、记账；出差期间的花费自动归到这次出差，月底按分类汇总、导出报销表。

interface NotesData {
  notes: Note[];
  summary: NoteSummary;
  trip: User['settings']['trip'] | null;
  categories: string[];
}

type Filter = 'all' | 'spent' | 'pending' | 'memo';

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dayLabel = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  const today = new Date();
  const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - d.getTime()) / 86400_000);
  const base = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
  return diff === 0 ? `今天 · ${base}` : diff === 1 ? `昨天 · ${base}` : base;
};

export function NotesView() {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [tag, setTag] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  // 按标签（例如某次出差）查看时不限月份，出差可能跨月
  const query = tag ? `tag=${encodeURIComponent(tag)}` : `month=${monthKey(month)}`;
  const q = useQuery({ queryKey: ['notes', query], queryFn: () => api<NotesData>(`/notes?${query}`) });
  const d = q.data;

  const visible = useMemo(
    () =>
      (d?.notes || []).filter((n) =>
        filter === 'spent' ? n.amount !== null : filter === 'pending' ? n.reimbursable && !n.reimbursed : filter === 'memo' ? n.amount === null : true,
      ),
    [d, filter],
  );
  const days = useMemo(() => {
    const map = new Map<string, Note[]>();
    for (const n of visible) map.set(n.day, [...(map.get(n.day) || []), n]);
    return [...map.entries()];
  }, [visible]);
  const tags = useMemo(() => [...new Set((d?.notes || []).flatMap((n) => n.tags || []))], [d]);

  async function quick(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      const r = await api<{ note?: Note; trip?: string; tripEnded?: string }>('/notes/quick', { body: { text } });
      setText('');
      if (r.trip) toast(`已开始「${r.trip}」，之后记的花费会自动归到这次出差`);
      else if (r.tripEnded) toast(`「${r.tripEnded}」已结束`, { action: { label: '查看汇总', run: () => setTag(r.tripEnded!) } });
      else if (r.note) {
        const n = r.note;
        toast(`已记下：${n.content}${n.amount !== null ? ` ${money(n.amount, n.currency)}` : ''}${n.reimbursable ? ' · 可报销' : ''}`, {
          action: { label: '修改', run: () => setEditing(n) },
        });
      }
      q.refetch();
    } catch (err) {
      toastError(err);
    }
  }

  const reimburse = (ids: number[], value: boolean) =>
    api('/notes/reimbursed', { body: { ids, value } })
      .then(() => q.refetch())
      .catch(toastError);
  const remove = (ids: number[]) =>
    api('/notes/delete', { body: { ids } })
      .then(() => q.refetch())
      .catch(toastError);
  const endTrip = () =>
    api('/notes/trip', { method: 'PUT', body: null })
      .then(() => (toast(`「${d?.trip?.name}」已结束`), q.refetch()))
      .catch(toastError);

  const currencies = Object.entries(d?.summary.byCurrency || {});
  const pendingIds = visible.filter((n) => n.reimbursable && !n.reimbursed).map((n) => n.id);
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <div className="notes">
      <form className="card quick-add" onSubmit={quick}>
        <Plus size={18} className="muted" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={d?.trip ? `出差中：打车 56、酒店 420…（发"出差结束"结束）` : '打车 56 报销 / 今天出差去上海 / 护照放在书房抽屉'}
        />
        <button type="button" className="btn ghost sm" onClick={() => setEditing('new')}>
          详细
        </button>
      </form>

      {d?.trip && (
        <div className="card trip-banner">
          <Briefcase size={16} />
          <div className="grow">
            <b>{d.trip.name}</b>
            <div className="muted small">自 {d.trip.start} 起，记的花费自动归到这次出差、标为可报销</div>
          </div>
          <button className="btn sm ghost" onClick={() => setTag(d.trip!.name)}>
            查看
          </button>
          <button className="btn sm" onClick={endTrip}>
            结束出差
          </button>
        </div>
      )}

      <div className="row notes-bar">
        {tag ? (
          <>
            <span className="chip accent">
              <Hash size={12} /> {tag}
            </span>
            <button className="btn ghost sm" onClick={() => setTag(null)}>
              返回按月查看
            </button>
          </>
        ) : (
          <>
            <button className="icon-btn" onClick={() => shift(-1)} title="上个月">
              <ChevronLeft size={17} />
            </button>
            <b>
              {month.getFullYear()}年{month.getMonth() + 1}月
            </b>
            <button className="icon-btn" onClick={() => shift(1)} title="下个月">
              <ChevronRight size={17} />
            </button>
          </>
        )}
        <span className="grow" />
        <div className="tabs">
          {(['all', 'spent', 'pending', 'memo'] as const).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {{ all: '全部', spent: '花费', pending: '待报销', memo: '备忘' }[f]}
            </button>
          ))}
        </div>
        <a className="btn sm" href={`/api/notes/export.csv?${query}`} download>
          <Download size={14} /> 导出
        </a>
      </div>

      {currencies.length > 0 && (
        <div className="notes-summary">
          {currencies.map(([cur, c]) => {
            const cats = Object.entries(c.byCategory).sort((a, b) => b[1] - a[1]);
            const max = Math.max(...cats.map(([, v]) => Math.abs(v)), 1);
            return (
              <div className="card" key={cur}>
                <div className="row">
                  <div className="grow">
                    <div className="muted small">{tag ? '合计' : '本月支出'}{currencies.length > 1 ? ` · ${cur}` : ''}</div>
                    <b className="big">{money(c.total, cur)}</b>
                  </div>
                  {c.reimbursable > 0 && (
                    <div style={{ textAlign: 'right' }}>
                      <div className="muted small">可报销 {money(c.reimbursable, cur)}</div>
                      <div className={c.pending ? 'accent-ink' : 'muted'} style={{ fontWeight: 600 }}>
                        {c.pending ? `待报销 ${money(c.pending, cur)}` : '已全部报销'}
                      </div>
                    </div>
                  )}
                </div>
                <div className="cat-bars">
                  {cats.map(([name, v]) => (
                    <div key={name} className="cat-bar">
                      <span>{name}</span>
                      <i style={{ width: `${(Math.abs(v) / max) * 100}%` }} />
                      <span className="muted">{money(v, cur)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!tag && tags.length > 0 && (
        <div className="task-meta">
          {tags.map((t) => (
            <button key={t} className="chip tag" style={{ border: 0 }} onClick={() => setTag(t)}>
              <Hash size={11} />
              {t}
            </button>
          ))}
        </div>
      )}

      {filter === 'pending' && pendingIds.length > 0 && (
        <div className="row">
          <span className="muted small grow">{pendingIds.length} 笔待报销</span>
          <button className="btn sm" onClick={() => reimburse(pendingIds, true)}>
            <Receipt size={14} /> 全部标为已报销
          </button>
        </div>
      )}

      {days.map(([day, notes]) => (
        <div className="task-group" key={day}>
          <h3>
            {dayLabel(day)}{' '}
            <span>
              {notes
                .filter((n) => n.amount !== null && n.currency === 'CNY')
                .reduce((a, n) => a + Number(n.amount), 0) > 0 &&
                money(
                  notes.filter((n) => n.amount !== null && n.currency === 'CNY').reduce((a, n) => a + Number(n.amount), 0),
                  'CNY',
                )}
            </span>
          </h3>
          <div className="card task-list">
            {notes.map((n) => (
              <div key={n.id} className="task note-row" onClick={() => setEditing(n)}>
                <span className={`note-cat cat-${n.amount === null ? 'memo' : 'spent'}`}>{n.category.slice(0, 2)}</span>
                <div className="task-body">
                  <div className="task-title">{n.content}</div>
                  {(n.reimbursable || (n.tags || []).length > 0) && (
                    <div className="task-meta">
                      {n.reimbursable ? (
                        <button
                          className={`chip${n.reimbursed ? '' : ' accent'}`}
                          style={{ border: 0, cursor: 'pointer' }}
                          title={n.reimbursed ? '点击改为未报销' : '点击标为已报销'}
                          onClick={(e) => (e.stopPropagation(), reimburse([n.id], !n.reimbursed))}
                        >
                          <Receipt size={11} /> {n.reimbursed ? '已报销' : '待报销'}
                        </button>
                      ) : null}
                      {(n.tags || []).map((t) => (
                        <span key={t} className="chip tag" onClick={(e) => (e.stopPropagation(), setTag(t))}>
                          <Hash size={11} />
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {n.amount !== null && <b className="note-amount">{money(n.amount, n.currency)}</b>}
                <div className="task-actions">
                  <button className="icon-btn" title="编辑" onClick={(e) => (e.stopPropagation(), setEditing(n))}>
                    <Pencil size={15} />
                  </button>
                  <button className="icon-btn" title="删除" onClick={(e) => (e.stopPropagation(), remove([n.id]))}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {d && !days.length && (
        <div className="empty" style={{ height: 240 }}>
          <Receipt size={40} />
          {tag ? '这个标签下没有记录' : '这个月还没有记录。出差、花钱、要记住的事，一句话记下来'}
        </div>
      )}

      {editing && <NoteDialog note={editing === 'new' ? null : editing} categories={d?.categories || []} onClose={() => setEditing(null)} onSaved={() => q.refetch()} />}
    </div>
  );
}

function NoteDialog({ note, categories, onClose, onSaved }: { note: Note | null; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const today = new Date();
  const [f, setF] = useState({
    day: note?.day ?? `${monthKey(today)}-${String(today.getDate()).padStart(2, '0')}`,
    content: note?.content ?? '',
    amount: note?.amount !== null && note?.amount !== undefined ? String(Number(note.amount)) : '',
    currency: note?.currency ?? 'CNY',
    category: note?.category ?? '其他',
    tags: (note?.tags || []).join(' '),
    reimbursable: !!note?.reimbursable,
    reimbursed: !!note?.reimbursed,
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });

  async function save(e: FormEvent) {
    e.preventDefault();
    const amount = f.amount.trim() === '' ? null : Number(f.amount);
    if (amount !== null && !Number.isFinite(amount)) return toast('金额格式不对', { kind: 'error' });
    const body = {
      day: f.day,
      content: f.content,
      amount,
      currency: f.currency,
      category: amount === null && f.category === '其他' ? '备忘' : f.category,
      tags: [...new Set(f.tags.split(/[\s,，#]+/).filter(Boolean))].slice(0, 10),
      reimbursable: f.reimbursable,
      reimbursed: f.reimbursed,
    };
    try {
      await api(note ? `/notes/${note.id}` : '/notes', { method: note ? 'PATCH' : 'POST', body });
      onSaved();
      onClose();
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={save}>
        <h2>{note ? '编辑记录' : '记一笔'}</h2>
        <label className="field">
          <span>内容</span>
          <input className="input" required maxLength={1000} autoFocus value={f.content} onChange={(e) => set({ content: e.target.value })} placeholder="打车去机场 / 护照放在书房抽屉" />
        </label>
        <div className="grid2">
          <label className="field">
            <span>日期</span>
            <input className="input" type="date" required value={f.day} onChange={(e) => set({ day: e.target.value })} />
          </label>
          <label className="field">
            <span>金额（不是花费就留空）</span>
            <div className="row" style={{ gap: 6 }}>
              <input className="input grow" inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} placeholder="0.00" />
              <select className="select" style={{ width: 82 }} value={f.currency} onChange={(e) => set({ currency: e.target.value })}>
                {['CNY', 'USD', 'JPY', 'EUR', 'HKD', 'GBP'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </label>
          <label className="field">
            <span>分类</span>
            <select className="select" value={f.category} onChange={(e) => set({ category: e.target.value })}>
              {[...new Set([...categories, f.category])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>标签（空格分隔）</span>
            <input className="input" value={f.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="上海出差 11/05" />
          </label>
        </div>
        <div className="row" style={{ gap: 18 }}>
          <label className="row small">
            <input type="checkbox" checked={f.reimbursable} onChange={(e) => set({ reimbursable: e.target.checked, reimbursed: e.target.checked && f.reimbursed })} /> 需要报销
          </label>
          {f.reimbursable && (
            <label className="row small">
              <input type="checkbox" checked={f.reimbursed} onChange={(e) => set({ reimbursed: e.target.checked })} /> 已报销
            </label>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary">保存</button>
        </div>
      </form>
    </div>
  );
}
