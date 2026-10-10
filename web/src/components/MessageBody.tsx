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
    return `<!doctype html>${sanitizeMail(html).replace('<head>', `<head>${head}`)}`;
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
  useEffect(() => setAllowRemote(!blockRemote), [message.id, blockRemote]);
  const html = message.body_html;
  const hasRemote = !!html && REMOTE.test(html);

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
        {html ? <HtmlBody html={html} allowRemote={allowRemote} /> : <TextBody text={message.body_text || '(无正文)'} />}
      </div>
    </>
  );
}
