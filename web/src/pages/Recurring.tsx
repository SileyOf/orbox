import { Cake, CreditCard, ExternalLink, Plus, Repeat } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api } from '../api';
import type { RepeatRule, Task, TaskInput, TaskMeta } from '../api';
import { LUNAR_DAY_NAMES, LUNAR_MONTH_NAMES, daysUntil, dueLabel, lunarLabel, money, toLocalInput, toLunar, toastError } from '../lib';

// 周期计划：账单 / 续费（每期提醒，标记"已付"后自动记一笔到简单记）、生日 / 纪念日（每年，支持农历）、其他重复计划。

const CYCLES: { label: string; rule: RepeatRule; months: number }[] = [
  { label: '每月', rule: { freq: 'monthly', interval: 1 }, months: 1 },
  { label: '每季度', rule: { freq: 'monthly', interval: 3 }, months: 3 },
  { label: '每半年', rule: { freq: 'monthly', interval: 6 }, months: 6 },
  { label: '每年', rule: { freq: 'yearly', interval: 1 }, months: 12 },
  { label: '每周', rule: { freq: 'weekly', interval: 1 }, months: 12 / 52 },
];
const cycleOf = (r: RepeatRule | null) =>
  CYCLES.find((c) => r && c.rule.freq === r.freq && c.rule.interval === r.interval && !r.weekdays?.length) ?? CYCLES[0];

const ADVANCE = [
  [0, '当天'],
  [1440, '提前 1 天'],
  [2 * 1440, '提前 2 天'],
  [3 * 1440, '提前 3 天'],
  [7 * 1440, '提前 1 周'],
] as const;

const countdown = (iso: string) => {
  const n = daysUntil(iso);
  return n < 0 ? `已过 ${-n} 天` : n === 0 ? '就是今天' : n === 1 ? '明天' : `还有 ${n} 天`;
};

export function RecurringView({ tasks, onEdit, row }: { tasks: Task[]; onEdit: (t: Task | { kind: 'bill' | 'birthday' }) => void; row: (t: Task) => ReactNode }) {
  const bills = tasks.filter((t) => t.kind === 'bill');
  const birthdays = tasks.filter((t) => t.kind === 'birthday');
  const others = tasks.filter((t) => t.kind === 'task' && t.repeat_rule);

  // 每月固定支出：按币种把各周期折算成每月
  const monthly = useMemo(() => {
    const sum: Record<string, number> = {};
    for (const b of bills) {
      if (!b.meta?.amount) continue;
      const cur = b.meta.currency || 'CNY';
      sum[cur] = (sum[cur] || 0) + b.meta.amount / cycleOf(b.repeat_rule).months;
    }
    return Object.entries(sum);
  }, [bills]);
  const in30 = bills.filter((b) => b.due_at && daysUntil(b.due_at) <= 30);

  return (
    <>
      <div className="task-group">
        <h3 className="row">
          <CreditCard size={14} /> 账单与续费 <span>{bills.length}</span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => onEdit({ kind: 'bill' })}>
            <Plus size={14} /> 添加账单
          </button>
        </h3>
        {bills.length > 0 && (
          <div className="muted small" style={{ margin: '0 4px 8px' }}>
            {monthly.length ? `每月固定支出约 ${monthly.map(([c, v]) => money(Math.round(v * 100) / 100, c)).join(' + ')}` : ''}
            {in30.length ? ` · 30 天内要付 ${in30.length} 笔` : ''}
          </div>
        )}
        {bills.length ? (
          <div className="card task-list">{bills.map(row)}</div>
        ) : (
          <div className="card empty-hint" onClick={() => onEdit({ kind: 'bill' })}>
            会员续费、房租、信用卡、话费……每期到点提醒，点"已付"自动记账并滚动到下一期
          </div>
        )}
      </div>

      <div className="task-group">
        <h3 className="row">
          <Cake size={14} /> 生日与纪念日 <span>{birthdays.length}</span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => onEdit({ kind: 'birthday' })}>
            <Plus size={14} /> 添加生日
          </button>
        </h3>
        {birthdays.length ? (
          <div className="card task-list">{birthdays.map(row)}</div>
        ) : (
          <div className="card empty-hint" onClick={() => onEdit({ kind: 'birthday' })}>
            亲朋好友的生日、结婚纪念日，支持农历，每年提前提醒
          </div>
        )}
      </div>

      {others.length > 0 && (
        <div className="task-group">
          <h3 className="row">
            <Repeat size={14} /> 其他重复计划 <span>{others.length}</span>
          </h3>
          <div className="card task-list">{others.map(row)}</div>
        </div>
      )}
    </>
  );
}

/** 任务行里账单 / 生日的补充标签 */
export function KindChips({ task }: { task: Task }) {
  const m = task.meta || {};
  if (task.kind === 'bill')
    return (
      <>
        {m.amount ? (
          <span className="chip accent">
            <CreditCard size={12} /> {money(m.amount, m.currency)} / {cycleOf(task.repeat_rule).label.replace('每', '')}
          </span>
        ) : null}
        {m.payMethod && <span className="chip">{m.payMethod}</span>}
        {task.due_at && <span className="chip">{countdown(task.due_at)}</span>}
        {m.payUrl && (
          <a className="chip" href={m.payUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            <ExternalLink size={11} /> 去付款
          </a>
        )}
      </>
    );
  if (task.kind === 'birthday' && task.due_at) {
    const age = m.birthYear ? new Date(task.due_at).getFullYear() - m.birthYear : null;
    return (
      <>
        <span className="chip accent">
          <Cake size={12} /> {countdown(task.due_at)}
          {age ? ` · ${age} 岁` : ''}
        </span>
        {m.lunar && <span className="chip">农历{lunarLabel(m.lunar)}</span>}
        {m.relation && <span className="chip">{m.relation}</span>}
      </>
    );
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 账单 / 生日的编辑窗口 */
export function KindDialog({ task, kind, onClose }: { task: Task | null; kind: 'bill' | 'birthday'; onClose: () => void }) {
  const m: TaskMeta = task?.meta || {};
  const due = task?.due_at ? new Date(task.due_at) : null;
  const tomorrow = new Date(Date.now() + 86400_000);
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [remindBefore, setRemindBefore] = useState(task?.remind_before ?? (kind === 'bill' ? 1440 : 1440));
  // 账单
  const [amount, setAmount] = useState(m.amount ? String(m.amount) : '');
  const [currency, setCurrency] = useState(m.currency || 'CNY');
  const [cycle, setCycle] = useState(cycleOf(task?.repeat_rule ?? null).label);
  const [dueAt, setDueAt] = useState(toLocalInput(task?.due_at ?? new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 10).toISOString()));
  const [payUrl, setPayUrl] = useState(m.payUrl || '');
  const [payMethod, setPayMethod] = useState(m.payMethod || '');
  const [autoNote, setAutoNote] = useState(m.autoNote !== false);
  // 生日
  const [person, setPerson] = useState(m.person || '');
  const [relation, setRelation] = useState(m.relation || '');
  const [lunarMode, setLunarMode] = useState(!!m.lunar);
  const [date, setDate] = useState(due ? `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}` : '');
  const [lunar, setLunar] = useState(m.lunar || { month: 1, day: 1 });
  const [time, setTime] = useState(due ? `${pad(due.getHours())}:${pad(due.getMinutes())}` : '09:00');
  const [birthYear, setBirthYear] = useState(m.birthYear ? String(m.birthYear) : '');
  const [busy, setBusy] = useState(false);

  /** 公历生日：选的日期如果今年已过，提醒放到明年 */
  function nextSolar(): Date | null {
    if (!date) return null;
    const [, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    const now = new Date();
    let at = new Date(now.getFullYear(), mo - 1, d, h, mi);
    if (new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1) <= now) at = new Date(now.getFullYear() + 1, mo - 1, d, h, mi);
    return at;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    let body: TaskInput;
    if (kind === 'bill') {
      body = {
        kind,
        title,
        notes: notes || null,
        dueAt: new Date(dueAt).toISOString(),
        remindBefore,
        repeat: CYCLES.find((c) => c.label === cycle)!.rule,
        nagInterval: 0,
        meta: { amount: amount ? Number(amount) : undefined, currency, payUrl, payMethod, autoNote },
      };
    } else {
      const [h, mi] = time.split(':').map(Number);
      const at = lunarMode ? new Date(new Date().getFullYear(), 0, 1, h, mi) : nextSolar();
      if (!at) return toastError(new Error('请选择生日日期'));
      body = {
        kind,
        title: title || `${person}的生日`,
        notes: notes || null,
        // 农历生日由服务器推算具体日期，这里只带上提醒的钟点
        dueAt: at.toISOString(),
        remindBefore,
        nagInterval: 0,
        meta: { person, relation, birthYear: birthYear ? Number(birthYear) : null, lunar: lunarMode ? lunar : null },
      };
    }
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

  const solarLunar = !lunarMode && date ? toLunar(new Date(`${date}T12:00:00`)) : null;

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={save}>
        <h2>{task ? '编辑' : '添加'}{kind === 'bill' ? '账单 / 续费' : '生日 / 纪念日'}</h2>
        {kind === 'bill' ? (
          <>
            <label className="field">
              <span>名称</span>
              <input className="input" required autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Netflix 会员 / 房租 / 信用卡还款" />
            </label>
            <div className="grid2">
              <label className="field">
                <span>每期金额</span>
                <div className="row" style={{ gap: 6 }}>
                  <input className="input grow" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="可不填" />
                  <select className="select" style={{ width: 82 }} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    {['CNY', 'USD', 'JPY', 'EUR', 'HKD', 'GBP'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </label>
              <label className="field">
                <span>周期</span>
                <select className="select" value={cycle} onChange={(e) => setCycle(e.target.value)}>
                  {CYCLES.map((c) => (
                    <option key={c.label}>{c.label}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>下次付款</span>
                <input className="input" type="datetime-local" required value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
              </label>
              <label className="field">
                <span>提醒</span>
                <select className="select" value={remindBefore} onChange={(e) => setRemindBefore(Number(e.target.value))}>
                  {ADVANCE.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>付款方式（可选）</span>
                <input className="input" maxLength={40} value={payMethod} onChange={(e) => setPayMethod(e.target.value)} placeholder="招行信用卡 / 支付宝" />
              </label>
              <label className="field">
                <span>付款 / 续费链接（可选）</span>
                <input className="input" type="url" maxLength={500} value={payUrl} onChange={(e) => setPayUrl(e.target.value)} placeholder="https://" />
              </label>
            </div>
            <label className="row small">
              <input type="checkbox" checked={autoNote} onChange={(e) => setAutoNote(e.target.checked)} /> 标记"已付"时自动记一笔到简单记
            </label>
          </>
        ) : (
          <>
            <div className="grid2">
              <label className="field">
                <span>是谁</span>
                <input className="input" required autoFocus maxLength={60} value={person} onChange={(e) => setPerson(e.target.value)} placeholder="妈妈 / 小王" />
              </label>
              <label className="field">
                <span>关系 / 说明（可选）</span>
                <input className="input" maxLength={30} value={relation} onChange={(e) => setRelation(e.target.value)} placeholder="家人 / 同事 / 结婚纪念日" />
              </label>
            </div>
            <label className="field">
              <span>标题（可选）</span>
              <input className="input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${person || '某人'}的生日`} />
            </label>
            <div className="field">
              <span>日期</span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <div className="tabs">
                  <button type="button" className={!lunarMode ? 'active' : ''} onClick={() => setLunarMode(false)}>
                    公历
                  </button>
                  <button type="button" className={lunarMode ? 'active' : ''} onClick={() => setLunarMode(true)}>
                    农历
                  </button>
                </div>
                {lunarMode ? (
                  <>
                    <select className="select" style={{ width: 90 }} value={lunar.month} onChange={(e) => setLunar({ ...lunar, month: Number(e.target.value) })}>
                      {LUNAR_MONTH_NAMES.map((n, i) => (
                        <option key={n} value={i + 1}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <select className="select" style={{ width: 90 }} value={lunar.day} onChange={(e) => setLunar({ ...lunar, day: Number(e.target.value) })}>
                      {LUNAR_DAY_NAMES.map((n, i) => (
                        <option key={n} value={i + 1}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <input className="input" type="date" required style={{ width: 170 }} value={date} onChange={(e) => setDate(e.target.value)} />
                )}
              </div>
              {solarLunar && <span className="muted small">这天是农历{lunarLabel(solarLunar)}，如果按农历过生日请切换到"农历"</span>}
              {lunarMode && <span className="muted small">每年按农历推算日期；小月没有三十时在廿九提醒</span>}
            </div>
            <div className="grid2">
              <label className="field">
                <span>出生年份（可选，用来显示年龄）</span>
                <input className="input" inputMode="numeric" maxLength={4} value={birthYear} onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, ''))} placeholder="1990" />
              </label>
              <label className="field">
                <span>提醒</span>
                <div className="row" style={{ gap: 6 }}>
                  <select className="select grow" value={remindBefore} onChange={(e) => setRemindBefore(Number(e.target.value))}>
                    {ADVANCE.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <input className="input" type="time" style={{ width: 110 }} value={time} onChange={(e) => setTime(e.target.value)} />
                </div>
              </label>
            </div>
          </>
        )}
        <label className="field">
          <span>备注</span>
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} placeholder={kind === 'birthday' ? '喜欢什么、去年送了什么' : ''} />
        </label>
        {task?.due_at && <div className="muted small">当前这一次：{dueLabel(task.due_at)}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy}>
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
