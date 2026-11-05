import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, Copy, Download, ExternalLink, Gauge, ImageUp, KeyRound, LogOut, Palette, Pencil, Plus, QrCode, RefreshCw, ScrollText, Trash2, Users } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useUser } from '../App';
import { api } from '../api';
import type { AiProvider } from '../api';
import { ACCENTS, copyText, toast, toastError } from '../lib';
import { ProviderDialog } from './settings/Ai';
import { Section, Setting, Switch } from './settings/ui';

// 后台管理：站点外观、注册与用户、聊天平台和 OAuth 集成、共享模型。只有管理员能进，地址可在"站点"里修改。

const SECTIONS = [
  { id: 'overview', label: '概览', icon: Gauge },
  { id: 'site', label: '站点外观', icon: Palette },
  { id: 'users', label: '注册与用户', icon: Users },
  { id: 'integrations', label: '集成', icon: Bot },
  { id: 'models', label: '共享模型', icon: KeyRound },
  { id: 'logs', label: '运行日志', icon: ScrollText },
];

export function Admin() {
  const user = useUser();
  const { section = 'overview' } = useParams();
  const Page = { overview: Overview, site: SitePage, users: UsersPage, integrations: Integrations, models: Models, logs: Logs }[section] ?? Overview;
  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        <h1>后台管理</h1>
        {SECTIONS.map((s) => (
          <NavLink key={s.id} end to={s.id === 'overview' ? `/${user.adminPath}` : `/${user.adminPath}/${s.id}`} className={({ isActive }) => `side-item${isActive ? ' active' : ''}`}>
            <s.icon size={16} />
            {s.label}
          </NavLink>
        ))}
        <NavLink to="/settings/mailboxes" className="side-item admin-link">
          <ArrowLeft size={16} />
          返回个人设置
        </NavLink>
      </nav>
      <div className="settings">
        <div className="settings-inner">
          <Page />
        </div>
      </div>
    </div>
  );
}

// ---------------- 概览 ----------------

interface OverviewData {
  version: string;
  node: string;
  uptime: number;
  users: number;
  accounts: number;
  messages: number;
  tasks: number;
  dbSize: number;
  bots: BotState[];
  publicUrl: string;
}

interface BotState {
  platform: string;
  label: string;
  enabled: boolean;
  name: string | null;
  error: string | null;
  errorAt: number | null;
}

/** 平台连接状态的一句话说明 */
const botHint = (s?: BotState) =>
  !s?.enabled ? '未配置' : s.name ? `✅ 已连接 · ${s.name}` : s.error ? `⚠️ 连接失败（会自动重试）：${s.error}` : '已配置，正在连接…';

const size = (n: number) => (n > 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`);
const duration = (s: number) => (s > 86400 ? `${Math.floor(s / 86400)} 天` : s > 3600 ? `${Math.floor(s / 3600)} 小时` : `${Math.floor(s / 60)} 分钟`);

function Overview() {
  const user = useUser();
  const d = useQuery({ queryKey: ['admin-overview'], queryFn: () => api<OverviewData>('/admin/overview'), refetchInterval: 30_000 }).data;
  if (!d) return <div className="muted">加载中…</div>;
  return (
    <>
      <Section title="概览">
        <div className="stat stat4">
          {[
            ['用户', d.users],
            ['邮箱', d.accounts],
            ['邮件缓存', d.messages],
            ['待办', d.tasks],
          ].map(([k, v]) => (
            <div className="card" key={k}>
              <b>{Number(v).toLocaleString()}</b>
              <span className="muted small">{k}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <Setting title="版本">v{d.version}</Setting>
          <Setting title="运行时间">{duration(d.uptime)} · Node {d.node}</Setting>
          <Setting title="数据库占用">{size(d.dbSize)}</Setting>
          <Setting title="对外地址" hint="来自 .env 的 PUBLIC_URL，决定登录 Cookie、OAuth 回调和机器人里的链接">{d.publicUrl}</Setting>
        </div>
      </Section>
      <Section title="聊天平台">
        <div className="card">
          {d.bots.map((b) => (
            <Setting key={b.platform} title={b.label} hint={botHint(b)}>
              <NavLink className="btn sm" to={`/${user.adminPath}/integrations`}>配置</NavLink>
            </Setting>
          ))}
        </div>
      </Section>
    </>
  );
}

// ---------------- 站点外观 ----------------

interface SiteConfig {
  name: string;
  subtitle: string;
  loginText: string;
  footer: string;
  logo: string;
  accent: string;
  theme: 'system' | 'light' | 'dark';
  adminPath: string;
  registration: 'open' | 'invite' | 'closed';
  defaultTimezone: string;
  shareAi: boolean;
  defaultPerms: Perms;
}

interface Perms {
  maxAccounts: number;
  sharedAi: boolean;
  ownAi: boolean;
  bots: boolean;
  mcp: boolean;
  privateHosts: boolean;
}

const PERM_ITEMS: { key: Exclude<keyof Perms, 'maxAccounts'>; title: string; hint: string }[] = [
  { key: 'sharedAi', title: '使用共享模型', hint: '用管理员在"共享模型"里配置的服务（还需要开启"开放共享模型"）' },
  { key: 'ownAi', title: '自己添加模型服务', hint: '在 设置 → AI 里填写自己的 API Key' },
  { key: 'bots', title: '聊天机器人', hint: '绑定 Telegram、飞书等，接收推送和对话' },
  { key: 'mcp', title: 'MCP 外部连接', hint: '生成令牌，让 Hermes、Claude Desktop 等外部 AI 读写邮件和计划' },
  { key: 'privateHosts', title: '允许连接内网地址', hint: '邮箱服务器、模型接口可以填 127.0.0.1、192.168.x.x 等。有探测服务器内网的风险，只给信任的人' },
];

function PermsEditor({ value, onChange, disabled }: { value: Perms; onChange: (p: Perms) => void; disabled?: boolean }) {
  return (
    <>
      <Setting title="邮箱数量上限" hint="0 表示不限">
        <input
          className="input"
          type="number"
          min={0}
          max={100}
          style={{ width: 90 }}
          disabled={disabled}
          value={value.maxAccounts}
          onChange={(e) => onChange({ ...value, maxAccounts: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
        />
      </Setting>
      {PERM_ITEMS.map((p) => (
        <Setting key={p.key} title={p.title} hint={p.hint}>
          <Switch checked={value[p.key]} disabled={disabled} onChange={(v) => onChange({ ...value, [p.key]: v })} />
        </Setting>
      ))}
    </>
  );
}

function useSiteConfig() {
  return useQuery({ queryKey: ['admin-site'], queryFn: () => api<SiteConfig>('/admin/site') });
}

function SitePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const site = useSiteConfig();
  const [f, setF] = useState<SiteConfig | null>(null);
  useEffect(() => {
    if (site.data) setF(site.data);
  }, [site.data]);
  if (!f) return <div className="muted">加载中…</div>;
  const set = (patch: Partial<SiteConfig>) => setF({ ...f, ...patch });

  function pickLogo(file?: File) {
    if (!file) return;
    if (file.size > 280 * 1024) return toast('Logo 文件请小于 280KB', { kind: 'error' });
    const r = new FileReader();
    r.onload = () => set({ logo: String(r.result) });
    r.readAsDataURL(file);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const saved = await api<SiteConfig>('/admin/site', { method: 'PUT', body: f });
      qc.setQueryData(['admin-site'], saved);
      qc.invalidateQueries({ queryKey: ['auth-status'] });
      const moved = saved.adminPath !== site.data?.adminPath;
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast(moved ? `已保存，后台地址改为 /${saved.adminPath}` : '已保存');
      if (moved) navigate(`/${saved.adminPath}/site`, { replace: true });
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 28 }}>
      <Section title="品牌">
        <div className="card" style={{ padding: 18, display: 'grid', gap: 14 }}>
          <div className="row" style={{ gap: 16 }}>
            <img src={f.logo || '/logo.svg'} alt="" style={{ width: 56, height: 56, borderRadius: 14, objectFit: 'cover' }} />
            <div className="grow" style={{ display: 'grid', gap: 6 }}>
              <div className="row">
                <label className="btn sm">
                  <ImageUp size={14} /> 上传 Logo
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden onChange={(e) => pickLogo(e.target.files?.[0])} />
                </label>
                {f.logo && <button type="button" className="btn ghost sm" onClick={() => set({ logo: '' })}>恢复默认</button>}
              </div>
              <span className="muted small">用于侧边栏、登录页、浏览器图标和"添加到主屏幕"。建议正方形，小于 280KB。</span>
            </div>
          </div>
          <div className="grid2">
            <label className="field"><span>站点名称</span><input className="input" required maxLength={40} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <label className="field"><span>副标题</span><input className="input" maxLength={80} value={f.subtitle} onChange={(e) => set({ subtitle: e.target.value })} /></label>
          </div>
          <label className="field"><span>登录页说明（可选）</span><textarea className="textarea" maxLength={300} style={{ minHeight: 60 }} value={f.loginText} onChange={(e) => set({ loginText: e.target.value })} placeholder="例如：这是我的私人邮箱，仅限邀请注册" /></label>
          <label className="field"><span>页脚（可选）</span><input className="input" maxLength={200} value={f.footer} onChange={(e) => set({ footer: e.target.value })} placeholder="例如 Powered by Yuki" /></label>
        </div>
      </Section>
      <Section title="新用户默认值">
        <div className="card">
          <Setting title="默认主题">
            <div className="tabs">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button type="button" key={t} className={f.theme === t ? 'active' : ''} onClick={() => set({ theme: t })}>{{ system: '跟随系统', light: '浅色', dark: '深色' }[t]}</button>
              ))}
            </div>
          </Setting>
          <Setting title="默认强调色" hint="也用于登录页">
            <div className="swatches">
              {ACCENTS.map((c) => <button type="button" key={c} className={`swatch${f.accent.toLowerCase() === c ? ' on' : ''}`} style={{ background: c }} onClick={() => set({ accent: c })} />)}
              <input className="swatch-custom" type="color" value={f.accent} onChange={(e) => set({ accent: e.target.value })} />
            </div>
          </Setting>
          <Setting title="默认时区">
            <select className="select" value={f.defaultTimezone} onChange={(e) => set({ defaultTimezone: e.target.value })}>
              {Intl.supportedValuesOf('timeZone').map((z) => <option key={z}>{z}</option>)}
            </select>
          </Setting>
        </div>
      </Section>
      <Section title="后台地址">
        <div className="card">
          <Setting title="后台路径" hint="改成不容易被猜到的路径。只有管理员能打开，修改后请收藏新地址">
            <span className="muted">/</span>
            <input className="input" style={{ width: 200 }} value={f.adminPath} onChange={(e) => set({ adminPath: e.target.value })} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{2,39}" />
          </Setting>
        </div>
      </Section>
      <div><button className="btn primary">保存</button></div>
    </form>
  );
}

// ---------------- 注册与用户 ----------------

interface AdminUser {
  id: number;
  email: string;
  name: string;
  is_admin: number;
  disabled: number;
  created_at: string;
  last_login_at: string | null;
  last_seen_at: string | null;
  accounts: number;
  sessions: number;
  bots: number;
  tokens: number;
  custom: boolean;
  perms: Perms;
}

const ago = (iso: string) => {
  const m = (Date.now() - new Date(iso).getTime()) / 60_000;
  return m < 5 ? '刚刚' : m < 60 ? `${Math.floor(m)} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : m < 43200 ? `${Math.floor(m / 1440)} 天前` : new Date(iso).toLocaleDateString();
};

function UserDialog({ user, defaults, self, onClose, onChanged }: { user: AdminUser; defaults: Perms; self: boolean; onClose: () => void; onChanged: () => void }) {
  const [f, setF] = useState({ name: user.name, email: user.email, isAdmin: !!user.is_admin, disabled: !!user.disabled, custom: user.custom, perms: user.perms });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = { perms: f.custom ? f.perms : null };
      if (f.name !== user.name) body.name = f.name;
      if (f.email !== user.email) body.email = f.email;
      if (!self) Object.assign(body, { isAdmin: f.isAdmin, disabled: f.disabled });
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body });
      toast('已保存');
      onChanged();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!confirm(`为 ${user.email} 生成一个临时密码？他所有已登录的设备会下线。`)) return;
    try {
      const r = await api<{ password: string }>(`/admin/users/${user.id}/reset-password`, { method: 'POST' });
      prompt('临时密码（请转交给用户，登录后在 设置 → 账户 修改）', r.password);
      onChanged();
    } catch (err) {
      toastError(err);
    }
  }

  const logout = () =>
    api<{ count: number }>(`/admin/users/${user.id}/logout`, { method: 'POST' })
      .then((r) => (toast(r.count ? `已让 ${r.count} 个设备下线` : '这个用户当前没有登录的设备'), onChanged()))
      .catch(toastError);

  const remove = () =>
    confirm(`删除 ${user.email}？他的邮箱配置、计划、简单记和缓存都会被删除（服务器上的邮件不受影响），无法恢复。`) &&
    api(`/admin/users/${user.id}`, { method: 'DELETE' })
      .then(() => (onChanged(), onClose()))
      .catch(toastError);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" style={{ width: 'min(600px, 100%)' }} onSubmit={submit}>
        <h2>编辑用户</h2>
        <div className="grid2">
          <label className="field">
            <span>名字</span>
            <input className="input" required maxLength={100} value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field">
            <span>登录邮箱</span>
            <input className="input" type="email" required value={f.email} onChange={(e) => set({ email: e.target.value })} />
          </label>
        </div>
        <div className="card" style={{ padding: '2px 16px' }}>
          <Setting title="管理员" hint={self ? '不能取消自己的管理员身份' : '可以进入后台，不受下面的权限限制'}>
            <Switch checked={f.isAdmin} disabled={self} onChange={(v) => set({ isAdmin: v })} />
          </Setting>
          <Setting title="停用账号" hint="停用后立即下线，不能再登录，推送也会停止">
            <Switch checked={f.disabled} disabled={self} onChange={(v) => set({ disabled: v })} />
          </Setting>
        </div>
        {!f.isAdmin && (
          <div className="card" style={{ padding: '2px 16px' }}>
            <Setting title="单独设置权限" hint={f.custom ? '这个用户使用下面的权限' : '跟随"默认权限"，修改默认权限时一起变'}>
              <Switch checked={f.custom} onChange={(v) => set({ custom: v, perms: v ? f.perms : defaults })} />
            </Setting>
            <PermsEditor value={f.custom ? f.perms : defaults} disabled={!f.custom} onChange={(perms) => set({ perms })} />
          </div>
        )}
        <div className="muted small">
          {user.sessions} 个设备登录中 · {user.accounts} 个邮箱 · {user.bots} 个机器人绑定 · {user.tokens} 个 MCP 令牌
        </div>
        <div className="dialog-foot" style={{ flexWrap: 'wrap' }}>
          {!self && (
            <>
              <button type="button" className="btn ghost sm" onClick={resetPassword}>
                <KeyRound size={14} /> 重置密码
              </button>
              <button type="button" className="btn ghost sm" onClick={logout} disabled={!user.sessions}>
                <LogOut size={14} /> 退出所有设备
              </button>
              <button type="button" className="btn ghost sm danger" onClick={remove}>
                <Trash2 size={14} /> 删除
              </button>
            </>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
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

function UsersPage() {
  const me = useUser();
  const qc = useQueryClient();
  const site = useSiteConfig();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api<AdminUser[]>('/admin/users') });
  const invites = useQuery({ queryKey: ['admin-invites'], queryFn: () => api<{ code: string; note: string; used_at: string | null; used_by_email: string | null; expires_at: string | null }[]>('/admin/invites') });
  const [note, setNote] = useState('');
  const [days, setDays] = useState(7);

  const setSite = (patch: Partial<SiteConfig>) =>
    api<SiteConfig>('/admin/site', { method: 'PUT', body: patch }).then((s) => qc.setQueryData(['admin-site'], s)).catch(toastError);

  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [perms, setPerms] = useState<Perms | null>(null);
  useEffect(() => {
    if (site.data) setPerms(site.data.defaultPerms);
  }, [site.data]);

  return (
    <>
      <Section title="注册">
        <div className="card">
          <Setting title="注册方式" hint="第一个注册的用户始终可以注册，并自动成为管理员">
            <div className="tabs">
              {(['open', 'invite', 'closed'] as const).map((r) => (
                <button key={r} className={site.data?.registration === r ? 'active' : ''} onClick={() => setSite({ registration: r })}>
                  {{ open: '开放注册', invite: '凭邀请码', closed: '关闭' }[r]}
                </button>
              ))}
            </div>
          </Setting>
        </div>
      </Section>
      {site.data?.registration === 'invite' && (
        <Section title="邀请码">
          <div className="card">
            <form
              className="setting"
              onSubmit={(e) => {
                e.preventDefault();
                api<{ codes: string[] }>('/admin/invites', { body: { note, days } })
                  .then((r) => (copyText(r.codes[0], '已生成并复制'), setNote(''), invites.refetch()))
                  .catch(toastError);
              }}
            >
              <input className="input grow" placeholder="备注，例如给谁的" value={note} onChange={(e) => setNote(e.target.value)} />
              <select className="select" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                <option value={1}>1 天有效</option>
                <option value={7}>7 天有效</option>
                <option value={30}>30 天有效</option>
                <option value={0}>永久有效</option>
              </select>
              <button className="btn sm accent"><Plus size={14} /> 生成</button>
            </form>
            {(invites.data || []).map((i) => (
              <Setting
                key={i.code}
                title={<code>{i.code}</code>}
                hint={[i.note, i.used_by_email ? `已被 ${i.used_by_email} 使用` : i.expires_at ? `有效期至 ${new Date(i.expires_at).toLocaleDateString()}` : '永久有效'].filter(Boolean).join(' · ')}
              >
                {!i.used_by_email && <button className="icon-btn" title="复制" onClick={() => copyText(i.code)}><Copy size={15} /></button>}
                <button className="icon-btn" title="删除" onClick={() => api(`/admin/invites/${i.code}`, { method: 'DELETE' }).then(() => invites.refetch())}><Trash2 size={15} /></button>
              </Setting>
            ))}
          </div>
        </Section>
      )}
      <Section title={`用户（${users.data?.length ?? 0}）`}>
        <div className="card">
          {(users.data || []).map((u) => {
            const seen = u.last_seen_at || u.last_login_at;
            const limits = !u.is_admin && u.custom ? '单独权限' : '';
            return (
              <Setting
                key={u.id}
                title={
                  <>
                    {u.name} <span className="muted small">{u.email}</span> {u.is_admin ? <span className="chip accent" style={{ height: 20 }}>管理员</span> : null}{' '}
                    {u.disabled ? <span className="chip danger" style={{ height: 20 }}>已停用</span> : null} {limits && <span className="chip" style={{ height: 20 }}>{limits}</span>}
                  </>
                }
                hint={`${u.accounts} 个邮箱 · 注册于 ${new Date(u.created_at).toLocaleDateString()} · ${seen ? `最近活跃 ${ago(seen)}` : '还没有登录过'}${u.sessions ? ` · ${u.sessions} 个设备在线` : ''}`}
              >
                <button className="btn ghost sm" onClick={() => setEditing(u)}>
                  <Pencil size={14} /> 编辑
                </button>
              </Setting>
            );
          })}
        </div>
      </Section>
      {perms && (
        <Section title="默认权限" hint="新用户和没有单独设置权限的用户使用这里的权限；管理员不受限制">
          <div className="card">
            <PermsEditor value={perms} onChange={(p) => (setPerms(p), setSite({ defaultPerms: p }).then(() => users.refetch()))} />
          </div>
        </Section>
      )}
      {editing && site.data && (
        <UserDialog user={editing} defaults={site.data.defaultPerms} self={editing.id === me.id} onClose={() => setEditing(null)} onChanged={() => users.refetch()} />
      )}
    </>
  );
}

// ---------------- 集成 ----------------

interface IntegrationsData {
  values: {
    telegram: { token: string; proxy: string };
    feishu: { appId: string; appSecret: string; domain: 'feishu' | 'lark' };
    discord: { token: string };
    slack: { botToken: string; appToken: string };
    microsoft: { clientId: string; clientSecret: string };
  };
  status: BotState[];
  discordInvite: string | null;
  microsoftRedirect: string;
  slackManifest: object;
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="steps">{children}</ol>;
}

/** 一个平台的凭据表单。密钥框留空表示不修改，填"-"之外的内容才会覆盖 */
function CredentialForm(props: { platform: string; fields: { key: string; label: string; secret?: boolean; placeholder?: string; value: string }[]; onSaved: () => void; extra?: ReactNode }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save(clear = false) {
    setBusy(true);
    try {
      const body = clear ? Object.fromEntries(props.fields.map((f) => [f.key, ''])) : Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== ''));
      await api(`/admin/integrations/${props.platform}`, { method: 'PUT', body });
      toast(clear ? '已清除' : '已保存并重新连接');
      setVals({});
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      props.onSaved();
    }
  }
  const configured = props.fields.some((f) => f.value);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="grid2">
        {props.fields.map((f) => (
          <label className="field" key={f.key}>
            <span>{f.label}</span>
            <input
              className="input"
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={f.secret && f.value ? `已保存 ${f.value}，留空不修改` : f.placeholder || f.value}
              value={vals[f.key] ?? (f.secret ? '' : f.value)}
              onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {props.extra}
      <div className="row">
        <button className="btn primary sm" disabled={busy} onClick={() => save()}>{busy ? '连接中…' : '保存并连接'}</button>
        {configured && <button className="btn ghost sm danger" disabled={busy} onClick={() => confirm('清除这个平台的凭据并停用？') && save(true)}>清除</button>}
      </div>
    </div>
  );
}

function FeishuQr({ lark, onDone }: { lark: boolean; onDone: () => void }) {
  const [qr, setQr] = useState<{ url: string; img: string } | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/admin/feishu/register', { body: { lark } });
      setQr({ url, img: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
      setState('waiting');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (state !== 'waiting') return;
    const t = setInterval(async () => {
      const s = await api<{ state: string; error?: string }>('/admin/feishu/register').catch(() => null);
      if (!s || s.state === 'waiting') return;
      setState(s.state);
      if (s.state === 'done') {
        toast(s.error || '应用已创建，机器人正在连接');
        onDone();
      } else toast(`创建失败：${s.error}`, { kind: 'error' });
    }, 3000);
    return () => clearInterval(t);
  }, [state]);

  if (!qr || state !== 'waiting')
    return (
      <button className="btn sm accent" disabled={busy} onClick={start}>
        <QrCode size={14} /> {busy ? '准备中…' : `用${lark ? ' Lark' : '飞书'}扫码一键创建应用`}
      </button>
    );
  return (
    <div className="qr-box">
      <img src={qr.img} alt="扫码创建应用" />
      <div className="muted small">
        用{lark ? ' Lark' : '飞书'} App 扫码（或<a href={qr.url} target="_blank" rel="noopener noreferrer">在浏览器打开</a>），按提示确认创建。权限、事件和回调会自动预填，完成后这里会自动保存凭据并连接。
      </div>
    </div>
  );
}

function Integrations() {
  // 有平台正在连接 / 重试时定时刷新状态
  const q = useQuery({
    queryKey: ['admin-integrations'],
    queryFn: () => api<IntegrationsData>('/admin/integrations'),
    refetchInterval: (query) => (query.state.data?.status.some((x) => x.enabled && !x.name) ? 10_000 : false),
  });
  const d = q.data;
  if (!d) return <div className="muted">加载中…</div>;
  const status = (p: string) => botHint(d.status.find((x) => x.platform === p));
  const refetch = () => q.refetch();
  const v = d.values;

  return (
    <>
      <Section title="Telegram" hint={status('telegram')}>
        <div className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
          <Steps>
            <li>在 Telegram 里打开 <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a>，发送 <code>/newbot</code>，按提示起名。</li>
            <li>把它给出的 Token 填到下面。同一个 Token 只能给一个程序用。</li>
          </Steps>
          <CredentialForm
            platform="telegram"
            onSaved={refetch}
            fields={[
              { key: 'token', label: 'Bot Token', secret: true, value: v.telegram.token, placeholder: '123456:ABC-...' },
              { key: 'proxy', label: 'HTTP 代理（可选）', value: v.telegram.proxy, placeholder: '服务器直连不了 Telegram 时填，如 http://127.0.0.1:7890' },
            ]}
          />
        </div>
      </Section>

      <Section title="飞书 / Lark" hint={status('feishu')}>
        <div className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <FeishuQr lark={false} onDone={refetch} />
            <FeishuQr lark onDone={refetch} />
          </div>
          <Steps>
            <li>扫码创建后（或手动创建企业自建应用后），到 <a href={`${v.feishu.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'}/app${v.feishu.appId ? `/${v.feishu.appId}` : ''}`} target="_blank" rel="noopener noreferrer">开放平台的应用页面 <ExternalLink size={12} /></a>：</li>
            <li><b>添加应用能力 → 机器人</b>（没开机器人能力会报"could not resolve bot identity"）。</li>
            <li>事件与回调 → <b>事件配置</b>和<b>回调配置</b>的订阅方式都选"使用长连接接收"，并确认已添加事件 <code>im.message.receive_v1</code>、回调 <code>card.action.trigger</code>（要在这里显示"已连接"之后再切换）。</li>
            <li>权限管理确认已开通 <code>im:message</code>、<code>im:message.p2p_msg:readonly</code>、<code>im:message:send_as_bot</code>、<code>im:resource</code>。</li>
            <li>创建版本并发布（企业管理员审核通过后生效）。</li>
          </Steps>
          <CredentialForm
            platform="feishu"
            onSaved={refetch}
            fields={[
              { key: 'appId', label: 'App ID', value: v.feishu.appId, placeholder: 'cli_...' },
              { key: 'appSecret', label: 'App Secret', secret: true, value: v.feishu.appSecret },
            ]}
            extra={
              <label className="row small">
                <input
                  type="checkbox"
                  checked={v.feishu.domain === 'lark'}
                  onChange={(e) => api('/admin/integrations/feishu', { method: 'PUT', body: { domain: e.target.checked ? 'lark' : 'feishu' } }).then(refetch).catch(toastError)}
                />
                使用海外版 Lark
              </label>
            }
          />
        </div>
      </Section>

      <Section title="Discord" hint={status('discord')}>
        <div className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
          <Steps>
            <li>打开 <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal <ExternalLink size={12} /></a> → New Application → Bot → Reset Token，把 Token 填到下面。</li>
            <li>保存连接成功后，用下面的邀请链接把机器人拉进你的服务器（私信机器人需要和它在同一个服务器）。</li>
          </Steps>
          <CredentialForm platform="discord" onSaved={refetch} fields={[{ key: 'token', label: 'Bot Token', secret: true, value: v.discord.token }]} />
          {d.discordInvite && (
            <div className="row">
              <a className="btn sm accent" href={d.discordInvite} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> 邀请机器人进服务器</a>
              <button className="btn ghost sm" onClick={() => copyText(d.discordInvite!)}><Copy size={14} /> 复制链接</button>
            </div>
          )}
        </div>
      </Section>

      <Section title="Slack" hint={status('slack')}>
        <div className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
          <Steps>
            <li>
              打开 <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noopener noreferrer">Slack API <ExternalLink size={12} /></a> → Create New App → <b>From a manifest</b>，选择工作区，粘贴下面的清单（Socket Mode、权限、事件、交互都已配好）。
              <button className="btn ghost sm" onClick={() => copyText(JSON.stringify(d.slackManifest, null, 2), '已复制清单')}><Copy size={14} /> 复制清单</button>
            </li>
            <li>Basic Information → App-Level Tokens → 生成一个带 <code>connections:write</code> 的令牌（xapp- 开头）。</li>
            <li>Install App → 安装到工作区，复制 Bot User OAuth Token（xoxb- 开头）。</li>
          </Steps>
          <CredentialForm
            platform="slack"
            onSaved={refetch}
            fields={[
              { key: 'botToken', label: 'Bot Token（xoxb-）', secret: true, value: v.slack.botToken },
              { key: 'appToken', label: 'App-Level Token（xapp-）', secret: true, value: v.slack.appToken },
            ]}
          />
        </div>
      </Section>

      <Section title="Outlook 登录（Microsoft）" hint={v.microsoft.clientId ? '✅ 已配置' : '未配置：用户无法添加 Outlook / Microsoft 365 邮箱'}>
        <div className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
          <Steps>
            <li>打开 <a href="https://entra.microsoft.com" target="_blank" rel="noopener noreferrer">Microsoft Entra <ExternalLink size={12} /></a> → 应用注册 → 新注册，账户类型选"任何组织目录中的帐户和个人 Microsoft 帐户"。</li>
            <li>
              重定向 URI 选 Web，填 <code>{d.microsoftRedirect}</code>
              <button className="btn ghost sm" onClick={() => copyText(d.microsoftRedirect)}><Copy size={14} /></button>
            </li>
            <li>证书和密码 → 新客户端密码；API 权限添加 Office 365 Exchange Online 的 <code>IMAP.AccessAsUser.All</code>、<code>SMTP.Send</code>。</li>
          </Steps>
          <CredentialForm
            platform="microsoft"
            onSaved={refetch}
            fields={[
              { key: 'clientId', label: '应用程序（客户端）ID', value: v.microsoft.clientId },
              { key: 'clientSecret', label: '客户端密码的值', secret: true, value: v.microsoft.clientSecret },
            ]}
          />
        </div>
      </Section>
    </>
  );
}

// ---------------- 共享模型 ----------------

function Models() {
  const qc = useQueryClient();
  const site = useSiteConfig();
  const list = useQuery({ queryKey: ['admin-ai'], queryFn: () => api<AiProvider[]>('/admin/ai-providers') });
  const [editing, setEditing] = useState<AiProvider | 'new' | null>(null);
  return (
    <>
      <Section
        title="共享模型服务"
        hint="管理员提供给所有用户使用的模型服务，费用由你承担。用户在自己的 AI 设置里可以选用它们。"
        action={<button className="btn sm" onClick={() => setEditing('new')}><Plus size={15} /> 添加</button>}
      >
        <div className="card">
          <Setting title="允许普通用户使用共享模型" hint="关闭后只有管理员自己能用">
            <Switch
              checked={!!site.data?.shareAi}
              onChange={(v) => api('/admin/site', { method: 'PUT', body: { shareAi: v } }).then(() => (site.refetch(), qc.invalidateQueries({ queryKey: ['ai'] })))}
            />
          </Setting>
          {(list.data || []).map((p) => (
            <Setting key={p.id} title={p.name} hint={`${p.kind === 'anthropic' ? 'Claude' : 'OpenAI 兼容'} · ${p.baseUrl || '官方地址'} · 默认 ${p.defaultModel}`}>
              <button className="icon-btn" title="编辑" onClick={() => setEditing(p)}><Pencil size={16} /></button>
              <button className="icon-btn" title="删除" onClick={() => confirm(`删除共享服务「${p.name}」？`) && api(`/admin/ai-providers/${p.id}`, { method: 'DELETE' }).then(() => list.refetch())}>
                <Trash2 size={16} />
              </button>
            </Setting>
          ))}
        </div>
      </Section>
      {editing && (
        <ProviderDialog
          provider={editing === 'new' ? null : editing}
          endpoint="/admin/ai-providers"
          onClose={(changed) => {
            setEditing(null);
            if (changed) (list.refetch(), qc.invalidateQueries({ queryKey: ['ai'] }));
          }}
        />
      )}
    </>
  );
}

// ---------------- 运行日志 ----------------

interface LogLine {
  t: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

function Logs() {
  const [level, setLevel] = useState<'info' | 'warn' | 'error'>('info');
  const [q, setQ] = useState('');
  const [auto, setAuto] = useState(true);
  const logs = useQuery({
    queryKey: ['admin-logs', level, q],
    queryFn: () => api<{ lines: LogLine[]; file: string | null }>(`/admin/logs?level=${level}&q=${encodeURIComponent(q)}&limit=1000`),
    refetchInterval: auto ? 5000 : false,
  });
  const lines = logs.data?.lines || [];
  const download = () => {
    const text = lines
      .slice()
      .reverse()
      .map((l) => `${new Date(l.t).toISOString()} ${l.level.toUpperCase()} ${l.msg}`)
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `orbox-log-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Section
      title="运行日志"
      hint={
        <>
          最近 3000 行，重启后清空。{logs.data?.file ? <>同时写入容器内 <code>{logs.data.file}</code>（5MB 轮转）。</> : '设置环境变量 LOG_DIR 可同时写入文件。'}
          命令行查看：<code>docker compose logs -f --tail=200</code>（在 docker-compose.yml 所在目录执行）
        </>
      }
      action={
        <div className="row">
          <button className="btn sm" onClick={() => logs.refetch()} title="刷新">
            <RefreshCw size={14} />
          </button>
          <button className="btn sm" onClick={download} disabled={!lines.length}>
            <Download size={14} /> 下载
          </button>
        </div>
      }
    >
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="tabs">
          {(['info', 'warn', 'error'] as const).map((l) => (
            <button key={l} className={level === l ? 'active' : ''} onClick={() => setLevel(l)}>
              {{ info: '全部', warn: '警告及以上', error: '仅错误' }[l]}
            </button>
          ))}
        </div>
        <input className="input grow" style={{ minWidth: 160 }} placeholder="搜索，例如 feishu" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row small muted">
          <Switch checked={auto} onChange={setAuto} /> 自动刷新
        </label>
      </div>
      <div className="card log-view">
        {lines.length ? (
          lines.map((l, i) => (
            <div key={`${l.t}-${i}`} className={`log-line ${l.level}`}>
              <time>{new Date(l.t).toLocaleString()}</time>
              <span>{l.msg}</span>
            </div>
          ))
        ) : (
          <div className="muted" style={{ padding: 16 }}>{logs.isLoading ? '加载中…' : '没有匹配的日志'}</div>
        )}
      </div>
    </Section>
  );
}
