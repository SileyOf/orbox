import type { FastifyInstance } from 'fastify';
import { one } from '../db.js';
import { worker } from '../mail/manager.js';
import type { AttachmentMeta } from '../mail/parse.js';
import { verifyWebview } from '../mail/webview.js';

// 不需要登录的页面：聊天机器人里"浏览器打开原文"的签名链接

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function publicRoutes(app: FastifyInstance) {
  async function load(token: string) {
    const auth = verifyWebview(token);
    if (!auth) return null;
    let m = await one('SELECT * FROM messages WHERE id = ? AND user_id = ?', [auth.messageId, auth.userId]);
    if (m && !m.body_fetched) {
      await worker(m.account_id).loadBody(m.id).catch(() => {});
      m = await one('SELECT * FROM messages WHERE id = ?', [auth.messageId]);
    }
    return m || null;
  }

  const notFound = (reply: any, text: string) =>
    reply.code(404).type('text/html; charset=utf-8').send(`<meta charset="utf-8"><p style="font:16px sans-serif;padding:24px">${text}</p>`);

  app.get<{ Params: { token: string }; Querystring: { images?: string } }>('/v/:token', async (req, reply) => {
    const m = await load(req.params.token);
    if (!m) return notFound(reply, '链接无效、已过期，或邮件已被移动。');
    const base = `/v/${req.params.token}`;
    const images = req.query.images === '1';
    const atts = ((m.attachments || []) as AttachmentMeta[]).filter((a) => !a.inline);
    const date = new Date(m.date).toLocaleString('zh-CN', { hour12: false });
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'")
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex')
      .header('Cache-Control', 'private, no-store')
      .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.subject || '邮件')}</title><style>
body{margin:0;background:#fafbf8;color:#242923;font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}
@media (prefers-color-scheme:dark){body{background:#171a18;color:#ecf0eb}.card{border-color:#383e39!important}}
.wrap{max-width:820px;margin:0 auto;padding:20px 16px 48px}h1{font-size:21px;line-height:1.35;margin:0 0 10px}
.meta{color:#7a8278;font-size:13px;margin-bottom:16px}.card{border:1px solid #e4e8e1;border-radius:14px;overflow:hidden;background:#fff}
iframe{display:block;width:100%;height:75vh;border:0;background:#fff}.bar{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
a{color:#4d7c0f}</style></head><body><div class="wrap">
<h1>${esc(m.subject || '(无主题)')}</h1>
<div class="meta">${esc(m.from_name || '')} &lt;${esc(m.from_addr)}&gt; · ${esc(date)}</div>
<div class="bar">${images ? '' : `<a href="${base}?images=1">显示远程图片</a>`}${atts.map((a) => `<a href="${base}/a/${a.i}">📎 ${esc(a.filename)}</a>`).join('')}</div>
<div class="card"><iframe src="${base}/body${images ? '?images=1' : ''}" title="邮件正文"></iframe></div>
<p class="meta">这是一个有时效的分享链接，请勿转发。</p></div></body></html>`);
  });

  /**
   * 邮件正文本身。用 CSP 的 sandbox 指令把它关进无脚本、独立源的沙箱，
   * 即使有人直接打开这个地址，邮件里的任何脚本也无法执行。
   */
  app.get<{ Params: { token: string }; Querystring: { images?: string } }>('/v/:token/body', async (req, reply) => {
    const m = await load(req.params.token);
    if (!m) return notFound(reply, '链接无效或已过期。');
    let html: string = m.body_html || `<pre style="white-space:pre-wrap;font:15px/1.7 sans-serif">${esc(m.body_text || '')}</pre>`;
    // 内嵌图片直接写成 data URI：沙箱里的文档是不透明源，再去请求本站资源容易被浏览器拦下
    const inline = ((m.attachments || []) as AttachmentMeta[]).filter((a) => a.inline && a.cid);
    if (inline.length) {
      const raw = (await worker(m.account_id).fetchSource(m.id).catch(() => null))?.raw || [];
      for (const a of inline) {
        const att = raw[a.i];
        const ok = att && /^image\/(png|jpeg|gif|webp)$/i.test(att.contentType) && att.size <= 3 * 1024 * 1024;
        html = html.split(`cid:${a.cid}`).join(ok ? `data:${att.contentType};base64,${att.content.toString('base64')}` : '');
      }
    }
    const images = req.query.images === '1';
    return reply
      .type('text/html; charset=utf-8')
      .header(
        'Content-Security-Policy',
        `sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src ${images ? '* data:' : 'data:'}`,
      )
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'private, no-store')
      .send(`<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:20px;overflow-wrap:anywhere;font:15px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}img{max-width:100%;height:auto}</style>${html}`);
  });

  app.get<{ Params: { token: string; i: string } }>('/v/:token/a/:i', async (req, reply) => {
    const auth = verifyWebview(req.params.token);
    const m = auth && (await one<{ id: number; account_id: number }>('SELECT id, account_id FROM messages WHERE id = ? AND user_id = ?', [auth.messageId, auth.userId]));
    if (!m) return reply.code(404).send('Not found');
    const att = (await worker(m.account_id).fetchSource(m.id)).raw[Number(req.params.i)];
    if (!att) return reply.code(404).send('Not found');
    const safeInline = /^image\/(png|jpeg|gif|webp)$/i.test(att.contentType);
    return reply
      .header('Content-Type', safeInline ? att.contentType : 'application/octet-stream')
      .header('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.filename || 'attachment')}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(att.content);
  });
}
