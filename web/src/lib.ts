import { useSyncExternalStore } from 'react';
import type { UserSettings } from './api';

/** 预设强调色（与 Orimg 一致） */
export const ACCENT_PRESETS = [
  { name: '青柠', hex: '#cceb79' },
  { name: '蓝色', hex: '#3985ee' },
  { name: '紫色', hex: '#a16ad3' },
  { name: '粉色', hex: '#e776a3' },
  { name: '红色', hex: '#e55c60' },
  { name: '橙色', hex: '#ee9140' },
  { name: '黄色', hex: '#e9bf36' },
  { name: '绿色', hex: '#66ac73' },
  { name: '石墨', hex: '#949a96' },
];
export const ACCENTS = ACCENT_PRESETS.map((a) => a.hex);
export const accentName = (hex: string) => ACCENT_PRESETS.find((a) => a.hex === hex.toLowerCase())?.name ?? hex.toUpperCase();

/** 强调色上的文字颜色：按相对亮度在深浅之间选一个 */
export function onAccent(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1d2219' : '#ffffff';
}

export type Appearance = Pick<UserSettings, 'theme' | 'accent'> & Partial<Pick<UserSettings, 'surface' | 'selection' | 'followSite' | 'motion'>>;

/** 套用外观。siteAccent 用于"强调色跟随站点" */
export function applyAppearance(s: Appearance, siteAccent?: string) {
  const root = document.documentElement;
  const dark = s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const accent = s.followSite && siteAccent ? siteAccent : s.accent;
  const selection = !s.selection || s.selection === 'accent' ? accent : s.selection;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.surface = s.surface || 'solid';
  root.dataset.motion = s.motion === false ? 'off' : 'on';
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--on-accent', onAccent(accent));
  root.style.setProperty('--selection', selection);
  root.style.setProperty('--on-selection', onAccent(selection));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#171a18' : '#fafbf8');
  try {
    localStorage.setItem('orbox.theme', s.theme);
    localStorage.setItem('orbox.accent', accent);
    localStorage.setItem('orbox.surface', s.surface || 'solid');
    localStorage.setItem('orbox.motion', s.motion === false ? 'off' : 'on');
  } catch {}
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const pad = (n: number) => String(n).padStart(2, '0');
export const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 列表里的紧凑时间：今天显示钟点，一周内显示星期，再早显示日期 */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return hm(d);
  const days = (new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400_000;
  if (days === 1) return '昨天';
  if (days > 0 && days < 7) return WEEK[d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function fullDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]} ${hm(d)}`;
}

/** 任务到期时间的口语化描述 */
export function dueLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date(new Date().toDateString());
  const days = Math.round((new Date(d.toDateString()).getTime() - today.getTime()) / 86400_000);
  const day =
    days === 0 ? '今天' : days === 1 ? '明天' : days === -1 ? '昨天' : days > 1 && days < 7 ? WEEK[d.getDay()] : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${day} ${hm(d)}`;
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** <input type="datetime-local"> 用的本地时间字符串 */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hm(d)}`;
}

// 轻量 toast：模块级 store，任何地方都能直接调用
export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  publish();
}

export function toast(text: string, opts: { kind?: Toast['kind']; action?: Toast['action']; ms?: number } = {}): number {
  const id = Date.now() + Math.random();
  toasts = [...toasts, { id, text, kind: opts.kind || 'info', action: opts.action }];
  publish();
  setTimeout(() => dismissToast(id), opts.ms ?? 4000);
  return id;
}

export async function copyText(text: string, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} ${text}`, { ms: 2000 });
  } catch {
    toast('浏览器不允许访问剪贴板，请手动复制', { kind: 'error' });
  }
}

export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : String(e), { kind: 'error', ms: 6000 });

export const useToasts = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => toasts,
  );

export function useMedia(queryText: string): boolean {
  return useSyncExternalStore(
    (l) => {
      const mq = matchMedia(queryText);
      mq.addEventListener('change', l);
      return () => mq.removeEventListener('change', l);
    },
    () => matchMedia(queryText).matches,
  );
}

// ---------------- 农历（与服务端同一套 Intl 中国农历） ----------------

const LUNAR_MONTHS = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const lunarDayName = (d: number) =>
  d <= 10 ? `初${'一二三四五六七八九十'[d - 1]}` : d < 20 ? `十${'一二三四五六七八九'[d - 11]}` : d === 20 ? '二十' : d < 30 ? `廿${'一二三四五六七八九'[d - 21]}` : '三十';
export const lunarLabel = (l: { month: number; day: number; leap?: boolean }) => `${l.leap ? '闰' : ''}${LUNAR_MONTHS[l.month - 1]}月${lunarDayName(l.day)}`;
export const LUNAR_MONTH_NAMES = LUNAR_MONTHS.map((m) => `${m}月`);
export const LUNAR_DAY_NAMES = Array.from({ length: 30 }, (_, i) => lunarDayName(i + 1));

let lunarFmt: Intl.DateTimeFormat | null = null;
/** 某个日期对应的农历月日 */
export function toLunar(d: Date): { month: number; day: number; leap: boolean } | null {
  try {
    lunarFmt ??= new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric' });
    const parts = lunarFmt.formatToParts(d);
    const m = parts.find((p) => p.type === 'month')!.value;
    return { month: parseInt(m, 10), day: Number(parts.find((p) => p.type === 'day')!.value), leap: /bis/.test(m) };
  } catch {
    return null;
  }
}

/** 金额显示：人民币 ¥，其他币种带代码 */
export const money = (amount: number | string, currency = 'CNY') => {
  const n = Number(amount);
  const v = n.toLocaleString('zh-CN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return currency === 'CNY' ? `¥${v}` : currency === 'USD' ? `$${v}` : `${v} ${currency}`;
};

/** 距离某天还有几天（按本地日期） */
export const daysUntil = (iso: string) => {
  const d = new Date(iso);
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((a - b) / 86400_000);
};
