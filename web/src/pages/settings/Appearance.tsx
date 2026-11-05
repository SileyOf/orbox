import { useSaveSettings, useUser } from '../../App';
import type { UserSettings } from '../../api';
import { Palette } from 'lucide-react';
import { useState } from 'react';
import { AppearanceDialog } from '../../components/AppearanceDialog';
import { accentName, toastError } from '../../lib';
import { Section, Setting, Switch } from './ui';

export function AppearancePage() {
  const user = useUser();
  const save = useSaveSettings();
  const s = user.settings;
  const set = (patch: Partial<UserSettings>) => save({ settings: patch }).catch(toastError);
  const [look, setLook] = useState(false);
  return (
    <Section title="外观">
      <div className="card">
        <Setting title="主题与颜色" hint={`${{ system: '自动', light: '浅色', dark: '深色' }[s.theme]} · ${s.surface === 'clear' ? '通透' : '实色'} · ${s.followSite ? '跟随站点' : accentName(s.accent)}`}>
          <button className="btn" onClick={() => setLook(true)}>
            <Palette size={15} /> 外观设置
          </button>
        </Setting>
        <Setting title="按会话分组" hint="同一个话题的往来邮件在列表里折叠成一行">
          <Switch checked={s.threads} onChange={(v) => set({ threads: v })} />
        </Setting>
        <Setting title="拦截远程图片" hint="阻止邮件里的追踪像素得知你已读，可在单封邮件里手动放行">
          <Switch checked={s.blockRemoteImages} onChange={(v) => set({ blockRemoteImages: v })} />
        </Setting>
      </div>
      {look && <AppearanceDialog onClose={() => setLook(false)} />}
    </Section>
  );
}
