import { DateTime } from 'luxon';

// 简单记的一句话解析（纯函数，不依赖数据库，便于测试）：拆出日期、金额、币种、分类、是否报销、出差开始 / 结束。

export const CATEGORIES = ['交通', '住宿', '餐饮', '购物', '通讯', '办公', '娱乐', '医疗', '账单', '其他', '备忘'] as const;

export interface ParsedNote {
  day: string;
  content: string;
  amount?: number | null;
  currency?: string;
  category?: string;
  reimbursable?: boolean;
  tripStart?: string;
  tripEnd?: boolean;
}

const CATEGORY_WORDS: [string, RegExp][] = [
  ['交通', /打车|出租|滴滴|网约车|高铁|动车|火车|机票|航班|飞机|地铁|公交|加油|油费|停车|过路|高速|租车|taxi|uber|train|flight/i],
  ['住宿', /酒店|住宿|宾馆|民宿|旅馆|hotel|airbnb/i],
  ['餐饮', /早餐|午餐|晚餐|早饭|午饭|晚饭|吃饭|餐|咖啡|奶茶|外卖|饮料|宵夜|lunch|dinner|coffee/i],
  ['通讯', /话费|流量|宽带|手机费/],
  ['办公', /打印|快递|文具|办公|会议/],
  ['医疗', /医院|药|挂号|体检/],
  ['购物', /买|购物|超市|淘宝|京东|拼多多/],
  ['娱乐', /电影|门票|游戏|KTV|演出/i],
];

const CURRENCIES: [RegExp, string][] = [
  [/[¥￥]|元|块|人民币|rmb|cny/i, 'CNY'],
  [/\$|美元|美金|usd/i, 'USD'],
  [/円|日元|jpy/i, 'JPY'],
  [/€|欧元|eur/i, 'EUR'],
  [/港币|港元|hkd/i, 'HKD'],
  [/£|英镑|gbp/i, 'GBP'],
];

/** 一句话里拆出日期、金额、币种、分类、是否报销。拆不出的保持原样 */
export function parseNote(text: string, tz: string, defaultCurrency = 'CNY'): ParsedNote {
  let s = text.trim();
  const now = DateTime.now().setZone(tz);
  let day = now.toISODate()!;
  const rel = s.match(/^(今天|昨天|前天)\s*/);
  if (rel) {
    day = now.minus({ days: { 今天: 0, 昨天: 1, 前天: 2 }[rel[1] as '今天'] }).toISODate()!;
    s = s.slice(rel[0].length);
  } else {
    const md = s.match(/^(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})[日号]?\s*/);
    if (md) {
      const d = DateTime.fromObject({ year: md[1] ? Number(md[1]) : now.year, month: Number(md[2]), day: Number(md[3]) }, { zone: tz });
      if (d.isValid) {
        day = (md[1] || d <= now ? d : d.minus({ years: 1 })).toISODate()!;
        s = s.slice(md[0].length);
      }
    }
  }

  // "出差 上海" / "今天出差去上海" 开始出差；"出差结束" / "出差回来了" 结束
  if (/^出差(结束|回来|完了)|^(结束|回来).{0,4}出差|^出差回来/.test(s)) return { day, content: text.trim(), category: '备忘', tripEnd: true };
  const trip = s.match(/^(?:开始)?出差[，,\s]*(?:去|到)?\s*([^\d¥￥$,，。]{1,20})?$/);
  if (trip) return { day, content: text.trim(), category: '备忘', tripStart: (trip[1] || '').trim() || '出差' };

  let amount: number | null = null;
  let currency = defaultCurrency;
  // 优先取带货币符号 / 单位的数字；都没有时取最后一个不像数量、日期、时间的数字（"住了2晚 酒店 840" → 840）
  const re = /([¥￥$€£])\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(元|块钱?|美元|美金|日元|円|欧元|港币|港元|英镑|rmb|cny|usd|jpy|eur|hkd|gbp)?/gi;
  const hits = [...s.matchAll(re)].filter((m) => {
    if (m[1] || m[4]) return true;
    const after = s.slice(m.index! + m[0].length);
    if (/[:：.\d]$/.test(s.slice(0, m.index))) return false;
    if (/^\s*[本个天晚人次号点张件杯份位岁年月日周:：%度公斤里]/.test(after)) return false;
    if (/^\d{4}$/.test(m[3]) && Number(m[3]) > 1900 && Number(m[3]) < 2100) return false;
    return true;
  });
  const m = hits.find((h) => h[1] || h[4]) || hits.at(-1);
  if (m) {
    amount = Number(m[2] || m[3]);
    currency = CURRENCIES.find(([r]) => r.test(m[1] || m[4] || ''))?.[1] || defaultCurrency;
    s = (s.slice(0, m.index) + s.slice(m.index! + m[0].length)).replace(/\s{2,}/g, ' ');
  }
  const reimbursable = /报销|差旅|公司付|公费/.test(s);
  s = s.replace(/[，,\s]*(可?报销|要报销|公司付|公费)[，,。\s]*/g, ' ').trim().replace(/^[，,。:：\s]+|[，,。:：\s]+$/g, '');
  const category = amount === null ? '备忘' : CATEGORY_WORDS.find(([, re]) => re.test(s))?.[0] || '其他';
  return { day, content: s || text.trim(), amount, currency, category, reimbursable };
}

