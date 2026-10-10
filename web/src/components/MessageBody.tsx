import DOMPurify from 'dompurify';
import { ImageOff } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { MessageFull } from '../api';

const REMOTE = /(?:src|background|srcset)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:/i;
const OWN_COLORS = /bgcolor\s*=|background(?:-color)?\s*:|<style/i;
const URL_RE = /(https?:\/\/[^\s<>"'，。）】]+)/g;

const purifier = DOMPurify();
purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export const sanitizeMail = (html: string) =>
  purifier.sanitize(html, { WHOLE_DOCUMENT: true, FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select'] });

/**
 * HTML 邮件放进不允许脚本的沙箱 iframe，并用 CSP 掐掉一切外部请求；
 * 远程图片只有用户点了"显示"才放行，避免追踪像素暴露已读状态。
 */
const QUOTE_SELECTOR = '.gmail_quote, .yahoo_quoted, .moz-cite-prefix, #divRplyFwdMsg, #appendonsend, blockquote';

/**
 * 把回复里层层嵌套的历史引用从正文里拆出去，默认只显示对方这次新写的内容。
 * 引用块以及它后面的同级内容都算引用；前面没有任何正文（纯转发）时不拆。
 */
function stripQuoteHtml(safeHtml: string): string | null {
  const doc = new DOMParser().parseFromString(safeHtml, 'text/html');
  const quote = doc.body.querySelector(QUOTE_SELECTOR);
  if (!quote || (quote.textContent || '').trim().length < 60) return null;
  let node: Element | null = quote;
  // 引用块可能包在几层 div 里，沿着父级把每一层后面的兄弟节点都去掉
  while (node && node !== doc.body) {
    while (node.nextSibling) node.nextSibling.remove();
    const parent: Element | null = node.parentElement;
    if (node === quote) node.remove();
    node = parent;
  }
  if (!(doc.body.textContent || '').trim()) return null;
  return doc.documentElement.outerHTML;
}

/** 纯文本邮件：结尾连续的 ">" 引用行（连同上面那句"某某写道："）视为引用 */
function splitQuoteText(text: string): { main: string; quote: string } | null {
  const lines = text.split('\n');
  let start = lines.length;
  while (start > 0 && /^\s*(>|$)/.test(lines[start - 1])) start--;
  if (!lines.slice(start).some((l) => /^\s*>/.test(l))) return null;
  if (start > 0 && /(wrote|写道|寫道|написал)\s*[:：]\s*$/i.test(lines[start - 1])) start--;
  const main = lines.slice(0, start).join('\n').trimEnd();
  return main ? { main, quote: lines.slice(start).join('\n') } : null;
}

function HtmlBody({ html, allowRemote }: { html: string; allowRemote: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  const srcDoc = useMemo(() => {
    // 自带底色的营销类邮件固定白底渲染；没有自定义配色的简单邮件跟随当前主题
    const themed = !OWN_COLORS.test(html);
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const csp = `default-src 'none'; img-src 'self' data: ${allowRemote ? 'https: http:' : ''}; style-src 'unsafe-inline'; font-src data:`;
    const base = `
      html { color-scheme: ${themed && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}; }
      body { margin: 0; padding: 22px 24px; overflow-wrap: anywhere; overflow-x: auto;
        font: 15.5px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
        background: ${themed ? v('--panel') : '#fff'}; color: ${themed ? v('--ink') : '#222'}; }
      img { max-width: 100%; height: auto; }
      a { color: ${themed ? v('--accent-ink') : '#2563eb'}; }
      blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid ${themed ? v('--line') : '#ddd'}; }
      pre { white-space: pre-wrap; }`;
    const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${base}</style>`;
    return `<!doctype html>${html.replace('<head>', `<head>${head}`)}`;
  }, [html, allowRemote]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const doc = frame.contentDocument;
      if (doc?.documentElement) setHeight(Math.ceil(doc.documentElement.scrollHeight));
    };
    const onLoad = () => {
      measure();
      const body = frame.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      title="邮件正文"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      style={{ height }}
    />
  );
}

function TextBody({ text }: { text: string }) {
  return (
    <div className="reader-text">
      {text.split(URL_RE).map((part, i) =>
        i % 2 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </div>
  );
}

export function MessageBody({ message, blockRemote }: { message: MessageFull; blockRemote: boolean }) {
  const [allowRemote, setAllowRemote] = useState(!blockRemote);
  const [showQuote, setShowQuote] = useState(false);
  useEffect(() => setAllowRemote(!blockRemote), [message.id, blockRemote]);
  const html = message.body_html;
  const hasRemote = !!html && REMOTE.test(html);
  const safe = useMemo(() => (html ? sanitizeMail(html) : null), [html]);
  const trimmedHtml = useMemo(() => (safe ? stripQuoteHtml(safe) : null), [safe]);
  const textParts = useMemo(() => (html ? null : splitQuoteText(message.body_text || '')), [html, message.body_text]);
  const hasQuote = !!(trimmedHtml || textParts);

  if (message.bodyError) return <div className="banner">正文加载失败：{message.bodyError}</div>;
  return (
    <>
      {hasRemote && !allowRemote && (
        <div className="banner">
          <ImageOff size={15} />
          为保护隐私，已拦截这封邮件里的远程图片
          <button className="btn sm" onClick={() => setAllowRemote(true)}>
            显示图片
          </button>
        </div>
      )}
      <div className="reader-body">
        {safe ? (
          <HtmlBody html={showQuote || !trimmedHtml ? safe : trimmedHtml} allowRemote={allowRemote} />
        ) : (
          <TextBody text={(showQuote || !textParts ? message.body_text : textParts.main) || '(无正文)'} />
        )}
        {hasQuote && (
          <button className="quote-toggle" onClick={() => setShowQuote(!showQuote)} title={showQuote ? '收起引用内容' : '显示引用内容'}>
            {showQuote ? '收起引用内容' : '··· 显示引用内容'}
          </button>
        )}
      </div>
    </>
  );
}
