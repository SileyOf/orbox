import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Laptop, Lock, Mail, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useSaveSettings, useUser } from '../../App';
import { api } from '../../api';
import type { User } from '../../api';
import { copyText, toast, toastError } from '../../lib';
import { PasswordDialog, Section, Setting, Switch } from './ui';

// 账号安全：登录邮箱（验证 / 更换）、两步验证（动态码 App、邮箱验证码、恢复码）、登录密码、登录的设备。

interface SecurityInfo {
  email: string;
  emailVerified: boolean;
  /** 系统能不能发邮件（管理员在后台配置） */
  mailer: boolean;
  totp: boolean;
  emailOtp: boolean;
  recoveryLeft: number;
}

/** 等待输入密码后执行的操作 */
type Ask = { title: string; hint?: string; confirm?: string; run: (password: string) => Promise<unknown> } | null;

export function SecurityPage() {
  const user = useUser();
  const qc = useQueryClient();
  const sec = useQuery({ queryKey: ['security'], queryFn: () => api<SecurityInfo>('/me/security') });
  const s = sec.data;
  const [ask, setAsk] = useState<Ask>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const [emailDialog, setEmailDialog] = useState<'verify' | 'change' | null>(null);

  const refresh = async () => {
    await sec.refetch();
    qc.setQueryData(['me'], await api<User>('/me'));
  };
  const twoFactor = !!(s?.totp || s?.emailOtp);

  const noMailer = '需要管理员先在后台配置系统发信';

  return (
    <>
      <Section
        id="sec-email"
        icon={Mail}
        title="登录邮箱"
        defaultOpen
        summary={s ? `${s.email} · ${s.emailVerified ? '已验证' : '未验证'}` : ''}
        hint="用来登录、找回密码和接收登录验证码。它不需要是你在 Orbox 里收发邮件的邮箱。"
      >
        <div className="card">
          <Setting
            title={
              <>
                {s?.email ?? user.email}{' '}
                {s && <span className={`chip${s.emailVerified ? ' accent' : ''}`} style={{ height: 20 }}>{s.emailVerified ? '已验证' : '未验证'}</span>}
              </>
            }
            hint={s?.emailVerified ? '验证过的邮箱可以用来找回密码、接收登录验证码' : s?.mailer ? '验证后才能用邮件找回密码和接收登录验证码' : `${noMailer}，之后才能验证邮箱`}
          >
            {s && !s.emailVerified && (
              <button className="btn sm accent" disabled={!s.mailer} onClick={() => setEmailDialog('verify')}>
                验证
              </button>
            )}
            <button className="btn sm" disabled={!s?.mailer} title={s?.mailer ? '' : noMailer} onClick={() => setEmailDialog('change')}>
              更换
            </button>
          </Setting>
        </div>
      </Section>

      <Section
        id="sec-2fa"
        icon={ShieldCheck}
        title="两步验证"
        defaultOpen
        summary={s ? (twoFactor ? `已开启 · ${[s.totp && '动态码', s.emailOtp && '邮箱验证码'].filter(Boolean).join('、')}` : '未开启') : ''}
        hint="开启后，登录时除了密码还要再输入一个验证码。即使密码泄露，别人也登录不了。"
      >
        <div className="card">
          <Setting
            title={<><Smartphone size={14} style={{ verticalAlign: -2 }} /> 动态码 App</>}
            hint="用 Google Authenticator、Microsoft Authenticator、1Password 等 App 生成 6 位动态码，不依赖网络和邮件，最可靠"
          >
            {s?.totp ? (
              <button
                className="btn sm"
                onClick={() =>
                  setAsk({
                    title: '关闭动态码',
                    hint: '关闭后登录不再需要动态码。',
                    confirm: '关闭',
                    run: (password) => api('/me/2fa/totp/disable', { body: { password } }).then(() => (toast('动态码已关闭'), refresh())),
                  })
                }
              >
                关闭
              </button>
            ) : (
              <button
                className="btn sm accent"
                onClick={() =>
                  setAsk({
                    title: '开启动态码',
                    confirm: '下一步',
                    run: (password) => api<{ secret: string; uri: string }>('/me/2fa/totp/setup', { body: { password } }).then(setTotp),
                  })
                }
              >
                开启
              </button>
            )}
          </Setting>
          <Setting
            title={<><Mail size={14} style={{ verticalAlign: -2 }} /> 邮箱验证码</>}
            hint={
              !s?.mailer ? noMailer : !s.emailVerified ? '请先验证上面的登录邮箱' : `登录时把 6 位验证码发到 ${s.email}`
            }
          >
            <Switch
              checked={!!s?.emailOtp}
              disabled={!s || (!s.emailOtp && (!s.mailer || !s.emailVerified))}
              onChange={(enabled) =>
                setAsk({
                  title: enabled ? '开启邮箱验证码' : '关闭邮箱验证码',
                  confirm: enabled ? '开启' : '关闭',
                  run: (password) =>
                    api<{ recoveryCodes: string[] | null }>('/me/2fa/email', { body: { enabled, password } }).then((r) => {
                      if (r.recoveryCodes) setCodes(r.recoveryCodes);
                      toast(enabled ? '邮箱验证码已开启' : '邮箱验证码已关闭');
                      return refresh();
                    }),
                })
              }
            />
          </Setting>
          {twoFactor && (
            <Setting
              title={<><KeyRound size={14} style={{ verticalAlign: -2 }} /> 恢复码</>}
              hint={`手机丢了、收不到邮件时用来登录，每个只能用一次。还剩 ${s?.recoveryLeft ?? 0} 个`}
            >
              <button
                className="btn sm"
                onClick={() =>
                  setAsk({
                    title: '重新生成恢复码',
                    hint: '旧的恢复码会全部作废。',
                    confirm: '生成',
                    run: (password) => api<{ recoveryCodes: string[] }>('/me/2fa/recovery', { body: { password } }).then((r) => (setCodes(r.recoveryCodes), refresh())),
                  })
                }
              >
                <RefreshCw size={14} /> 重新生成
              </button>
            </Setting>
          )}
        </div>
      </Section>

      <Section id="sec-password" icon={Lock} title="登录密码" summary="修改后其他设备会自动下线">
        <PasswordForm />
      </Section>

      <Sessions />

      {ask && (
        <PasswordDialog
          title={ask.title}
          hint={ask.hint}
          confirm={ask.confirm}
          onClose={() => setAsk(null)}
          onSubmit={(password) => ask.run(password).then(() => setAsk(null))}
        />
      )}
      {totp && (
        <TotpDialog
          setup={totp}
          onClose={() => setTotp(null)}
          onDone={(recovery) => {
            setTotp(null);
            if (recovery) setCodes(recovery);
            toast('动态码已开启');
            void refresh();
          }}
        />
      )}
      {codes && <RecoveryDialog codes={codes} onClose={() => setCodes(null)} />}
      {emailDialog && s && <EmailDialog mode={emailDialog} current={s.email} onClose={() => setEmailDialog(null)} onDone={() => (setEmailDialog(null), void refresh())} />}
    </>
  );
}

function PasswordForm() {
  const save = useSaveSettings();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) return toast('两次输入的新密码不一样', { kind: 'error' });
    try {
      await save({ password: { current: pw.current, next: pw.next } });
      setPw({ current: '', next: '', confirm: '' });
      toast('密码已修改，其他设备已下线');
    } catch (err) {
      toastError(err);
    }
  }
  return (
    <form className="grid2" onSubmit={submit} style={{ alignItems: 'end' }}>
      <label className="field" style={{ gridColumn: '1 / -1' }}>
        <span>当前密码</span>
        <input className="input" type="password" required autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
      </label>
      <label className="field">
        <span>新密码（至少 8 位）</span>
        <input className="input" type="password" required minLength={8} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
      </label>
      <label className="field">
        <span>再输一次新密码</span>
        <input className="input" type="password" required minLength={8} autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
      </label>
      <div style={{ gridColumn: '1 / -1' }}>
        <button className="btn primary">修改密码</button>
      </div>
    </form>
  );
}

const device = (ua: string) => {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || '未知设备';
};

function Sessions() {
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ userAgent: string; createdAt: string; current: boolean }[]>('/me/sessions') });
  const list = q.data || [];
  const others = list.filter((x) => !x.current).length;
  return (
    <Section
      id="sec-sessions"
      icon={Laptop}
      title="登录的设备"
      summary={list.length ? `${list.length} 个设备` : ''}
      action={
        <button
          className="btn sm"
          disabled={!others}
          onClick={() =>
            api<{ count: number }>('/me/logout-others', { method: 'POST' })
              .then((r) => (toast(`已退出 ${r.count} 个设备`), q.refetch()))
              .catch(toastError)
          }
        >
          退出其他设备
        </button>
      }
    >
      <div className="card">
        {list.map((x, i) => (
          <Setting key={i} title={<>{device(x.userAgent)} {x.current && <span className="chip accent" style={{ height: 20 }}>当前</span>}</>} hint={`登录于 ${new Date(x.createdAt).toLocaleString()}`} />
        ))}
      </div>
    </Section>
  );
}

function TotpDialog({ setup, onClose, onDone }: { setup: { secret: string; uri: string }; onClose: () => void; onDone: (recovery: string[] | null) => void }) {
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    QRCode.toDataURL(setup.uri, { margin: 0, width: 360 }).then(setQr).catch(() => {});
  }, [setup.uri]);
  return (
    <div className="backdrop">
      <form
        className="dialog"
        style={{ width: 'min(420px, 100%)' }}
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          api<{ recoveryCodes: string[] | null }>('/me/2fa/totp/enable', { body: { code } })
            .then((r) => onDone(r.recoveryCodes))
            .catch((err) => setError(err.message));
        }}
      >
        <h2>开启动态码</h2>
        <div className="muted small">1. 用验证器 App 扫描二维码（或手动输入下面的密钥）。 2. 输入 App 里显示的 6 位数确认。</div>
        <div className="totp-qr">
          {qr && <img src={qr} alt="动态码二维码" />}
          <div className="totp-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</div>
          <button type="button" className="btn ghost sm" onClick={() => copyText(setup.secret, '密钥已复制')}>
            <Copy size={14} /> 复制密钥
          </button>
        </div>
        <label className="field">
          <span>App 里的 6 位动态码</span>
          <input className="input auth-code" required autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位动态码" />
        </label>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary">确认开启</button>
        </div>
      </form>
    </div>
  );
}

function RecoveryDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const text = codes.join('\n');
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Orbox 恢复码（每个只能用一次）\n\n${text}\n`], { type: 'text/plain' }));
    a.download = 'orbox-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="backdrop">
      <div className="dialog" style={{ width: 'min(420px, 100%)' }}>
        <h2>保存恢复码</h2>
        <div className="banner warn">恢复码只显示这一次。手机丢了或收不到邮件时，可以用它代替验证码登录，每个只能用一次。请存到密码管理器或打印出来。</div>
        <div className="recovery-codes">
          {codes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={() => copyText(text, '已复制')}>
            <Copy size={14} /> 复制
          </button>
          <button className="btn" onClick={download}>
            下载
          </button>
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>
            我已保存
          </button>
        </div>
      </div>
    </div>
  );
}

/** 验证当前邮箱，或者更换登录邮箱（要先输密码，再输入发到新邮箱的验证码） */
function EmailDialog({ mode, current, onClose, onDone }: { mode: 'verify' | 'change'; current: string; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState(mode === 'verify' ? current : '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const send = () => {
    setBusy(true);
    setError('');
    return api('/me/email/code', { body: mode === 'change' ? { email, password } : {} })
      .then(() => setSent(true))
      .catch((e) => (e.status === 429 ? setSent(true) : setError(e.message)))
      .finally(() => setBusy(false));
  };
  // 验证当前邮箱：打开就直接发
  useEffect(() => {
    if (mode === 'verify') void send();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!sent) return void send();
    setBusy(true);
    setError('');
    api('/me/email/confirm', { body: { email, code } })
      .then(() => (toast(mode === 'change' ? '登录邮箱已更换' : '邮箱已验证'), onDone()))
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" style={{ width: 'min(420px, 100%)' }} onSubmit={submit}>
        <h2>{mode === 'change' ? '更换登录邮箱' : '验证邮箱'}</h2>
        {mode === 'change' && !sent && (
          <>
            <label className="field">
              <span>新的登录邮箱</span>
              <input className="input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>当前登录密码</span>
              <input className="input" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        )}
        {sent && (
          <>
            <div className="muted small">
              验证码已发送到 <b>{email}</b>，15 分钟内有效。没收到的话看看垃圾邮件箱。
            </div>
            <label className="field">
              <span>验证码</span>
              <input className="input auth-code" required autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位验证码" />
            </label>
          </>
        )}
        {!sent && mode === 'verify' && !error && <div className="muted small">正在发送验证码…</div>}
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || (!sent && mode === 'verify')}>
            {sent ? '确认' : '发送验证码'}
          </button>
        </div>
      </form>
    </div>
  );
}
