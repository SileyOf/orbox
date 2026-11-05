import { DateTime } from 'luxon';
import { parseNote } from '../src/notes/parse.ts';
import { lunarLabel, nextLunarDay, toLunar } from '../src/tasks/lunar.ts';

const tz = 'Asia/Shanghai';
const today = DateTime.now().setZone(tz).toISODate();
const yesterday = DateTime.now().setZone(tz).minus({ days: 1 }).toISODate();
type Expect = { content?: string; amount?: number | null; currency?: string; category?: string; reimbursable?: boolean; day?: string; tripStart?: string; tripEnd?: boolean };
const cases: [string, Expect][] = [
  ['打车 56 报销', { content: '打车', amount: 56, category: '交通', reimbursable: true }],
  ['昨天 酒店 ¥420', { content: '酒店', amount: 420, category: '住宿', day: yesterday! }],
  ['午饭 38.5元', { amount: 38.5, category: '餐饮', currency: 'CNY' }],
  ['午饭 1200円', { amount: 1200, currency: 'JPY' }],
  ['给妈妈买药 $30', { amount: 30, currency: 'USD', category: '医疗' }],
  ['住了2晚 酒店 840 报销', { amount: 840, category: '住宿', reimbursable: true }],
  ['买了3本书 45', { amount: 45, category: '购物' }],
  ['9:30 开会记得带电脑', { amount: null, category: '备忘' }],
  ['2026年的计划想一想', { amount: null }],
  ['明天要带2个包', { amount: null }],
  ['护照放在书房第二个抽屉', { amount: null, category: '备忘', day: today! }],
  ['今天出差去上海', { tripStart: '上海' }],
  ['出差', { tripStart: '出差' }],
  ['出差结束', { tripEnd: true }],
  ['出差回来了', { tripEnd: true }],
];
let bad = 0;
for (const [text, want] of cases) {
  const got = parseNote(text, tz) as Record<string, unknown>;
  const diff = Object.entries(want).filter(([k, v]) => got[k] !== v);
  if (diff.length) {
    bad++;
    console.log('✗', text, '→', JSON.stringify(got), 'expected', JSON.stringify(Object.fromEntries(diff)));
  }
}

// 农历：与 ICU 的中国农历一致
const lunar: [() => string, string][] = [
  [() => nextLunarDay(1, 1, '2026-01-01'), '2026-02-17'],
  [() => nextLunarDay(8, 15, '2026-01-01'), '2026-09-25'],
  [() => lunarLabel(toLunar('2023-03-22')), '闰二月初一'],
  [() => lunarLabel({ month: 12, day: 23 }), '腊月廿三'],
];
for (const [f, want] of lunar) {
  const got = f();
  if (got !== want) (bad++, console.log('✗ lunar', got, 'expected', want));
}
console.log(bad ? `notes: ${bad} 项不符` : `notes: ${cases.length + lunar.length} 项全部通过`);
process.exit(bad ? 1 : 0);
