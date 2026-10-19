// 聊天平台无关的消息结构。正文用一套很小的 Markdown 子集：**加粗**、`代码`、[文字](链接)、换行，
// 各平台适配器负责转换成自己的格式。

export type Platform = 'telegram' | 'feishu' | 'discord' | 'slack';

export interface Button {
  text: string;
  /** 回调动作，由 actions.ts 处理 */
  action?: string;
  url?: string;
  /** 点一下复制这段文字（只有 Telegram 原生支持，其他平台退化为把内容放进正文） */
  copy?: string;
}

export interface Card {
  title?: string;
  text: string;
  buttons?: Button[][];
  tone?: 'mail' | 'code' | 'task' | 'ai' | 'info' | 'warn';
}

export interface BotIO {
  reply(card: Card): Promise<void>;
  file(name: string, data: Buffer, mime: string): Promise<void>;
  /** 对按钮点击的简短反馈（Telegram 会在原消息末尾标注并去掉按钮） */
  note(text: string): Promise<void>;
}

export interface Adapter {
  platform: Platform;
  label: string;
  enabled(): boolean;
  /** 机器人在该平台上的名字，未启动时为 null */
  name(): string | null;
  /** 绑定时给用户的指引 */
  bindHint(code: string): { url?: string; text: string };
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, card: Card): Promise<void>;
  sendFile(chatId: string, name: string, data: Buffer, mime: string): Promise<void>;
}

/** 把过长的正文按段落拆成多条，按钮只放在最后一条 */
export function splitCard(card: Card, max: number): Card[] {
  if (card.text.length + (card.title?.length || 0) <= max) return [card];
  const parts: string[] = [];
  let cur = '';
  for (const line of card.text.split('\n')) {
    let rest = cur ? `\n${line}` : line;
    // 超长的行先把当前这条填满再换下一条
    while (cur.length + rest.length > max) {
      const room = max - cur.length;
      if (room > 200 || !cur) {
        cur += rest.slice(0, room);
        rest = rest.slice(room);
      }
      parts.push(cur);
      cur = '';
      rest = rest.replace(/^\n/, '');
    }
    cur += rest;
  }
  if (cur) parts.push(cur);
  return parts.map((text, i) => ({
    ...card,
    title: i === 0 ? card.title : undefined,
    text,
    buttons: i === parts.length - 1 ? card.buttons : undefined,
  }));
}

// ---- 小 Markdown 子集的解析，供各平台渲染 ----

export type Span = { t: 'text' | 'bold' | 'code'; v: string } | { t: 'link'; v: string; url: string };

export function spans(md: string): Span[] {
  const out: Span[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const m of md.matchAll(re)) {
    if (m.index! > last) out.push({ t: 'text', v: md.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'bold', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'code', v: m[2] });
    else out.push({ t: 'link', v: m[3], url: m[4] });
    last = m.index! + m[0].length;
  }
  if (last < md.length) out.push({ t: 'text', v: md.slice(last) });
  return out;
}

/** 给用户的纯文本里去掉会被误当成格式标记的字符 */
export const plain = (s: string) => s.replace(/[*`[\]]/g, (c) => ({ '*': '∗', '`': 'ˋ', '[': '［', ']': '］' })[c]!);
