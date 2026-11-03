import {
  AlarmClock, BellRing, CalendarDays, Check, ChevronLeft, ChevronRight, Copy, Hash, Mail, Pencil, Plus, Repeat, RotateCcw, SkipForward, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu } from '../components/ContextMenu';
import type { MenuItem } from '../components/ContextMenu';
import { useSelection } from '../hooks/useSelection';
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasks, useUser } from '../App';
import { api } from '../api';
import type { RepeatRule, Task, TaskInput } from '../api';
import { copyText, dueLabel, toLocalInput, toast, toastError } from '../lib';

const DAY = 86400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function repeatLabel(r: RepeatRule): string {
  const every = r.interval > 1 ? `每 ${r.interval} ` : '每';
  if (r.freq === 'daily') return `${every}天`;
  if (r.freq === 'monthly') return `${every}${r.interval > 1 ? '个' : ''}月`;
  if (r.freq === 'yearly') return `${every}年`;
  if (!r.weekdays?.length) return `${every}周`;
  if (r.weekdays.join() === '1,2,3,4,5') return '工作日';
  return `${every}周${r.weekdays.map((d) => WEEKDAYS[d - 1]).join('、')}`;
}

/** 把未完成任务按时间远近分组 */
function group(tasks: Task[]) {
  const today = startOfDay(new Date()).getTime();
  const buckets: { key: string; label: string; overdue?: boolean; tasks: Task[] }[] = [
    { key: 'overdue', label: '已逾期', overdue: true, tasks: [] },
    { key: 'today', label: '今天', tasks: [] },
    { key: 'tomorrow', label: '明天', tasks: [] },
    { key: 'week', label: '未来 7 天', tasks: [] },
    { key: 'later', label: '以后', tasks: [] },
    { key: 'none', label: '未安排时间', tasks: [] },
  ];
  for (const t of tasks) {
    if (!t.due_at) buckets[5].tasks.push(t);
    else {
      // 今天已过点的任务也归入"已逾期"，更醒目
      const due = new Date(t.due_at).getTime();
      const i = due < Date.now() ? 0 : due < today + DAY ? 1 : due < today + 2 * DAY ? 2 : due < today + 8 * DAY ? 3 : 4;
      buckets[i].tasks.push(t);
    }
  }
  return buckets.filter((b) => b.tasks.length);
}

export function Planner() {
  const user = useUser();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const { data: open = [] } = useTasks('open');
  const { data: done = [] } = useTasks('done');
  const [quick, setQuick] = useState('');
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [day, setDay] = useState<Date | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));

  const act = (path: string, body: unknown = {}) => api(path, { method: 'POST', body }).catch(toastError);

  async function quickAdd(e: FormEvent) {
    e.preventDefault();
    if (!quick.trim()) return;
    try {
      const task = await api<Task>('/tasks/quick', { body: { text: quick } });
      setQuick('');
      toast(task.due_at ? `已添加，${dueLabel(task.due_at)}提醒` : '已添加（未识别到时间）', {
        action: { label: '编辑', run: () => setEditing(task) },
      });
    } catch (err) {
      toastError(err);
    }
  }

  const allTags = useMemo(() => [...new Set(open.flatMap((t) => t.tags || []))].sort(), [open]);
  const visible = open
    .filter((t) => !day || (t.due_at && dayKey(new Date(t.due_at)) === dayKey(day)))
    .filter((t) => !tag || t.tags?.includes(tag));
  const groups = useMemo(() => group(visible), [visible]);
  const busyDays = useMemo(() => new Set(open.filter((t) => t.due_at).map((t) => dayKey(new Date(t.due_at!)))), [open]);
  const todayStart = startOfDay(new Date()).getTime();
  const dueToday = open.filter((t) => t.due_at && new Date(t.due_at).getTime() < todayStart + DAY).length;
  const doneToday = done.filter((t) => t.completed_at && new Date(t.completed_at).getTime() >= todayStart).length;

  // 当前列表里任务的显示顺序，拖选和 Shift 连选按这个顺序计算
  const ordered = useMemo(() => (tab === 'open' ? groups.flatMap((g) => g.tasks) : done), [tab, groups, done]);
  const listRef = useRef<HTMLDivElement>(null);
  const sel = useSelection(useMemo(() => ordered.map((t) => t.id), [ordered]), listRef);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => sel.clear(), [tab]);

  async function bulk(ids: number[], action: 'complete' | 'reopen' | 'delete' | number) {
    try {
      for (const id of ids) {
        if (action === 'delete') await api(`/tasks/${id}`, { method: 'DELETE' });
        else if (typeof action === 'number') await api(`/tasks/${id}/snooze`, { method: 'POST', body: { minutes: action } });
        else await api(`/tasks/${id}/${action}`, { method: 'POST', body: {} });
      }
      sel.clear();
      if (ids.length > 1) toast(`已处理 ${ids.length} 项`);
    } catch (e) {
      toastError(e);
    }
  }

  const SNOOZE: [string, number][] = [['10 分钟后', 10], ['1 小时后', 60], ['3 小时后', 180], ['明天此时', 1440]];

  function taskMenu(t: Task): MenuItem[] {
    const ids = sel.selected.has(t.id) && sel.selected.size > 1 ? [...sel.selected] : [t.id];
    const single = ids.length === 1;
    const isDone = t.status === 'done';
    const items: MenuItem[] = [];
    if (!single) items.push({ heading: true, label: `已选 ${ids.length} 项` });
    items.push(isDone ? { label: '恢复为未完成', icon: RotateCcw, onClick: () => bulk(ids, 'reopen') } : { label: single ? '完成' : '全部完成', icon: Check, onClick: () => bulk(ids, 'complete') });
    if (single) items.push({ label: '编辑', icon: Pencil, onClick: () => setEditing(t) });
    if (!isDone) items.push({ label: '稍后提醒', icon: BellRing, children: SNOOZE.map(([label, m]) => ({ label, onClick: () => bulk(ids, m) })) });
    if (single && t.repeat_rule && !isDone) items.push({ label: '跳过这一次', icon: SkipForward, onClick: () => act(`/tasks/${t.id}/skip`) });
    if (single && t.mail_id) items.push({ label: '打开关联邮件', icon: Mail, onClick: () => navigate(`/mail?open=${t.mail_id}`) });
    if (single) items.push({ label: '复制标题', icon: Copy, onClick: () => copyText(t.title) });
    items.push({ separator: true }, { label: single ? '删除' : `删除 ${ids.length} 项`, icon: Trash2, danger: true, onClick: () => (single || confirm(`删除选中的 ${ids.length} 项？`)) && bulk(ids, 'delete') });
    return items;
  }

  const row = (t: Task) => (
    <TaskRow
      key={t.id}
      task={t}
      index={ordered.indexOf(t)}
      selected={sel.selected.has(t.id)}
      onRowMouseDown={(e) => sel.onRowMouseDown(e, ordered.indexOf(t))}
      onRowClick={(e) => sel.onRowClick(e, ordered.indexOf(t)) && setEditing(t)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items: taskMenu(t) });
      }}
      onToggle={() => act(`/tasks/${t.id}/${t.status === 'open' ? 'complete' : 'reopen'}`)}
      onEdit={() => setEditing(t)}
      onSnooze={(minutes) => act(`/tasks/${t.id}/snooze`, { minutes }).then(() => toast('好的，稍后再提醒'))}
      onSkip={() => act(`/tasks/${t.id}/skip`)}
      onDelete={() => api(`/tasks/${t.id}`, { method: 'DELETE' }).catch(toastError)}
      onTag={(name) => setTag(tag === name ? null : name)}
      onOpenMail={t.mail_id ? () => navigate(`/mail?open=${t.mail_id}`) : undefined}
    />
  );

  return (
    <div className="planner">
      <div className="planner-main">
        <div className="planner-inner">
          <div className="planner-head">
            <h1 className="grow">计划</h1>
            <div className="tabs">
              <button className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>待办 {open.length || ''}</button>
              <button className={tab === 'done' ? 'active' : ''} onClick={() => setTab('done')}>已完成</button>
            </div>
          </div>

          <form className="card quick-add" onSubmit={quickAdd}>
            <Plus size={18} className="muted" />
            <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="明天9点 交报告 —— 直接写时间和事项，回车添加" />
            <button type="button" className="btn ghost sm" onClick={() => setEditing('new')}>详细设置</button>
          </form>

          {tab === 'open' && allTags.length > 0 && (
            <div className="task-meta" style={{ margin: '-8px 0 6px' }}>
              {allTags.map((name) => (
                <button key={name} className={`chip tag${tag === name ? ' on' : ''}`} style={{ border: 0 }} onClick={() => setTag(tag === name ? null : name)}>
                  <Hash size={11} />{name}
                </button>
              ))}
            </div>
          )}
          {sel.selected.size > 0 ? (
            <div className="bulk card" style={{ marginBottom: 12 }}>
              <label className="select-all" title={sel.allSelected ? '取消全选' : '全选'}><input type="checkbox" checked={sel.allSelected} onChange={sel.toggleAll} /></label>
              <span className="small grow" style={{ paddingLeft: 6 }}>已选 {sel.selected.size} 项</span>
              {tab === 'open' ? (
                <button className="btn sm ghost" onClick={() => bulk([...sel.selected], 'complete')}><Check size={14} /> 完成</button>
              ) : (
                <button className="btn sm ghost" onClick={() => bulk([...sel.selected], 'reopen')}><RotateCcw size={14} /> 恢复</button>
              )}
              {tab === 'open' && <button className="btn sm ghost" onClick={() => bulk([...sel.selected], 60)}><BellRing size={14} /> 1 小时后提醒</button>}
              <button className="btn sm ghost danger" onClick={() => confirm(`删除选中的 ${sel.selected.size} 项？`) && bulk([...sel.selected], 'delete')}><Trash2 size={14} /> 删除</button>
              <button className="btn ghost sm" onClick={sel.clear}>取消</button>
            </div>
          ) : ordered.length > 0 ? (
            <div className="row small muted" style={{ margin: '-6px 4px 6px' }}>
              <label className="select-all" title="全选"><input type="checkbox" checked={false} onChange={sel.toggleAll} /></label>
              按住拖动或 Shift / Ctrl 点击可多选，右键查看更多操作
            </div>
          ) : null}
          <div ref={listRef} className={sel.dragging ? 'selecting-drag' : ''}>
          {tab === 'open' ? (
            <>
              {day && (
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="chip accent"><CalendarDays size={13} /> {day.getMonth() + 1}月{day.getDate()}日</span>
                  <button className="btn ghost sm" onClick={() => setDay(null)}>显示全部</button>
                </div>
              )}
              {groups.map((g) => (
                <div className="task-group" key={g.key}>
                  <h3 className={g.overdue ? 'overdue' : ''}>{g.label} <span>{g.tasks.length}</span></h3>
                  <div className="card task-list">{g.tasks.map(row)}</div>
                </div>
              ))}
              {!groups.length && (
                <div className="empty" style={{ height: 280 }}>
                  <Check size={40} />
                  {day ? '这一天没有安排' : '没有待办，享受这份清净'}
                </div>
              )}
            </>
          ) : done.length ? (
            <div className="card task-list">{done.map(row)}</div>
          ) : (
            <div className="empty" style={{ height: 280 }}>还没有完成的任务</div>
          )}
          </div>
        </div>
      </div>

      <aside className="planner-aside">
        <div className="stat">
          <div className="card"><b>{dueToday}</b><span className="muted small">今天待办</span></div>
          <div className="card"><b>{doneToday}</b><span className="muted small">今天完成</span></div>
        </div>
        <Calendar month={month} setMonth={setMonth} selected={day} onSelect={(d) => setDay(day && dayKey(day) === dayKey(d) ? null : d)} busy={busyDays} />
        <div className="muted small">
          到点会推送到你在 设置 → 通知渠道 里开启的渠道，聊天机器人里可直接点按钮完成或稍后再提醒；没处理的任务默认每 {user.settings.nagInterval || '—'} 分钟再提醒一次。
        </div>
      </aside>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {editing && <TaskDialog task={editing === 'new' ? null : editing} defaultDay={day} defaultNag={user.settings.nagInterval} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TaskRow(props: {
  task: Task;
  index: number;
  selected: boolean;
  onRowMouseDown: (e: ReactMouseEvent) => void;
  onRowClick: (e: ReactMouseEvent) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onToggle: () => void;
  onEdit: () => void;
  onSnooze: (minutes: number) => void;
  onSkip: () => void;
  onDelete: () => void;
  onTag: (name: string) => void;
  onOpenMail?: () => void;
}) {
  const t = props.task;
  const [menu, setMenu] = useState(false);
  const isDone = t.status === 'done';
  const overdue = !isDone && !!t.due_at && new Date(t.due_at).getTime() < Date.now();
  const snoozed = !isDone && t.next_remind_at && t.due_at && new Date(t.next_remind_at) > new Date(t.due_at) && new Date(t.next_remind_at).getTime() > Date.now();

  return (
    <div
      className={`task${isDone ? ' done' : ''}${props.selected ? ' selected' : ''}`}
      data-index={props.index}
      onMouseDown={props.onRowMouseDown}
      onClick={props.onRowClick}
      onContextMenu={props.onContextMenu}
    >
      <button className={`check${isDone ? ' on' : ''}${!isDone && t.priority ? ` p${t.priority}` : ''}`} onClick={props.onToggle} title={isDone ? '恢复为未完成' : '完成'}>
        {isDone ? <Check size={14} strokeWidth={3} /> : <Check size={13} strokeWidth={3} />}
      </button>
      <div className="task-body">
        <div className="task-title">{t.title}</div>
        {t.notes && <div className="muted small" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{t.notes}</div>}
        <div className="task-meta">
          {t.due_at && <span className={`chip${overdue ? ' danger' : ''}`}><AlarmClock size={12} /> {dueLabel(t.due_at)}</span>}
          {t.repeat_rule && <span className="chip"><Repeat size={12} /> {repeatLabel(t.repeat_rule)}</span>}
          {(t.tags || []).map((name) => (
            <span key={name} className="chip tag" onClick={(e) => (e.stopPropagation(), props.onTag(name))}><Hash size={11} />{name}</span>
          ))}
          {snoozed && <span className="chip accent"><BellRing size={12} /> {dueLabel(t.next_remind_at!)} 再提醒</span>}
          {t.mail_subject != null && (
            <span
              className="chip"
              style={props.onOpenMail ? { cursor: 'pointer' } : undefined}
              onClick={(e) => (e.stopPropagation(), props.onOpenMail?.())}
              title={props.onOpenMail ? '打开关联邮件' : '关联邮件已不在本地'}
            >
              <Mail size={12} /> <span className="truncate" style={{ maxWidth: 180 }}>{t.mail_subject || '(无主题)'}</span>
            </span>
          )}
          {isDone && t.completed_at && <span className="chip">完成于 {dueLabel(t.completed_at)}</span>}
        </div>
      </div>
      <div className="task-actions">
        {!isDone && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <button className="icon-btn" title="稍后提醒" onClick={() => setMenu(!menu)}><BellRing size={16} /></button>
            {menu && (
              <div className="card menu-pop" onClick={() => setMenu(false)}>
                <button onClick={() => props.onSnooze(10)}>10 分钟后</button>
                <button onClick={() => props.onSnooze(60)}>1 小时后</button>
                <button onClick={() => props.onSnooze(180)}>3 小时后</button>
                <button onClick={() => props.onSnooze(1440)}>明天此时</button>
                {t.repeat_rule && <button onClick={props.onSkip}>跳过这一次</button>}
              </div>
            )}
          </div>
        )}
        {isDone ? (
          <button className="icon-btn" title="恢复" onClick={props.onToggle}><RotateCcw size={16} /></button>
        ) : (
          <button className="icon-btn" title="编辑" onClick={props.onEdit}><Pencil size={16} /></button>
        )}
        <button className="icon-btn" title="删除" onClick={props.onDelete}><Trash2 size={16} /></button>
      </div>
    </div>
  );
}

function Calendar(props: { month: Date; setMonth: (d: Date) => void; selected: Date | null; onSelect: (d: Date) => void; busy: Set<string> }) {
  const { month } = props;
  // 周一为一周起点，固定画 6 行
  const offset = (month.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i - offset + 1));
  const shift = (n: number) => props.setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const today = dayKey(new Date());
  return (
    <div>
      <div className="cal-head">
        <span className="grow">{month.getFullYear()}年{month.getMonth() + 1}月</span>
        <button className="icon-btn" onClick={() => shift(-1)} title="上个月"><ChevronLeft size={17} /></button>
        <button className="icon-btn" onClick={() => shift(1)} title="下个月"><ChevronRight size={17} /></button>
      </div>
      <div className="cal-grid">
        {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
        {days.map((d) => {
          const k = dayKey(d);
          const cls = ['cal-day', d.getMonth() !== month.getMonth() && 'other', k === today && 'today', props.selected && dayKey(props.selected) === k && 'sel', props.busy.has(k) && 'has'];
          return (
            <button key={k} className={cls.filter(Boolean).join(' ')} onClick={() => props.onSelect(d)}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type RepeatKind = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

function TaskDialog({ task, defaultDay, defaultNag, onClose }: { task: Task | null; defaultDay: Date | null; defaultNag: number; onClose: () => void }) {
  const initialDue = task?.due_at ?? (defaultDay ? new Date(defaultDay.getFullYear(), defaultDay.getMonth(), defaultDay.getDate(), 9).toISOString() : null);
  const rule = task?.repeat_rule;
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [due, setDue] = useState(toLocalInput(initialDue));
  const [remindBefore, setRemindBefore] = useState(task?.remind_before ?? 0);
  const [nag, setNag] = useState(task?.nag_interval ?? defaultNag);
  const [priority, setPriority] = useState(task?.priority ?? 0);
  const [tags, setTags] = useState((task?.tags || []).join(' '));
  const [repeat, setRepeat] = useState<RepeatKind>(
    !rule ? 'none' : rule.freq === 'weekly' && rule.weekdays?.join() === '1,2,3,4,5' ? 'weekdays' : rule.freq,
  );
  const [weekdays, setWeekdays] = useState<number[]>(rule?.weekdays ?? []);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const repeatRule: RepeatRule | null =
      repeat === 'none' || !due
        ? null
        : repeat === 'weekdays'
          ? { freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] }
          : { freq: repeat, interval: 1, ...(repeat === 'weekly' && weekdays.length ? { weekdays: [...weekdays].sort() } : {}) };
    const body: TaskInput = {
      title,
      notes: notes || null,
      dueAt: due ? new Date(due).toISOString() : null,
      remindBefore,
      nagInterval: nag,
      priority,
      tags: [...new Set(tags.split(/[\s,，#]+/).filter(Boolean))].slice(0, 10),
      repeat: repeatRule,
    };
    setBusy(true);
    try {
      await api(task ? `/tasks/${task.id}` : '/tasks', { method: task ? 'PATCH' : 'POST', body });
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={save}>
        <h2>{task ? '编辑计划' : '新建计划'}</h2>
        <label className="field">
          <span>事项</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus maxLength={500} />
        </label>
        <div className="grid2">
          <label className="field">
            <span>时间</span>
            <input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label className="field">
            <span>提前提醒</span>
            <select className="select" value={remindBefore} onChange={(e) => setRemindBefore(Number(e.target.value))} disabled={!due}>
              <option value={0}>准时</option>
              <option value={5}>提前 5 分钟</option>
              <option value={15}>提前 15 分钟</option>
              <option value={30}>提前 30 分钟</option>
              <option value={60}>提前 1 小时</option>
              <option value={1440}>提前 1 天</option>
            </select>
          </label>
          <label className="field">
            <span>重复</span>
            <select className="select" value={repeat} onChange={(e) => setRepeat(e.target.value as RepeatKind)} disabled={!due}>
              <option value="none">不重复</option>
              <option value="daily">每天</option>
              <option value="weekdays">工作日（周一至周五）</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="yearly">每年</option>
            </select>
          </label>
          <label className="field">
            <span>没处理时再次提醒</span>
            <select className="select" value={nag} onChange={(e) => setNag(Number(e.target.value))} disabled={!due}>
              <option value={0}>只提醒一次</option>
              <option value={5}>每 5 分钟</option>
              <option value={15}>每 15 分钟</option>
              <option value={30}>每 30 分钟</option>
              <option value={60}>每小时</option>
            </select>
          </label>
        </div>
        {repeat === 'weekly' && due && (
          <div className="field">
            <span>每周的哪几天（不选则沿用上面日期的星期）</span>
            <div className="weekdays">
              {WEEKDAYS.map((w, i) => (
                <button
                  type="button"
                  key={w}
                  className={weekdays.includes(i + 1) ? 'on' : ''}
                  onClick={() => setWeekdays(weekdays.includes(i + 1) ? weekdays.filter((d) => d !== i + 1) : [...weekdays, i + 1])}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="field">
          <span>优先级</span>
          <div className="tabs" style={{ justifySelf: 'start' }}>
            {['普通', '重要', '紧急'].map((label, i) => (
              <button type="button" key={label} className={priority === i ? 'active' : ''} onClick={() => setPriority(i)}>{label}</button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>标签（空格分隔）</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="工作 家庭" />
        </label>
        <label className="field">
          <span>备注</span>
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
        </label>
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy}>保存</button>
        </div>
      </form>
    </div>
  );
}
