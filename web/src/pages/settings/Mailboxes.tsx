import { useQuery } from '@tanstack/react-query';
import { Filter, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAccounts, useUser } from '../../App';
import { api, folderLabel } from '../../api';
import type { Account } from '../../api';
import { ACCENTS, toast, toastError } from '../../lib';
import { Section, Switch } from './ui';

export function MailboxesPage() {
  const { data: accounts = [] } = useAccounts();
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [sieve, setSieve] = useState<Account | null>(null);
  const [params, setParams] = useSearchParams();

  // Microsoft 授权完成后会带着结果跳回这里
  useEffect(() => {
    if (params.get('oauth') === 'ok') toast('Outlook 邮箱已连接，正在同步');
    else if (params.get('oauth_error')) toast(`授权失败：${params.get('oauth_error')}`, { kind: 'error', ms: 10_000 });
    else return;
    setParams({}, { replace: true });
  }, [params]);

  return (
    <>
      <Section title="邮箱账号" action={<button className="btn sm" onClick={() => setEditing('new')}><Plus size={15} /> 添加邮箱</button>}>
        <div className="card">
          {accounts.map((a) => (
            <div className="setting" key={a.id}>
              <div className="row">
                <span className="dot" style={{ background: a.color, width: 10, height: 10 }} />
                <div style={{ minWidth: 0 }}>
                  <div className="truncate">{a.name} <span className="muted small">{a.email}</span></div>
                  <div className="small" style={{ color: a.sync_state === 'error' ? 'var(--danger)' : 'var(--muted)' }}>
                    {a.sync_state === 'error' ? `连接失败：${a.last_error}` : a.sync_state === 'syncing' ? '同步中…' : `${a.auth_type === 'oauth' ? 'Microsoft 登录' : a.imap_host} · 已连接`}
                    {a.ai_enabled ? ' · 允许 AI' : ''}
                  </div>
                </div>
              </div>
              <button className="icon-btn" title="服务器端过滤规则" onClick={() => setSieve(a)}><Filter size={16} /></button>
              <button className="icon-btn" title="编辑" onClick={() => setEditing(a)}><Pencil size={16} /></button>
              <button
                className="icon-btn"
                title="移除"
                onClick={() => confirm(`移除 ${a.email}？只会从这里移除，服务器上的邮件不受影响。`) && api(`/accounts/${a.id}`, { method: 'DELETE' }).catch(toastError)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {!accounts.length && <div className="setting muted">还没有邮箱，添加一个 mailcow 或任意 IMAP 邮箱开始使用。</div>}
        </div>
      </Section>
      {sieve && <SieveDialog account={sieve} onClose={() => setSieve(null)} />}
      {editing && <AccountDialog account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

const PRESETS: Record<string, { label: string; imap?: string; smtp?: string; hint: string }> = {
  mailcow: { label: 'mailcow / 自建', hint: 'IMAP 和 SMTP 一般都是你的邮件服务器主机名，例如 mail.example.com' },
  gmail: { label: 'Gmail', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', hint: '需要在 Google 账号里开启两步验证并生成"应用专用密码"' },
  qq: { label: 'QQ 邮箱', imap: 'imap.qq.com', smtp: 'smtp.qq.com', hint: '在 QQ 邮箱设置里开启 IMAP 服务并使用生成的授权码' },
  netease: { label: '163 邮箱', imap: 'imap.163.com', smtp: 'smtp.163.com', hint: '在邮箱设置里开启 IMAP 服务并使用授权码' },
  outlook: { label: 'Outlook', hint: 'Outlook / Hotmail / Microsoft 365 不支持密码登录，需要跳转到 Microsoft 授权' },
};

function AccountDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const user = useUser();
  const [preset, setPreset] = useState('mailcow');
  const [f, setF] = useState({
    name: account?.name ?? '',
    email: account?.email ?? '',
    from_name: account?.from_name ?? '',
    color: account?.color ?? ACCENTS[Math.floor(Math.random() * 6) + 1],
    imap_host: account?.imap_host ?? '',
    imap_port: account?.imap_port ?? 993,
    imap_secure: account ? !!account.imap_secure : true,
    smtp_host: account?.smtp_host ?? '',
    smtp_port: account?.smtp_port ?? 465,
    smtp_secure: account ? !!account.smtp_secure : true,
    username: account?.username ?? '',
    password: '',
    signature: account?.signature ?? '',
    notify: account ? !!account.notify : true,
    save_sent: account ? !!account.save_sent : true,
    ai_enabled: account ? !!account.ai_enabled : false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const providers = useQuery({ queryKey: ['oauth-providers'], queryFn: () => api<{ microsoft: boolean }>('/oauth/providers') });
  const oauth = account ? account.auth_type === 'oauth' : preset === 'outlook';
  const authorize = () => (location.href = `/api/oauth/microsoft/start${account ? `?hint=${encodeURIComponent(account.email)}` : ''}`);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((prev) => ({ ...prev, [k]: v }));

  function choosePreset(key: string) {
    setPreset(key);
    const p = PRESETS[key];
    // Gmail 会自动把发出的邮件存进"已发送"，再存一份会重复
    if (p.imap) setF((prev) => ({ ...prev, imap_host: p.imap!, smtp_host: p.smtp!, imap_port: 993, smtp_port: 465, imap_secure: true, smtp_secure: true, save_sent: key !== 'gmail' }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body: Record<string, unknown> = {
      ...f,
      name: f.name || f.email,
      username: f.username || f.email,
      smtp_host: f.smtp_host || f.imap_host,
    };
    if (account && !f.password) delete body.password;
    try {
      await api(account ? `/accounts/${account.id}` : '/accounts', { method: account ? 'PATCH' : 'POST', body });
      toast(account ? '已保存' : '邮箱已添加，正在同步');
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit}>
        <h2>{account ? '编辑邮箱' : '添加邮箱'}</h2>
        {!account && (
          <>
            <div className="tabs" style={{ justifySelf: 'start' }}>
              {Object.entries(PRESETS).map(([k, p]) => (
                <button type="button" key={k} className={preset === k ? 'active' : ''} onClick={() => choosePreset(k)}>{p.label}</button>
              ))}
            </div>
            <div className="muted small">{PRESETS[preset].hint}</div>
          </>
        )}
        {oauth && !account && (
          <>
            <button type="button" className="btn primary" disabled={!providers.data?.microsoft} onClick={authorize}>
              使用 Microsoft 账号登录
            </button>
            {providers.data && !providers.data.microsoft && (
              <div className="muted small">服务器还没有配置 MS_CLIENT_ID / MS_CLIENT_SECRET，配置方法见部署文档。</div>
            )}
            <div className="dialog-foot">
              <button type="button" className="btn ghost" onClick={onClose}>取消</button>
            </div>
          </>
        )}
        {oauth && account && (
          <>
            <div className="setting" style={{ padding: 0, border: 0 }}>
              <div>
                <div>{account.email}</div>
                <div className="muted small">通过 Microsoft 登录。连接失败或提示授权失效时重新授权即可</div>
              </div>
              <button type="button" className="btn sm" disabled={!providers.data?.microsoft} onClick={authorize}>重新授权</button>
            </div>
            <div className="grid2">
              <label className="field">
                <span>显示名称</span>
                <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
              </label>
              <label className="field">
                <span>发件人名称</span>
                <input className="input" value={f.from_name} onChange={(e) => set('from_name', e.target.value)} placeholder={user.name} />
              </label>
            </div>
          </>
        )}
        {!oauth && (
        <div className="grid2">
          <label className="field">
            <span>邮箱地址</span>
            <input className="input" type="email" required value={f.email} onChange={(e) => set('email', e.target.value)} autoFocus={!account} />
          </label>
          <label className="field">
            <span>密码 / 授权码</span>
            <input className="input" type="password" required={!account} value={f.password} onChange={(e) => set('password', e.target.value)} placeholder={account ? '留空则不修改' : ''} autoComplete="off" />
          </label>
          <label className="field">
            <span>显示名称</span>
            <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="如：工作、个人" />
          </label>
          <label className="field">
            <span>发件人名称</span>
            <input className="input" value={f.from_name} onChange={(e) => set('from_name', e.target.value)} placeholder={user.name} />
          </label>
          <label className="field">
            <span>IMAP 服务器</span>
            <input className="input" required value={f.imap_host} onChange={(e) => set('imap_host', e.target.value)} placeholder="mail.example.com" />
          </label>
          <div className="row" style={{ alignItems: 'end' }}>
            <label className="field grow">
              <span>端口</span>
              <input className="input" type="number" value={f.imap_port} onChange={(e) => set('imap_port', Number(e.target.value))} />
            </label>
            <label className="row small" style={{ height: 38 }}><input type="checkbox" checked={f.imap_secure} onChange={(e) => set('imap_secure', e.target.checked)} /> SSL/TLS</label>
          </div>
          <label className="field">
            <span>SMTP 服务器</span>
            <input className="input" value={f.smtp_host} onChange={(e) => set('smtp_host', e.target.value)} placeholder="留空则与 IMAP 相同" />
          </label>
          <div className="row" style={{ alignItems: 'end' }}>
            <label className="field grow">
              <span>端口</span>
              <input className="input" type="number" value={f.smtp_port} onChange={(e) => set('smtp_port', Number(e.target.value))} />
            </label>
            <label className="row small" style={{ height: 38 }} title="465 端口勾选；587 端口不勾选（自动使用 STARTTLS）">
              <input type="checkbox" checked={f.smtp_secure} onChange={(e) => set('smtp_secure', e.target.checked)} /> SSL/TLS
            </label>
          </div>
          <label className="field">
            <span>登录用户名</span>
            <input className="input" value={f.username} onChange={(e) => set('username', e.target.value)} placeholder="留空则使用邮箱地址" />
          </label>
          <div className="field">
            <span>标记颜色</span>
            <div className="swatches" style={{ height: 38 }}>
              {ACCENTS.slice(1, 7).map((c) => (
                <button type="button" key={c} className={`swatch${f.color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => set('color', c)} />
              ))}
              <input className="swatch-custom" type="color" value={f.color} onChange={(e) => set('color', e.target.value)} />
            </div>
          </div>
        </div>
        )}
        {!(oauth && !account) && (
        <>
        <label className="field">
          <span>签名</span>
          <textarea className="textarea" style={{ minHeight: 60 }} value={f.signature} onChange={(e) => set('signature', e.target.value)} />
        </label>
        <div className="row">
          <label className="row grow"><Switch checked={f.notify} onChange={(v) => set('notify', v)} /> 新邮件通知</label>
          <label className="row grow" title="mailcow 等自建邮箱需要开启；Gmail 会自动保存，应关闭"><Switch checked={f.save_sent} onChange={(v) => set('save_sent', v)} /> 发信后存入"已发送"</label>
        </div>
        <label className="row" title="开启后，这个邮箱的邮件内容会发给你在 设置 → AI 里配置的模型，也能被 MCP 连接的外部 AI 读取">
          <Switch checked={f.ai_enabled} onChange={(v) => set('ai_enabled', v)} /> 允许 AI 读取这个邮箱（摘要、翻译、助手、MCP）
        </label>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy}>{busy ? '正在验证连接…' : account ? '保存' : '验证并添加'}</button>
        </div>
        </>
        )}
      </form>
    </div>
  );
}

// ---------------- 服务器端过滤规则（Sieve） ----------------

type Field = 'from' | 'to' | 'cc' | 'subject' | 'list';
type Op = 'contains' | 'not_contains' | 'is' | 'domain';
type Action =
  | { type: 'fileinto'; folder: string }
  | { type: 'markread' }
  | { type: 'flag' }
  | { type: 'discard' }
  | { type: 'redirect'; address: string; keep: boolean }
  | { type: 'stop' };
interface Rule {
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: { field: Field; op: Op; value: string }[];
  actions: Action[];
}

const FIELDS: Record<Field, string> = { from: '发件人', to: '收件人', cc: '抄送', subject: '主题', list: '邮件列表' };
const OPS: Record<Op, string> = { contains: '包含', not_contains: '不包含', is: '等于', domain: '域名是' };
const ACTIONS: Record<Action['type'], string> = {
  fileinto: '移动到文件夹',
  markread: '标为已读',
  flag: '加星标',
  discard: '直接删除',
  redirect: '转发到',
  stop: '不再执行后面的规则',
};

const blankRule = (): Rule => ({ name: '', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'markread' }] });

function newAction(type: Action['type'], folder: string): Action {
  if (type === 'fileinto') return { type, folder };
  if (type === 'redirect') return { type, address: '', keep: true };
  return { type } as Action;
}

function SieveDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const data = useQuery({
    queryKey: ['sieve', account.id],
    queryFn: () => api<{ supported: boolean; error?: string; rules: Rule[]; base: string | null; script: string | null }>(`/accounts/${account.id}/sieve`),
    retry: false,
  });
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = rules ?? data.data?.rules ?? [];
  const folders = account.folders.filter((f) => f.role !== 'inbox');
  const update = (i: number, patch: Partial<Rule>) => setRules(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ script: string }>(`/accounts/${account.id}/sieve`, { method: 'PUT', body: { rules: list } });
      setScript(r.script);
      toast('规则已保存到邮件服务器，新邮件到达时立即生效');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 'min(760px, 100%)' }}>
        <div className="row">
          <h2 className="grow">过滤规则 · {account.name}</h2>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        {data.isLoading && <div className="muted">正在连接邮件服务器…</div>}
        {data.data && !data.data.supported && (
          <div className="banner warn">无法连接这个邮箱的 ManageSieve 服务（端口 {account.sieve_port ?? 4190}）：{data.data.error}</div>
        )}
        {data.data?.supported && (
          <>
            <div className="muted small">
              规则保存在邮件服务器上（Sieve），邮件到达时由服务器执行，不依赖 Orbox 在线。按从上到下的顺序执行。
              {data.data.base && ` 原有的规则脚本「${data.data.base}」会继续在这些规则之后生效。`}
            </div>
            {list.map((r, i) => (
              <div className="card rule" key={i}>
                <div className="row">
                  <input className="input grow" placeholder="规则名称" value={r.name} onChange={(e) => update(i, { name: e.target.value })} />
                  <label className="switch" title="启用">
                    <input type="checkbox" checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
                    <i />
                  </label>
                  <button className="icon-btn" title="删除规则" onClick={() => setRules(list.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
                </div>
                <div className="row small">
                  当
                  <select className="select" style={{ width: 'auto', height: 32 }} value={r.match} onChange={(e) => update(i, { match: e.target.value as Rule['match'] })}>
                    <option value="all">满足全部条件</option>
                    <option value="any">满足任一条件</option>
                  </select>
                  时
                </div>
                {r.conditions.map((c, k) => (
                  <div className="row" key={k}>
                    <select className="select" style={{ width: 110 }} value={c.field} onChange={(e) => update(i, { conditions: r.conditions.map((x, j) => (j === k ? { ...x, field: e.target.value as Field } : x)) })}>
                      {Object.entries(FIELDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <select className="select" style={{ width: 100 }} value={c.op} onChange={(e) => update(i, { conditions: r.conditions.map((x, j) => (j === k ? { ...x, op: e.target.value as Op } : x)) })}>
                      {Object.entries(OPS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <input className="input grow" value={c.value} placeholder={c.op === 'domain' ? 'example.com' : ''} onChange={(e) => update(i, { conditions: r.conditions.map((x, j) => (j === k ? { ...x, value: e.target.value } : x)) })} />
                    <button className="icon-btn" disabled={r.conditions.length === 1} onClick={() => update(i, { conditions: r.conditions.filter((_, j) => j !== k) })}><X size={15} /></button>
                  </div>
                ))}
                <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => update(i, { conditions: [...r.conditions, { field: 'subject', op: 'contains', value: '' }] })}><Plus size={14} /> 条件</button>
                <div className="small muted">就</div>
                {r.actions.map((a, k) => (
                  <div className="row" key={k}>
                    <select className="select" style={{ width: 170 }} value={a.type} onChange={(e) => update(i, { actions: r.actions.map((x, j) => (j === k ? newAction(e.target.value as Action['type'], folders[0]?.path || 'Archive') : x)) })}>
                      {Object.entries(ACTIONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    {a.type === 'fileinto' && (
                      <select className="select grow" value={a.folder} onChange={(e) => update(i, { actions: r.actions.map((x, j) => (j === k ? { ...a, folder: e.target.value } : x)) })}>
                        {folders.map((f) => <option key={f.id} value={f.path}>{folderLabel(f)}</option>)}
                      </select>
                    )}
                    {a.type === 'redirect' && (
                      <>
                        <input className="input grow" type="email" placeholder="转发到的邮箱" value={a.address} onChange={(e) => update(i, { actions: r.actions.map((x, j) => (j === k ? { ...a, address: e.target.value } : x)) })} />
                        <label className="row small"><input type="checkbox" checked={a.keep} onChange={(e) => update(i, { actions: r.actions.map((x, j) => (j === k ? { ...a, keep: e.target.checked } : x)) })} />保留一份</label>
                      </>
                    )}
                    <span className="grow" />
                    <button className="icon-btn" disabled={r.actions.length === 1} onClick={() => update(i, { actions: r.actions.filter((_, j) => j !== k) })}><X size={15} /></button>
                  </div>
                ))}
                <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => update(i, { actions: [...r.actions, { type: 'flag' }] })}><Plus size={14} /> 动作</button>
              </div>
            ))}
            <button className="btn" style={{ justifySelf: 'start' }} onClick={() => setRules([...list, blankRule()])}><Plus size={15} /> 新规则</button>
            {(script ?? data.data.script) && (
              <details>
                <summary className="muted small" style={{ cursor: 'pointer' }}>查看生成的 Sieve 脚本</summary>
                <pre className="code-block">{script ?? data.data.script}</pre>
              </details>
            )}
            <div className="dialog-foot">
              <button className="btn ghost" onClick={onClose}>关闭</button>
              <button className="btn primary" disabled={busy || !rules} onClick={save}>{busy ? '保存中…' : '保存到服务器'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
