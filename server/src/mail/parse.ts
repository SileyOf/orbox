import { simpleParser } from 'mailparser';
import type { Attachment } from 'mailparser';
import type { MessageStructureObject } from 'imapflow';

export interface AttachmentMeta {
  i: number;
  filename: string;
  contentType: string;
  size: number;
  cid: string | null;
  inline: boolean;
}

export interface ParsedBody {
  text: string;
  html: string | null;
  snippet: string;
  attachments: AttachmentMeta[];
  raw: Attachment[];
}

export const makeSnippet = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" };

/** 粗略去标签，只用于摘要和搜索，不用于展示 */
function htmlToPlain(html: string): string {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (_, e) => ENTITIES[e]);
}

export async function parseSource(source: Buffer): Promise<ParsedBody> {
  const parsed = await simpleParser(source, { skipImageLinks: true });
  const html = parsed.html || null;
  const attachments = parsed.attachments.map((a, i) => ({
    i,
    filename: a.filename || `attachment-${i + 1}`,
    contentType: a.contentType || 'application/octet-stream',
    size: a.size,
    cid: a.cid || null,
    // 只有正文里真正引用到的 cid 才算内嵌，其余都当普通附件展示
    inline: !!(a.cid && html && html.includes(`cid:${a.cid}`)),
  }));
  const plain = html ? htmlToPlain(html) : '';
  // mailparser 从 HTML 生成的文本会把标题转成大写、排版表格时可能为空，摘要统一用自己去标签的结果
  const text = parsed.text?.trim() ? parsed.text : plain;
  return { text, html, snippet: makeSnippet(plain || text), attachments, raw: parsed.attachments };
}

/** 同步信封阶段还没有正文，先凭 BODYSTRUCTURE 判断有没有附件 */
export function structureHasAttachments(node?: MessageStructureObject): boolean {
  if (!node) return false;
  if (node.disposition?.toLowerCase() === 'attachment') return true;
  return (node.childNodes || []).some(structureHasAttachments);
}
