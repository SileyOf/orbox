import { useSaveSettings, useUser } from '../../App';
import type { UserSettings } from '../../api';
import { ACCENTS, toastError } from '../../lib';
import { Section, Setting, Switch } from './ui';

export function AppearancePage() {
  const user = useUser();
  const save = useSaveSettings();
  const s = user.settings;
  const set = (patch: Partial<UserSettings>) => save({ settings: patch }).catch(toastError);
  return (
    <Section title="外观">
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
        <Setting title="按会话分组" hint="同一个话题的往来邮件在列表里折叠成一行">
          <Switch checked={s.threads} onChange={(v) => set({ threads: v })} />
        </Setting>
        <Setting title="拦截远程图片" hint="阻止邮件里的追踪像素得知你已读，可在单封邮件里手动放行">
          <Switch checked={s.blockRemoteImages} onChange={(v) => set({ blockRemoteImages: v })} />
        </Setting>
      </div>
    </Section>
  );
}
