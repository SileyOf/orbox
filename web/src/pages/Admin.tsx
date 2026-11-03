import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, Copy, ExternalLink, Gauge, ImageUp, KeyRound, Palette, Pencil, Plus, QrCode, Trash2, Users } from 'lucide-react';
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
];

export function Admin() {
  const user = useUser();
  const { section = 'overview' } = useParams();
  const Page = { overview: Overview, site: SitePage, users: UsersPage, integrations: Integrations, models: Models }[section] ?? Overview;
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
  bots: { platform: string; label: string; enabled: boolean; name: string | null }[];
  publicUrl: string;
}

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
            <Setting key={b.platform} title={b.label} hint={!b.enabled ? '未配置' : b.name ? `已连接 · ${b.name}` : '已配置，正在连接或连接失败'}>
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
  accounts: number;
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
  const patch = (id: number, body: object) => api(`/admin/users/${id}`, { method: 'PATCH', body }).then(() => users.refetch()).catch(toastError);

  async function reset(u: AdminUser) {
    if (!confirm(`为 ${u.email} 生成一个临时密码？他所有已登录的设备会下线。`)) return;
    try {
      const r = await api<{ password: string }>(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
      prompt('临时密码（请转交给用户，登录后在 设置 → 账户 修改）', r.password);
    } catch (e) {
      toastError(e);
    }
  }

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
          {(users.data || []).map((u) => (
            <Setting
              key={u.id}
              title={<>{u.name} <span className="muted small">{u.email}</span> {u.is_admin ? <span className="chip accent" style={{ height: 20 }}>管理员</span> : null} {u.disabled ? <span className="chip danger" style={{ height: 20 }}>已停用</span> : null}</>}
              hint={`${u.accounts} 个邮箱 · 注册于 ${new Date(u.created_at).toLocaleDateString()} · ${u.last_login_at ? `最近登录 ${new Date(u.last_login_at).toLocaleString()}` : '从未登录'}`}
            >
              {u.id !== me.id && (
                <>
                  <button className="btn ghost sm" onClick={() => patch(u.id, { isAdmin: !u.is_admin })}>{u.is_admin ? '取消管理员' : '设为管理员'}</button>
                  <button className="btn ghost sm" onClick={() => patch(u.id, { disabled: !u.disabled })}>{u.disabled ? '启用' : '停用'}</button>
                  <button className="btn ghost sm" onClick={() => reset(u)}>重置密码</button>
                  <button
                    className="icon-btn"
                    title="删除用户"
                    onClick={() => confirm(`删除 ${u.email}？他的邮箱配置、计划和缓存都会被删除（服务器上的邮件不受影响），无法恢复。`) && api(`/admin/users/${u.id}`, { method: 'DELETE' }).then(() => users.refetch()).catch(toastError)}
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </Setting>
          ))}
        </div>
      </Section>
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
  status: { platform: string; label: string; enabled: boolean; name: string | null }[];
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
  const q = useQuery({ queryKey: ['admin-integrations'], queryFn: () => api<IntegrationsData>('/admin/integrations') });
  const d = q.data;
  if (!d) return <div className="muted">加载中…</div>;
  const status = (p: string) => {
    const s = d.status.find((x) => x.platform === p);
    return !s?.enabled ? '未配置' : s.name ? `✅ 已连接 · ${s.name}` : '已配置，但还没连上（检查凭据或网络，日志里有原因）';
  };
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
            <li>扫码创建后（或手动创建企业自建应用后），到 <a href={v.feishu.appId ? `https://open.${v.feishu.domain === 'lark' ? 'larksuite' : 'feishu'}.cn/app/${v.feishu.appId}` : 'https://open.feishu.cn/app'} target="_blank" rel="noopener noreferrer">开放平台的应用页面 <ExternalLink size={12} /></a>：</li>
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
