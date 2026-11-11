import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Database, KeyRound, LoaderCircle, Settings2, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api } from '../api';

// 首次安装向导：安装码 → 数据库 → 站点 → 管理员。数据库已经通过 .env 配置时跳过数据库这一步。

interface SetupStatus {
  version: string;
  needDatabase: boolean;
  /** Docker 里数据目录是否挂载了卷；null 表示不是 Docker */
  persistent: boolean | null;
}

interface Defaults {
  host: string;
  port: number;
  user: string;
  database: string;
  publicUrl: string;
  name: string;
}

interface DbReport {
  version: string;
  created: boolean;
  users: number;
  needSecret: boolean;
}

type Step = 'code' | 'database' | 'site' | 'admin' | 'installing';

const STEP_META: Record<Exclude<Step, 'installing'>, { label: string; icon: typeof Database }> = {
  code: { label: '安装码', icon: KeyRound },
  database: { label: '数据库', icon: Database },
  site: { label: '站点', icon: Settings2 },
  admin: { label: '管理员', icon: UserRound },
};

export function Setup() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api<SetupStatus>('/setup/status'), staleTime: Infinity, retry: 1 });
  const s = status.data;
  const steps = (s?.needDatabase ? ['code', 'database', 'site', 'admin'] : ['code', 'site', 'admin']) as Exclude<Step, 'installing'>[];

  const [step, setStep] = useState<Step>('code');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [db, setDb] = useState({ host: '', port: '3306', user: '', password: '', database: 'orbox' });
  const [secret, setSecret] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [report, setReport] = useState<DbReport | null>(null);
  const [persistOk, setPersistOk] = useState(false);
  const [site, setSite] = useState({
    name: 'Orbox',
    publicUrl: location.origin,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    registration: 'closed' as 'open' | 'invite' | 'closed',
  });
  const [admin, setAdmin] = useState({ name: '', email: '', password: '', confirm: '' });

  /** 访问地址来自环境变量时不能在这里改 */
  const [envUrl, setEnvUrl] = useState('');

  const idx = steps.indexOf(step as Exclude<Step, 'installing'>);
  const go = (to: Step) => (setError(''), setStep(to));
  const back = () => idx > 0 && go(steps[idx - 1]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dbBody = () => ({ ...db, port: Number(db.port) || 3306 });

  /** 提交全部配置，然后等正式服务接管（安装服务关闭、应用启动需要几秒） */
  async function finish(withAccount: boolean) {
    setStep('installing');
    setError('');
    try {
      await api('/setup/finish', {
        body: {
          code,
          ...(s?.needDatabase ? { database: dbBody(), appSecret: secret || undefined } : {}),
          ...(withAccount ? { site, admin: { name: admin.name, email: admin.email, password: admin.password } } : {}),
        },
      });
    } catch (e) {
      setError((e as Error).message);
      setStep(withAccount ? 'admin' : 'database');
      return;
    }
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await fetch('/api/auth/status', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (st && !st.setup) {
        qc.clear();
        location.replace('/');
        return;
      }
    }
    setError('应用启动比预期慢。请稍后手动刷新页面；如果一直打不开，查看服务器日志（docker compose logs）。');
  }

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { defaults: d } = await api<{ defaults: Defaults }>('/setup/code', { body: { code } });
      setDb((v) => ({ ...v, host: d.host, port: String(d.port || 3306), user: d.user, database: d.database || 'orbox' }));
      setSite((v) => ({ ...v, name: d.name || v.name, publicUrl: d.publicUrl || v.publicUrl }));
      setEnvUrl(d.publicUrl);
      go(steps[1]);
    });
  };

  const submitDb = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<DbReport>('/setup/database', { body: { code, database: dbBody() } });
      setReport(r);
      if (r.needSecret) {
        // 库里已有数据：需要原来的密钥，核对后直接完成，不再创建管理员
        if (!secret) {
          setAdvanced(true);
          throw new Error(`这个数据库里已有 Orbox 的数据（${r.users} 个用户）。请在下面填写原来部署时的 APP_SECRET，然后再点一次继续。`);
        }
        await finish(false);
        return;
      }
      go('site');
    });
  };

  const submitSite = (e: FormEvent) => {
    e.preventDefault();
    go('admin');
  };

  const submitAdmin = (e: FormEvent) => {
    e.preventDefault();
    if (admin.password !== admin.confirm) return setError('两次输入的密码不一样');
    void finish(true);
  };

  if (status.isLoading) return <div className="empty" style={{ height: '100dvh' }}>正在加载…</div>;
  if (!s)
    return (
      <div className="empty" style={{ height: '100dvh' }}>
        无法连接服务器
        <button className="btn" onClick={() => status.refetch()}>
          重试
        </button>
      </div>
    );

  const zones = Intl.supportedValuesOf('timeZone');
  const needPersistConfirm = s.needDatabase && s.persistent === false;

  return (
    <div className="auth">
      <div className="card auth-card setup-card">
        <div className="auth-brand">
          <img src="/logo.svg" alt="" />
          <div>
            <b>安装 Orbox</b>
            <span className="muted small">v{s.version} · 只需要几步</span>
          </div>
        </div>

        {step !== 'installing' && (
          <ol className="setup-steps">
            {steps.map((k, i) => {
              const Icon = STEP_META[k].icon;
              return (
                <li key={k} className={i < idx ? 'done' : i === idx ? 'on' : ''}>
                  <i>{i < idx ? <Check size={13} strokeWidth={3} /> : <Icon size={13} />}</i>
                  {STEP_META[k].label}
                </li>
              );
            })}
          </ol>
        )}

        {step === 'code' && (
          <form className="setup-form" onSubmit={submitCode}>
            <p className="muted small">
              为了确认是你本人在安装，请输入<b>安装码</b>。它在服务器的启动日志里，在放 docker-compose 文件的目录执行下面的命令就能看到：
            </p>
            <pre className="setup-cmd">docker compose logs | grep 安装码</pre>
            <Field label="安装码">
              <input className="input setup-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" autoFocus required autoComplete="off" spellCheck={false} />
            </Field>
            <Foot error={error}>
              <button className="btn primary" disabled={busy}>
                继续
              </button>
            </Foot>
          </form>
        )}

        {step === 'database' && (
          <form className="setup-form" onSubmit={submitDb}>
            <p className="muted small">
              Orbox 把账号、计划和邮件缓存存在 <b>MySQL 8</b> 里（不支持 MariaDB）。填一个已有的库，或者填一个有建库权限的账号，库不存在时会自动创建。
            </p>
            <div className="setup-grid">
              <Field label="数据库地址" hint="和 Orbox 在同一台机器时填 host.docker.internal">
                <input className="input" required value={db.host} onChange={(e) => setDb({ ...db, host: e.target.value })} placeholder="host.docker.internal" autoFocus />
              </Field>
              <Field label="端口">
                <input className="input" inputMode="numeric" value={db.port} onChange={(e) => setDb({ ...db, port: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label="用户名">
                <input className="input" required value={db.user} onChange={(e) => setDb({ ...db, user: e.target.value })} placeholder="orbox" autoComplete="off" />
              </Field>
              <Field label="密码">
                <input className="input" type="password" value={db.password} onChange={(e) => setDb({ ...db, password: e.target.value })} autoComplete="new-password" />
              </Field>
              <Field label="库名">
                <input className="input" required pattern="[A-Za-z0-9_]{1,64}" value={db.database} onChange={(e) => setDb({ ...db, database: e.target.value })} />
              </Field>
            </div>
            {report && !report.needSecret && (
              <div className="setup-note ok">
                <Check size={14} /> 已连接 MySQL {report.version}
                {report.created ? `，并创建了数据库 ${db.database}` : ''}
              </div>
            )}
            <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setAdvanced(!advanced)}>
              {advanced ? '收起高级选项' : '高级选项（迁移已有数据）'}
            </button>
            {advanced && (
              <Field label="APP_SECRET" hint="用来加密邮箱密码等敏感数据。全新安装请留空，会自动生成；连接到已有 Orbox 数据的库时，必须填原来的那个">
                <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
              </Field>
            )}
            {needPersistConfirm && (
              <label className="setup-note warn">
                <input type="checkbox" checked={persistOk} onChange={(e) => setPersistOk(e.target.checked)} />
                <span>
                  没有检测到 <code>/app/data</code> 的数据卷。这里保存的配置和密钥在容器重建后会丢失，<b>已保存的邮箱密码将无法解密</b>。请在 docker-compose 里给
                  <code>/app/data</code> 挂载卷后重新启动；如果确认已经做了持久化，勾选这里继续。
                </span>
              </label>
            )}
            <Foot error={error} onBack={back}>
              <button className="btn primary" disabled={busy || (needPersistConfirm && !persistOk)}>
                {busy ? '正在连接…' : '测试连接并继续'}
              </button>
            </Foot>
          </form>
        )}

        {step === 'site' && (
          <form className="setup-form" onSubmit={submitSite}>
            <Field label="站点名称" hint="显示在登录页、浏览器标签和通知里，之后可以在后台改，也可以换 Logo">
              <input className="input" required maxLength={40} value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} autoFocus />
            </Field>
            <Field
              label="访问地址"
              hint={envUrl ? '来自环境变量 PUBLIC_URL' : '别人（和机器人里的链接）访问 Orbox 用的地址。建议用 https 的域名；之后可以在后台改'}
            >
              <input className="input" required value={site.publicUrl} disabled={!!envUrl} onChange={(e) => setSite({ ...site, publicUrl: e.target.value })} placeholder="https://box.example.com" />
            </Field>
            {!envUrl && site.publicUrl.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(site.publicUrl) && (
              <div className="setup-note warn">
                <span>当前是 http 地址：密码会明文传输，"浏览器打开原文"等链接也不可用。建议先配好 HTTPS 反向代理再用域名访问。</span>
              </div>
            )}
            <div className="setup-grid">
              <Field label="默认时区" hint="提醒时间和早报按它计算">
                <select className="select" value={site.timezone} onChange={(e) => setSite({ ...site, timezone: e.target.value })}>
                  {zones.map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </Field>
              <Field label="允许别人注册" hint="之后可以在后台随时修改">
                <select className="select" value={site.registration} onChange={(e) => setSite({ ...site, registration: e.target.value as typeof site.registration })}>
                  <option value="closed">不允许（只有我自己用）</option>
                  <option value="invite">凭邀请码注册</option>
                  <option value="open">开放注册</option>
                </select>
              </Field>
            </div>
            <Foot error={error} onBack={back}>
              <button className="btn primary">继续</button>
            </Foot>
          </form>
        )}

        {step === 'admin' && (
          <form className="setup-form" onSubmit={submitAdmin}>
            <p className="muted small">创建管理员账号，用它登录 Orbox。邮箱只是登录名，不需要真实存在；收发邮件的邮箱在登录后添加。</p>
            <div className="setup-grid">
              <Field label="登录邮箱">
                <input className="input" type="email" required value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} autoComplete="username" autoFocus />
              </Field>
              <Field label="昵称（可选）">
                <input className="input" maxLength={100} value={admin.name} onChange={(e) => setAdmin({ ...admin, name: e.target.value })} autoComplete="nickname" />
              </Field>
              <Field label="密码（至少 8 位）">
                <input className="input" type="password" required minLength={8} value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} autoComplete="new-password" />
              </Field>
              <Field label="再输一次密码">
                <input className="input" type="password" required minLength={8} value={admin.confirm} onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })} autoComplete="new-password" />
              </Field>
            </div>
            <Foot error={error} onBack={back}>
              <button className="btn primary">完成安装</button>
            </Foot>
          </form>
        )}

        {step === 'installing' && (
          <div className="setup-form" style={{ justifyItems: 'center', textAlign: 'center', padding: '18px 0' }}>
            {error ? (
              <div style={{ color: 'var(--danger)' }}>{error}</div>
            ) : (
              <>
                <LoaderCircle size={30} className="spin muted" />
                <b>正在安装…</b>
                <span className="muted small">正在创建数据表并启动服务，通常需要 10–30 秒，完成后会自动进入。</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="setup-hint">{hint}</span>}
    </label>
  );
}

function Foot({ error, onBack, children }: { error: string; onBack?: () => void; children: ReactNode }) {
  return (
    <>
      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
      <div className="row">
        {onBack && (
          <button type="button" className="btn ghost" onClick={onBack}>
            <ArrowLeft size={15} /> 上一步
          </button>
        )}
        <span className="grow" />
        {children}
      </div>
    </>
  );
}
