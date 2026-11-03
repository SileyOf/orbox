import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import type { SiteInfo, User } from '../api';
import { useSite } from '../App';
import { applyAppearance } from '../lib';

export function Login() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api<{ allowRegistration: boolean; inviteRequired: boolean; site: SiteInfo }>('/auth/status') });
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
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', invite: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await api<User>(`/auth/${mode}`, { body: form });
      // 新账号用浏览器时区作为初始时区，提醒和早报按它计算
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      qc.setQueryData(['me'], mode === 'register' && tz ? await api<User>('/me', { method: 'PATCH', body: { timezone: tz } }) : user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <img src={site?.hasLogo ? '/api/site/logo' : '/logo.svg'} alt="" />
          <div>
            <b>{site?.name ?? ''}</b>
            <span className="muted small">{site?.subtitle}</span>
          </div>
        </div>
        {site?.loginText && <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{site.loginText}</div>}
        {mode === 'register' && (
          <label className="field">
            <span>昵称</span>
            <input className="input" value={form.name} onChange={set('name')} autoComplete="nickname" />
          </label>
        )}
        <label className="field">
          <span>邮箱</span>
          <input className="input" type="email" required value={form.email} onChange={set('email')} autoComplete="username" autoFocus />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            className="input"
            type="password"
            required
            minLength={mode === 'register' ? 8 : undefined}
            value={form.password}
            onChange={set('password')}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          />
        </label>
        {mode === 'register' && status.data?.inviteRequired && (
          <label className="field">
            <span>邀请码</span>
            <input className="input" required value={form.invite} onChange={set('invite')} autoComplete="off" style={{ textTransform: 'uppercase' }} />
          </label>
        )}
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {mode === 'login' ? '登录' : '创建账号'}
        </button>
        {status.data?.allowRegistration && (
          <button type="button" className="btn ghost block" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
          </button>
        )}
      </form>
      {site?.footer && <div className="muted small auth-footer">{site.footer}</div>}
    </div>
  );
}
