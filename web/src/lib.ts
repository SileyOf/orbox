import { useSyncExternalStore } from 'react';
import type { UserSettings } from './api';

export const ACCENTS = ['#cceb79', '#ff8a65', '#f2c14e', '#7fd1ae', '#7db7f0', '#b39df2', '#f29ac0', '#283026'];

/** 强调色上的文字颜色：按相对亮度在深浅之间选一个 */
export function onAccent(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1d2219' : '#ffffff';
}

export function applyAppearance(s: Pick<UserSettings, 'theme' | 'accent'>) {
  const root = document.documentElement;
  const dark = s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.setProperty('--accent', s.accent);
  root.style.setProperty('--on-accent', onAccent(s.accent));
  try {
    localStorage.setItem('orbox.theme', s.theme);
    localStorage.setItem('orbox.accent', s.accent);
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
