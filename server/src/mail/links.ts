// 从邮件里提取有意义的链接（续费、付款、验证、登录、物流、退订……），
// 并识别"显示的地址和实际跳转的地址不一致"这类常见的钓鱼特征。

export type LinkKind = 'billing' | 'verify' | 'account' | 'tracking' | 'download' | 'unsubscribe' | 'other';

export interface LinkInfo {
  url: string;
  text: string;
  domain: string;
  kind: LinkKind;
  /** 链接文字看起来是一个网址，但和真正的跳转域名不同 */
  suspicious?: boolean;
}

const RULES: [LinkKind, RegExp][] = [
  ['billing', /续费|續費|续订|續訂|续期|renew|subscription|subscribe now|billing|invoice|发票|發票|账单|帳單|付款|支付|缴费|繳費|pay now|payment|checkout|upgrade|升级|購買|购买|buy now|order now|recharge|充值|top[- ]?up|plan/i],
  ['verify', /验证|驗證|确认|確認|激活|启用|verify|confirm|activate|validate|approve|magic link/i],
  ['account', /登录|登入|sign[- ]?in|log[- ]?in|重置密码|reset (your )?password|change password|修改密码|security|安全|account|账户|帳戶|账号/i],
  ['tracking', /物流|快递|快遞|运单|運單|包裹|track(ing)?|shipment|delivery|派送|配送/i],
  ['download', /下载|下載|download|附件|attachment|view (the )?(document|file|invoice|receipt)|查看(文件|附件|发票|收据)/i],
  ['unsubscribe', /退订|退訂|取消订阅|取消訂閱|unsubscribe|opt[- ]?out|manage (email )?preferences|email preferences/i],
];
const ORDER: LinkKind[] = ['billing', 'verify', 'account', 'tracking', 'download', 'other', 'unsubscribe'];

/** 常见的跳转包装：能从参数里还原出真实地址的就还原 */
function unwrap(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const pick =
      (host.endsWith('safelinks.protection.outlook.com') && u.searchParams.get('url')) ||
      (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname === '/url' && (u.searchParams.get('q') || u.searchParams.get('url'))) ||
      (host === 'l.facebook.com' && u.searchParams.get('u')) ||
      (host === 'link.zhihu.com' && u.searchParams.get('target')) ||
      (host === 'weixin110.qq.com' && u.searchParams.get('url'));
    return pick && /^https?:\/\//i.test(pick) ? pick : url;
  } catch {
    return url;
  }
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const strip = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 文字本身像网址时取出它的域名，用于判断是否和真实跳转一致 */
function shownDomain(text: string): string | null {
  const m = text.match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]|$)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : null;
}

const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

function classify(text: string, url: string): LinkKind {
  // 先看链接文字，再看地址本身（很多按钮文字只写"点击这里"）
  for (const source of [text, url]) {
    for (const [kind, re] of RULES) if (re.test(source)) return kind;
  }
  return 'other';
}

export function extractLinks(html: string | null, text: string | null): LinkInfo[] {
  const found: { url: string; text: string }[] = [];
  if (html) {
    const body = html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '');
    for (const m of body.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
      const anchor = strip(m[3]) || (/<img\b[^>]*\balt\s*=\s*["']([^"']*)/i.exec(m[3])?.[1] ?? '');
      found.push({ url: decode(m[2].trim()), text: anchor });
    }
  }
  for (const m of (text || '').matchAll(/https?:\/\/[^\s<>"'（）()【】\]]+[^\s<>"'（）()【】\].,;:!?。，；：！？]/g)) {
    found.push({ url: m[0], text: '' });
  }

  const seen = new Map<string, LinkInfo>();
  for (const f of found) {
    if (!/^https?:\/\//i.test(f.url)) continue;
    const url = unwrap(f.url);
    const domain = domainOf(url);
    if (!domain) continue;
    const label = f.text.slice(0, 120);
    const shown = shownDomain(label);
    const info: LinkInfo = {
      url,
      text: label,
      domain,
      kind: classify(label, url),
      ...(shown && !sameSite(shown, domain) ? { suspicious: true } : {}),
    };
    const prev = seen.get(url);
    // 同一个地址出现多次时保留文字更有信息量的那个
    if (!prev || (!prev.text && info.text) || (prev.kind === 'other' && info.kind !== 'other')) seen.set(url, info);
  }
  return [...seen.values()]
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || Number(!!b.suspicious) - Number(!!a.suspicious))
    .slice(0, 60);
}

/** 值得在通知里单独给按钮的那一个链接：续费/付款优先，其次验证 */
export function primaryLink(links: LinkInfo[] | null | undefined): LinkInfo | null {
  return links?.find((l) => (l.kind === 'billing' || l.kind === 'verify') && !l.suspicious) || null;
}

export const LINK_LABELS: Record<LinkKind, string> = {
  billing: '续费 / 付款',
  verify: '验证 / 确认',
  account: '账户 / 登录',
  tracking: '物流',
  download: '下载 / 查看',
  unsubscribe: '退订',
  other: '其他',
};
