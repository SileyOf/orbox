import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FormEvent, ReactNode } from 'react';
import { useAccounts, useSaveSettings, useUser } from '../App';
import { api } from '../api';
import type { Account, UserSettings } from '../api';
import { ACCENTS, toast, toastError } from '../lib';

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  );
}

function Setting({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <div>{title}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function Settings() {
  const user = useUser();
  const qc = useQueryClient();
  const save = useSaveSettings();
  const { data: accounts = [] } = useAccounts();
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const s = user.settings;
  const [params, setParams] = useSearchParams();
  const about = useQuery({ queryKey: ['auth-status'], queryFn: () => api<{ version: string }>('/auth/status') });

  // Microsoft 授权完成后会带着结果跳回这里
  useEffect(() => {
    if (params.get('oauth') === 'ok') toast('Outlook 邮箱已连接，正在同步');
    else if (params.get('oauth_error')) toast(`授权失败：${params.get('oauth_error')}`, { kind: 'error', ms: 10_000 });
    else return;
    setParams({}, { replace: true });
  }, [params]);

  const set = (patch: Partial<UserSettings>) => save({ settings: patch }).catch(toastError);

  const tg = useQuery({
    queryKey: ['telegram'],
    queryFn: () => api<{ enabled: boolean; bot: string | null; linked: { username: string } | null }>('/telegram'),
    // 等待用户在 Telegram 里点 Start 的这段时间轮询绑定状态
    refetchInterval: (q) => (q.state.data?.enabled && !q.state.data.linked ? 4000 : false),
  });

  async function linkTelegram() {
    try {
      const { url } = await api<{ url: string }>('/telegram/link', { method: 'POST' });
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toastError(e);
    }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    location.href = '/';
  }

  return (
    <div className="settings">
      <div className="settings-inner">
        <h1>设置</h1>

        <section className="section">
          <div className="row">
            <h2 className="grow">邮箱账号</h2>
            <button className="btn sm" onClick={() => setEditing('new')}><Plus size={15} /> 添加邮箱</button>
          </div>
          <div className="card">
            {accounts.map((a) => (
              <div className="setting" key={a.id}>
                <div className="row">
                  <span className="dot" style={{ background: a.color, width: 10, height: 10 }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="truncate">{a.name} <span className="muted small">{a.email}</span></div>
                    <div className="small" style={{ color: a.sync_state === 'error' ? 'var(--danger)' : 'var(--muted)' }}>
                      {a.sync_state === 'error' ? `连接失败：${a.last_error}` : a.sync_state === 'syncing' ? '同步中…' : `${a.auth_type === 'oauth' ? 'Microsoft 登录' : a.imap_host} · 已连接`}
                    </div>
                  </div>
                </div>
                <button className="icon-btn" title="编辑" onClick={() => setEditing(a)}><Pencil size={16} /></button>
                <button
                  className="icon-btn"
                  title="移除"
                  onClick={() => confirm(`移除 ${a.email}？只会从 Orbox 移除，服务器上的邮件不受影响。`) && api(`/accounts/${a.id}`, { method: 'DELETE' }).catch(toastError)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            {!accounts.length && <div className="setting muted">还没有邮箱，添加一个 mailcow 或任意 IMAP 邮箱开始使用。</div>}
          </div>
        </section>

        <section className="section">
          <h2>外观</h2>
          <div className="card">
            <Setting title="主题">
              <div className="tabs">
                {(['system', 'light', 'dark'] as const).map((t) => (
                  <button key={t} className={s.theme === t ? 'active' : ''} onClick={() => set({ theme: t })}>
                    {{ system: '跟随系统', light: '浅色', dark: '深色' }[t]}
                  </button>
                ))}
              </div>
            </Setting>
            <Setting title="强调色" hint="用于按钮、选中态和未读标记">
              <div className="swatches">
                {ACCENTS.map((c) => (
                  <button key={c} className={`swatch${s.accent.toLowerCase() === c ? ' on' : ''}`} style={{ background: c }} onClick={() => set({ accent: c })} title={c} />
                ))}
                <input className="swatch-custom" type="color" value={s.accent} onChange={(e) => set({ accent: e.target.value })} title="自定义颜色" />
              </div>
            </Setting>
            <Setting title="拦截远程图片" hint="阻止邮件里的追踪像素得知你已读，可在单封邮件里手动放行">
              <Switch checked={s.blockRemoteImages} onChange={(v) => set({ blockRemoteImages: v })} />
            </Setting>
          </div>
        </section>

        <section className="section">
          <h2>通知</h2>
          <div className="card">
            <Setting
              title="Telegram"
              hint={
                !tg.data?.enabled
                  ? '服务器还没有配置机器人 Token（TELEGRAM_BOT_TOKEN）'
                  : tg.data.linked
                    ? `已绑定 ${tg.data.linked.username ? '@' + tg.data.linked.username : ''}，机器人 @${tg.data.bot}`
                    : `点击绑定后在 Telegram 里按 Start 即可，机器人 @${tg.data.bot}`
              }
            >
              {tg.data?.linked ? (
                <>
                  <button className="btn sm" onClick={() => api('/telegram/test', { body: {} }).then(() => toast('已发送测试消息')).catch(toastError)}>
                    <Send size={14} /> 测试
                  </button>
                  <button className="btn sm danger" onClick={() => api('/telegram', { method: 'DELETE' }).then(() => tg.refetch())}>解绑</button>
                </>
              ) : (
                <button className="btn sm accent" disabled={!tg.data?.enabled} onClick={linkTelegram}>绑定</button>
              )}
            </Setting>
            <Setting title="新邮件通知" hint="每个邮箱还可以在账号设置里单独关闭">
              <Switch checked={s.notifyMail} onChange={(v) => set({ notifyMail: v })} />
            </Setting>
            <Setting title="邮件免打扰时段" hint="这段时间内不推送新邮件；计划提醒不受影响。起止相同即关闭">
              <input className="input" type="time" value={s.quietStart} onChange={(e) => e.target.value && set({ quietStart: e.target.value })} />
              <span className="muted">至</span>
              <input className="input" type="time" value={s.quietEnd} onChange={(e) => e.target.value && set({ quietEnd: e.target.value })} />
            </Setting>
            <Setting title="验证码邮件始终通知" hint="识别到验证码的邮件无视免打扰时段，通知里直接带上验证码和复制按钮">
              <Switch checked={s.codeAlways} onChange={(v) => set({ codeAlways: v })} />
            </Setting>
            <SenderRule
              title="重点发件人"
              hint="始终通知并加星标记，不受免打扰限制。每行一个邮箱地址或域名"
              value={s.vipSenders}
              onSave={(v) => set({ vipSenders: v })}
            />
            <SenderRule
              title="屏蔽通知的发件人"
              hint="这些发件人的邮件照常接收，但不推送。每行一个邮箱地址或域名"
              value={s.mutedSenders}
              onSave={(v) => set({ mutedSenders: v })}
            />
            <Setting title="每日早报" hint="汇总今天的计划和未读邮件数">
              {s.digestTime && <input className="input" type="time" value={s.digestTime} onChange={(e) => e.target.value && set({ digestTime: e.target.value })} />}
              <Switch checked={!!s.digestTime} onChange={(v) => set({ digestTime: v ? '08:30' : '' })} />
            </Setting>
            <Setting title="计划没处理时再次提醒" hint="新建计划的默认值，单个计划可单独调整">
              <select className="select" value={s.nagInterval} onChange={(e) => set({ nagInterval: Number(e.target.value) })}>
                <option value={0}>只提醒一次</option>
                <option value={5}>每 5 分钟</option>
                <option value={15}>每 15 分钟</option>
                <option value={30}>每 30 分钟</option>
                <option value={60}>每小时</option>
              </select>
            </Setting>
            <Setting title="浏览器通知" hint="页面在后台时用系统通知提醒新邮件和计划">
              <button
                className="btn sm"
                disabled={!('Notification' in window) || Notification.permission === 'granted'}
                onClick={() => Notification.requestPermission().then((p) => toast(p === 'granted' ? '已开启' : '浏览器拒绝了通知权限'))}
              >
                {'Notification' in window && Notification.permission === 'granted' ? '已开启' : '开启'}
              </button>
            </Setting>
          </div>
        </section>

        <section className="section">
          <h2>更多通知通道</h2>
          <div className="card">
            <Channel name="bark" title="Bark（iOS）" placeholder="https://api.day.app/你的Key" hint="验证码会自动进入剪贴板" value={s.channels.bark} onSave={(v) => set({ channels: { ...s.channels, bark: v } })} />
            <Channel name="ntfy" title="ntfy" placeholder="https://ntfy.sh/你的主题" hint="填完整的主题地址，支持自建服务器" value={s.channels.ntfy} onSave={(v) => set({ channels: { ...s.channels, ntfy: v } })} />
            <Channel name="webhook" title="Webhook" placeholder="https://example.com/hook" hint="每条通知以 JSON POST 到这个地址，字段有 title、body、text、url、code" value={s.channels.webhook} onSave={(v) => set({ channels: { ...s.channels, webhook: v } })} />
          </div>
          <div className="muted small">这些通道只能单向推送，没有 Telegram 那样的操作按钮。新邮件和计划提醒会同时发往所有已填写的通道。</div>
        </section>

        <Profile onLogout={logout} />
        <div className="muted small" style={{ textAlign: 'center' }}>Orbox {about.data?.version && `v${about.data.version}`} · 起源</div>
      </div>
      {editing && <AccountDialog account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SenderRule(props: { title: string; hint: string; value: string[]; onSave: (v: string[]) => void }) {
  const [text, setText] = useState(props.value.join('\n'));
  const parse = () => [...new Set(text.split(/[\n,，;；\s]+/).map((v) => v.trim().toLowerCase()).filter((v) => v.length >= 3))];
  return (
    <div className="setting" style={{ alignItems: 'flex-start' }}>
      <div>
        <div>{props.title}</div>
        <div className="muted small">{props.hint}</div>
      </div>
      <textarea
        className="textarea"
        style={{ width: 260, minHeight: 64 }}
        placeholder={'boss@example.com\ngithub.com'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => parse().join() !== props.value.join() && props.onSave(parse())}
      />
    </div>
  );
}

function Channel(props: { name: string; title: string; placeholder: string; hint: string; value: string; onSave: (v: string) => void }) {
  const [url, setUrl] = useState(props.value);
  const test = () =>
    api('/notify/test', { body: { channel: props.name, target: url.trim() } })
      .then(() => toast('已发送测试通知'))
      .catch(toastError);
  return (
    <div className="setting">
      <div>
        <div>{props.title}</div>
        <div className="muted small">{props.hint}</div>
      </div>
      <input
        className="input"
        style={{ width: 280 }}
        placeholder={props.placeholder}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => url.trim() !== props.value && props.onSave(url.trim())}
      />
      <button className="btn sm" disabled={!url.trim()} onClick={test}>测试</button>
    </div>
  );
}

function Profile({ onLogout }: { onLogout: () => void }) {
  const user = useUser();
  const save = useSaveSettings();
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ current: '', next: '' });
  const zones = Intl.supportedValuesOf('timeZone');

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    try {
      await save({ password: pw });
      setPw({ current: '', next: '' });
      toast('密码已修改');
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <section className="section">
      <h2>账户</h2>
      <div className="card">
        <Setting title="登录邮箱">
          <span className="muted">{user.email}</span>
        </Setting>
        <Setting title="昵称" hint="同时作为默认的发件人名称">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== user.name && save({ name }).catch(toastError)} />
        </Setting>
        <Setting title="时区" hint="提醒时间、重复规则和早报都按这个时区计算">
          <select className="select" value={user.timezone} onChange={(e) => save({ timezone: e.target.value }).catch(toastError)}>
            {zones.map((z) => <option key={z}>{z}</option>)}
          </select>
        </Setting>
        <form className="setting" onSubmit={changePassword}>
          <div>修改密码</div>
          <input className="input" type="password" placeholder="当前密码" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
          <input className="input" type="password" placeholder="新密码（至少 8 位）" autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
          <button className="btn sm">保存</button>
        </form>
        <Setting title="退出登录">
          <button className="btn sm danger" onClick={onLogout}>退出</button>
        </Setting>
      </div>
    </section>
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
