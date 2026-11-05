import { DateTime } from 'luxon';

// 农历日期：借助 Intl 的中国农历（ICU 自带，Node 和浏览器都有），不需要额外的数据表。
// 用于农历生日 / 纪念日：每年找出对应农历月日所在的公历日期。

const fmt = new Intl.DateTimeFormat('en-u-ca-chinese', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });

export interface LunarDate {
  month: number;
  day: number;
  leap: boolean;
}

/** 公历日期（YYYY-MM-DD）对应的农历月日 */
export function toLunar(iso: string): LunarDate {
  const parts = fmt.formatToParts(new Date(`${iso}T00:00:00Z`));
  const m = parts.find((p) => p.type === 'month')!.value;
  return { month: parseInt(m, 10), day: Number(parts.find((p) => p.type === 'day')!.value), leap: /bis/.test(m) };
}

const MONTHS = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十'];
export const lunarLabel = (l: { month: number; day: number; leap?: boolean }) =>
  `${l.leap ? '闰' : ''}${MONTHS[l.month - 1]}月${l.day <= 10 ? DAYS[l.day - 1] : l.day < 20 ? `十${'一二三四五六七八九'[l.day - 11]}` : l.day === 20 ? '二十' : l.day < 30 ? `廿${'一二三四五六七八九'[l.day - 21]}` : '三十'}`;

/**
 * 从 fromIso（含）开始，下一个农历 month 月 day 日对应的公历日期。
 * 闰月不单独过（按习惯在正常月份过）；小月没有三十时取当月最后一天（廿九）。
 */
export function nextLunarDay(month: number, day: number, fromIso: string): string {
  let d = DateTime.fromISO(fromIso, { zone: 'UTC' });
  for (let i = 0; i < 400; i++, d = d.plus({ days: 1 })) {
    const l = toLunar(d.toISODate()!);
    if (l.leap || l.month !== month) continue;
    if (l.day === day) return d.toISODate()!;
    if (day === 30 && l.day === 29) {
      const next = toLunar(d.plus({ days: 1 }).toISODate()!);
      if (next.day === 1) return d.toISODate()!;
    }
  }
  throw new Error('农历日期无效');
}

/** 严格晚于 after 的下一次农历纪念日，钟点用 hhmm（用户时区） */
export function nextLunarOccurrence(lunar: { month: number; day: number }, hhmm: { hour: number; minute: number }, tz: string, after: Date): Date {
  let from = DateTime.fromJSDate(after, { zone: tz }).toISODate()!;
  for (let i = 0; i < 3; i++) {
    const iso = nextLunarDay(lunar.month, lunar.day, from);
    const at = DateTime.fromISO(iso, { zone: tz }).set({ hour: hhmm.hour, minute: hhmm.minute, second: 0, millisecond: 0 });
    if (at.toMillis() > after.getTime()) return at.toJSDate();
    from = DateTime.fromISO(iso).plus({ days: 1 }).toISODate()!;
  }
  throw new Error('农历日期无效');
}
