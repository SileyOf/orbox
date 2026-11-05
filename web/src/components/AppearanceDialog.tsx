import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSaveSettings, useSite, useUser } from '../App';
import type { UserSettings } from '../api';
import { ACCENT_PRESETS, accentName, applyAppearance, toastError } from '../lib';
import { Switch } from '../pages/settings/ui';

type Look = Pick<UserSettings, 'theme' | 'accent' | 'surface' | 'selection' | 'followSite' | 'motion'>;

const MODES = [
  { v: 'system', label: '自动' },
  { v: 'light', label: '浅色' },
  { v: 'dark', label: '深色' },
] as const;

/**
 * 外观设置（与 Orimg 相同的设计）：点选即时预览，"完成"保存，关闭或按 Esc 放弃改动。
 */
export function AppearanceDialog({ onClose }: { onClose: () => void }) {
  const user = useUser();
  const site = useSite();
  const save = useSaveSettings();
  const s = user.settings;
  const initial: Look = { theme: s.theme, accent: s.accent, surface: s.surface, selection: s.selection, followSite: s.followSite, motion: s.motion };
  const [look, setLook] = useState<Look>(initial);
  const siteAccent = site?.accent || '#cceb79';
  const set = (patch: Partial<Look>) => setLook((l) => ({ ...l, ...patch }));

  // 即时预览
  useEffect(() => applyAppearance(look, siteAccent), [look, siteAccent]);

  const cancel = () => {
    applyAppearance(initial, siteAccent);
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const done = () =>
    save({ settings: look })
      .then(onClose)
      .catch(toastError);
  const reset = () => setLook({ theme: 'system', accent: siteAccent, surface: 'solid', selection: 'accent', followSite: true, motion: true });
  const accent = look.followSite ? siteAccent : look.accent;

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="dialog look" role="dialog" aria-labelledby="lookTitle">
        <header className="row">
          <h2 id="lookTitle" className="grow">外观</h2>
          <button className="icon-btn" onClick={cancel} aria-label="关闭外观设置">
            <X size={18} />
          </button>
        </header>

        <fieldset>
          <legend>显示模式</legend>
          <div className="look-grid three">
            {MODES.map((m) => (
              <label key={m.v} className={`look-choice${look.theme === m.v ? ' on' : ''}`}>
                <input type="radio" name="theme" checked={look.theme === m.v} onChange={() => set({ theme: m.v })} />
                <span className={`look-preview mode-${m.v}`} aria-hidden>
                  <i />
                  <b />
                  <em />
                </span>
                <span>{m.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>面板效果</legend>
          <div className="look-grid two">
            {(['clear', 'solid'] as const).map((v) => (
              <label key={v} className={`look-choice${look.surface === v ? ' on' : ''}`}>
                <input type="radio" name="surface" checked={look.surface === v} onChange={() => set({ surface: v })} />
                <span className={`look-preview surface-${v}`} aria-hidden>
                  <i />
                  <b />
                  <em />
                </span>
                <span>{v === 'clear' ? '通透' : '实色'}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>
            强调色 <span className="muted small">{look.followSite ? `跟随站点 · ${accentName(siteAccent)}` : accentName(accent)}</span>
          </legend>
          <div className="look-swatches">
            {ACCENT_PRESETS.map((a) => (
              <label key={a.hex} className={`look-swatch${accent.toLowerCase() === a.hex ? ' on' : ''}`} title={a.name} style={{ '--swatch': a.hex } as React.CSSProperties}>
                <input type="radio" name="accent" aria-label={a.name} checked={accent.toLowerCase() === a.hex} onChange={() => set({ accent: a.hex, followSite: false })} />
                <span />
              </label>
            ))}
            <label className={`look-swatch custom${ACCENT_PRESETS.some((a) => a.hex === accent.toLowerCase()) ? '' : ' on'}`} title="自定义颜色" style={{ '--swatch': accent } as React.CSSProperties}>
              <input type="color" value={accent} onChange={(e) => set({ accent: e.target.value, followSite: false })} aria-label="自定义颜色" />
              <span />
            </label>
          </div>
        </fieldset>

        <div className="look-rows">
          <div className="look-row">
            <label htmlFor="lookSelection">文本选中颜色</label>
            <select id="lookSelection" className="select" value={look.selection} onChange={(e) => set({ selection: e.target.value })}>
              <option value="accent">跟随强调色</option>
              {ACCENT_PRESETS.map((a) => (
                <option key={a.hex} value={a.hex}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="look-row">
            <span>强调色跟随站点</span>
            <Switch checked={look.followSite} onChange={(v) => set({ followSite: v, accent: v ? look.accent : accent })} />
          </div>
          <div className="look-row">
            <span>界面动效</span>
            <Switch checked={look.motion} onChange={(v) => set({ motion: v })} />
          </div>
        </div>

        <footer className="row">
          <button className="btn" onClick={reset}>
            恢复默认
          </button>
          <span className="grow" />
          <button className="btn primary" onClick={done}>
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}
