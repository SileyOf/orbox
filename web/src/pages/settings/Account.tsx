import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSaveSettings, useUser } from '../../App';
import { api } from '../../api';
import { toast, toastError } from '../../lib';
import { Setting } from './ui';

export function AccountPage() {
  const qc = useQueryClient();
  const about = useQuery({ queryKey: ['auth-status'], queryFn: () => api<{ version: string; site: { name: string } }>('/auth/status') });
  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    location.href = '/';
  }
  return (
    <>
      <Profile onLogout={logout} />
      <div className="muted small" style={{ textAlign: 'center' }}>
        {about.data?.site.name} {about.data?.version && `v${about.data.version}`}
      </div>
    </>
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

