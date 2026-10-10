import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';

export interface QuickTask {
  title: string;
  dueAt: Date | null;
}

/** 从一句话里拆出时间和事项，例如"明天9点 交报告"。识别不出时间就整句当标题 */
export function parseQuickTask(text: string, tz: string): QuickTask {
  const input = text.trim();
  // chrono 的中文解析器按进程本地时区计算"明天"等相对日期，不认参考时区。
  // 所以把用户时区的墙上时间伪装成本地时间交给它，再把结果的墙上时间按用户时区还原。
  const now = DateTime.now().setZone(tz);
  const ref = new Date(now.year, now.month - 1, now.day, now.hour, now.minute, now.second);
  const hit =
    chrono.zh.hans.parse(input, ref, { forwardDate: true })[0] || chrono.parse(input, ref, { forwardDate: true })[0];
  if (!hit) return { title: input, dueAt: null };

  const wall = hit.start.date();
  let due = DateTime.fromObject(
    {
      year: wall.getFullYear(),
      month: wall.getMonth() + 1,
      day: wall.getDate(),
      hour: wall.getHours(),
      minute: wall.getMinutes(),
    },
    { zone: tz },
  );
  // 只说了日期没说钟点时默认早上 9 点
  if (!hit.start.isCertain('hour')) due = due.set({ hour: 9, minute: 0 });
  const title = (input.slice(0, hit.index) + input.slice(hit.index + hit.text.length))
    .replace(/^[\s,，。:：]+|[\s,，。:：]+$/g, '')
    .replace(/^(提醒我|记得|要)\s*/, '');
  return { title: title || input, dueAt: due.toJSDate() };
}

export const formatWhen = (d: Date, tz: string) =>
  DateTime.fromJSDate(d, { zone: tz }).setLocale('zh-CN').toFormat('M月d日 ccc HH:mm');
