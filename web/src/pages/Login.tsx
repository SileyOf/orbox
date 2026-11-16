import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Mail, ShieldCheck, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, api } from '../api';
import type { SiteInfo, User } from '../api';
import { useSite } from '../App';
import { applyAppearance, toast } from '../lib';

type Method = 'totp' | 'email' | 'recovery';
interface Challenge {
  ticket: string;
  methods: Method[];
  emailHint: string;
}
/** 登录页的几种状态：登录 / 注册 / 两步验证 / 验证注册邮箱 / 找回密码（填邮箱）/ 重置密码（填验证码和新密码） */
type Mode = 'login' | 'register' | 'twofactor' | 'verify' | 'forgot' | 'reset';

const METHOD_META: Record<Method, { label: string; icon: typeof Mail; hint: string; placeholder: string }> = {
  totp: { label: '动态码', icon: Smartphone, hint: '输入验证器 App 里当前显示的 6 位数', placeholder: '6 位动态码' },
  email: { label: '邮箱验证码', icon: Mail, hint: '', placeholder: '邮件里的 6 位验证码' },
  recovery: { label: '恢复码', icon: KeyRound, hint: '输入开启两步验证时保存的恢复码，每个只能用一次', placeholder: 'xxxxx-xxxxx' },
};

export function Login() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['auth-status'],
    queryFn: () => api<{ allowRegistration: boolean; inviteRequired: boolean; mail: boolean; site: SiteInfo }>('/auth/status'),
  });
  const site = useSite();
  // 第一次来的访客用站点设置的默认主题和强调色
  useEffect(() => {
    if (!site) return;
    let stored = false;
    try {
      stored = !!localStorage.getItem('orbox.accent');
    } catch {}
    if (!stored) applyAppearance({ theme: site.theme, accent: site.accent });
  }, [site?.accent, site?.theme]);

  const [mode, setMode] = useState<Mode>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', invite: '', code: '', newPassword: '' });
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [method, setMethod] = useState<Method>('totp');
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const go = (m: Mode) => (setError(''), setForm((f) => ({ ...f, code: '' })), setMode(m));

  /** 登录成功：新账号用浏览器时区作为初始时区 */
  async function enter(user: User, fresh = false) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    qc.setQueryData(['me'], fresh && tz ? await api<User>('/me', { method: 'PATCH', body: { timezone: tz } }).catch(() => user) : user);
  }

  async function sendLoginEmail(ticket: string) {
    try {
      await api('/auth/2fa/email', { body: { ticket } });
      setEmailSent(true);
    } catch (e) {
      // 60 秒内重复请求也算"已发送"
      if (e instanceof ApiError && e.status === 429) setEmailSent(true);
      else setError((e as Error).message);
    }
  }

  function pickMethod(m: Method, c = challenge) {
    setMethod(m);
    setError('');
    setForm((f) => ({ ...f, code: '' }));
    if (m === 'email' && c && !emailSent) void sendLoginEmail(c.ticket);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') {
        const r = await api<User & { challenge?: Challenge }>('/auth/login', { body: { email: form.email, password: form.password } });
        if (r.challenge) {
          setChallenge(r.challenge);
          setEmailSent(false);
          setMode('twofactor');
          setForm((f) => ({ ...f, code: '' }));
          // 默认用动态码；只开了邮箱验证码的直接发信
          const first = r.challenge.methods.includes('totp') ? 'totp' : r.challenge.methods[0];
          setMethod(first);
          if (first === 'email') void sendLoginEmail(r.challenge.ticket);
        } else await enter(r);
      } else if (mode === 'register') {
        const r = await api<User & { verify?: boolean }>('/auth/register', { body: { name: form.name, email: form.email, password: form.password, invite: form.invite } });
        if (r.verify) go('verify');
        else await enter(r, true);
      } else if (mode === 'twofactor') {
        await enter(await api<User>('/auth/2fa', { body: { ticket: challenge!.ticket, method, code: form.code } }));
      } else if (mode === 'verify') {
        await enter(await api<User>('/auth/verify', { body: { email: form.email, code: form.code } }), true);
      } else if (mode === 'forgot') {
        await api('/auth/forgot', { body: { email: form.email } });
        go('reset');
      } else {
        await api('/auth/reset', { body: { email: form.email, code: form.code, password: form.newPassword } });
        toast('密码已重置，请用新密码登录');
        setForm((f) => ({ ...f, password: '', newPassword: '', code: '' }));
        go('login');
      }
    } catch (err) {
      // 注册了但还没验证邮箱：服务端已经重发验证码，直接去输入
      if (err instanceof ApiError && err.data.verify) go('verify');
      // 登录超时（票据过期）回到输密码那一步
      else if (mode === 'twofactor' && err instanceof ApiError && (err.status === 429 || /超时/.test(err.message))) {
        go('login');
        setError(err.message);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const resend = () =>
    api('/auth/verify/resend', { body: { email: form.email } })
      .then(() => toast('验证码已重新发送'))
      .catch((e) => setError(e.message));

  const title: Record<Mode, string | null> = { login: null, register: null, twofactor: '两步验证', verify: '验证邮箱', forgot: '找回密码', reset: '重置密码' };
  const submitLabel: Record<Mode, string> = { login: '登录', register: '创建账号', twofactor: '验证并登录', verify: '完成注册', forgot: '发送验证码', reset: '重置密码' };
  const meta = METHOD_META[method];

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <img src={site?.hasLogo ? '/api/site/logo' : '/logo.svg'} alt="" />
          <div>
            <b>{site?.name ?? ''}</b>
            <span className="muted small">{title[mode] ?? site?.subtitle}</span>
          </div>
        </div>
        {mode === 'login' && site?.loginText && <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{site.loginText}</div>}

        {mode === 'register' && (
          <Field label="昵称">
            <input className="input" value={form.name} onChange={set('name')} autoComplete="nickname" />
          </Field>
        )}
        {(mode === 'login' || mode === 'register' || mode === 'forgot') && (
          <Field label="邮箱">
            <input className="input" type="email" required value={form.email} onChange={set('email')} autoComplete="username" autoFocus />
          </Field>
        )}
        {(mode === 'login' || mode === 'register') && (
          <Field label="密码">
            <input
              className="input"
              type="password"
              required
              minLength={mode === 'register' ? 8 : undefined}
              value={form.password}
              onChange={set('password')}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </Field>
        )}
        {mode === 'register' && status.data?.inviteRequired && (
          <Field label="邀请码">
            <input className="input" required value={form.invite} onChange={set('invite')} autoComplete="off" style={{ textTransform: 'uppercase' }} />
          </Field>
        )}

        {mode === 'twofactor' && challenge && (
          <>
            {challenge.methods.length > 1 && (
              <div className="tabs auth-methods">
                {challenge.methods.map((m) => {
                  const Icon = METHOD_META[m].icon;
                  return (
                    <button type="button" key={m} className={method === m ? 'active' : ''} onClick={() => pickMethod(m)}>
                      <Icon size={14} /> {METHOD_META[m].label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="muted small">
              {method === 'email' ? (emailSent ? `验证码已发送到 ${challenge.emailHint}，15 分钟内有效` : '正在发送验证码…') : meta.hint}
            </div>
            <Field label={meta.label}>
              <input
                key={method}
                className="input auth-code"
                required
                value={form.code}
                onChange={set('code')}
                placeholder={meta.placeholder}
                inputMode={method === 'recovery' ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                autoFocus
              />
            </Field>
          </>
        )}

        {mode === 'verify' && (
          <>
            <div className="muted small">
              验证码已发送到 <b>{form.email}</b>，15 分钟内有效。没收到的话看看垃圾邮件箱，或者
              <button type="button" className="link-btn" onClick={resend}>
                重新发送
              </button>
              。
            </div>
            <Field label="验证码">
              <input className="input auth-code" required value={form.code} onChange={set('code')} placeholder="6 位验证码" inputMode="numeric" autoComplete="one-time-code" autoFocus />
            </Field>
          </>
        )}

        {mode === 'forgot' && <div className="muted small">填写登录邮箱，我们会把重置密码用的验证码发到这个邮箱。</div>}
        {mode === 'reset' && (
          <>
            <div className="muted small">
              如果 <b>{form.email}</b> 是已注册的邮箱，验证码已经发过去了（15 分钟内有效）。
            </div>
            <Field label="验证码">
              <input className="input auth-code" required value={form.code} onChange={set('code')} placeholder="6 位验证码" inputMode="numeric" autoComplete="one-time-code" autoFocus />
            </Field>
            <Field label="新密码（至少 8 位）">
              <input className="input" type="password" required minLength={8} value={form.newPassword} onChange={set('newPassword')} autoComplete="new-password" />
            </Field>
          </>
        )}

        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {mode === 'twofactor' && <ShieldCheck size={15} />}
          {submitLabel[mode]}
        </button>

        {mode === 'login' && (
          <div className="auth-links">
            {status.data?.allowRegistration && (
              <button type="button" className="link-btn" onClick={() => go('register')}>
                注册账号
              </button>
            )}
            <span className="grow" />
            <button
              type="button"
              className="link-btn"
              onClick={() => (status.data?.mail ? go('forgot') : setError('这个站点没有开启邮件找回。请联系管理员在后台为你重置密码。'))}
            >
              忘记密码？
            </button>
          </div>
        )}
        {mode !== 'login' && (
          <button type="button" className="btn ghost block" onClick={() => go('login')}>
            <ArrowLeft size={15} /> 返回登录
          </button>
        )}
      </form>
      {site?.footer && <div className="muted small auth-footer">{site.footer}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
