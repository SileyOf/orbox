import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, LogOut, Palette, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSaveSettings, useUser } from '../../App';
import { api } from '../../api';
import type { UserSettings } from '../../api';
import { AppearanceDialog } from '../../components/AppearanceDialog';
import { accentName, toastError } from '../../lib';
import { Section, Setting, Switch } from './ui';

// 通用：个人资料、外观、阅读习惯、退出登录。

export function GeneralPage() {
  const user = useUser();
  const qc = useQueryClient();
  const save = useSaveSettings();
  const s = user.settings;
  const set = (patch: Partial<UserSettings>) => save({ settings: patch }).catch(toastError);
  const [name, setName] = useState(user.name);
  const [look, setLook] = useState(false);
  const about = useQuery({ queryKey: ['auth-status'], queryFn: () => api<{ version: string; site: { name: string } }>('/auth/status') });
  const zones = Intl.supportedValuesOf('timeZone');
  const lookSummary = `${{ system: '自动', light: '浅色', dark: '深色' }[s.theme]} · ${s.surface === 'clear' ? '通透' : '实色'} · ${s.followSite ? '跟随站点' : accentName(s.accent)}`;

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    location.href = '/';
  }

  return (
    <>
      <Section id="gen-profile" icon={UserRound} title="个人资料" defaultOpen summary={`${user.name} · ${user.timezone}`}>
        <div className="card">
          <Setting title="昵称" hint="同时作为默认的发件人名称">
            <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== user.name && save({ name }).catch(toastError)} />
          </Setting>
          <Setting title="时区" hint="提醒时间、重复规则和早报都按这个时区计算">
            <select className="select" value={user.timezone} onChange={(e) => save({ timezone: e.target.value }).catch(toastError)}>
              {zones.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </Setting>
          <Setting title="登录邮箱" hint={<>更换邮箱、修改密码、两步验证在 <Link to="/settings/security">安全</Link> 里</>}>
            <span className="muted">{user.email}</span>
          </Setting>
        </div>
      </Section>

      <Section id="gen-look" icon={Palette} title="外观" defaultOpen summary={lookSummary}>
        <div className="card">
          <Setting title="主题与颜色" hint={lookSummary}>
            <button className="btn" onClick={() => setLook(true)}>
              <Palette size={15} /> 外观设置
            </button>
          </Setting>
        </div>
      </Section>

      <Section id="gen-reading" icon={BookOpen} title="阅读" summary={`${s.threads ? '按会话分组' : '逐封显示'} · ${s.blockRemoteImages ? '拦截远程图片' : '显示远程图片'}`}>
        <div className="card">
          <Setting title="按会话分组" hint="同一个话题的往来邮件在列表里折叠成一行">
            <Switch checked={s.threads} onChange={(v) => set({ threads: v })} />
          </Setting>
          <Setting title="拦截远程图片" hint="阻止邮件里的追踪像素得知你已读，可在单封邮件里手动放行">
            <Switch checked={s.blockRemoteImages} onChange={(v) => set({ blockRemoteImages: v })} />
          </Setting>
        </div>
      </Section>

      <div className="row" style={{ padding: '4px 4px 0' }}>
        <span className="muted small grow">
          {about.data?.site.name} {about.data?.version && `v${about.data.version}`}
        </span>
        <button className="btn sm danger" onClick={logout}>
          <LogOut size={14} /> 退出登录
        </button>
      </div>
      {look && <AppearanceDialog onClose={() => setLook(false)} />}
    </>
  );
}
