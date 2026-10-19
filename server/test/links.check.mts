import { extractLinks, primaryLink } from '../src/mail/links.ts';
import { parseRefs, subjectKey, isReply } from '../src/mail/thread-keys.ts';
let bad = 0;
const ok = (cond: boolean, label: string) => { if (!cond) { bad++; console.log('FAIL', label); } };

const html = `<html><head><style>a{}</style></head><body>
<p>您的 <b>Orimg Pro</b> 将于 3 天后到期。</p>
<a href="https://click.example-mail.com/ls/click?upn=abc&amp;x=1">立即续费</a>
<a href="https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fbilling.orimg.com%2Finvoice%2F42&data=x">查看发票</a>
<a href="https://evil.example.net/login">https://www.paypal.com/signin</a>
<a href="https://orimg.com/unsubscribe?u=1">退订</a>
<a href="mailto:help@orimg.com">联系我们</a>
<a href="https://orimg.com/"><img src="logo.png" alt="Orimg"></a>
</body></html>`;
const links = extractLinks(html, '如有问题访问 https://orimg.com/help 。');
console.log(links.map((l) => `${l.kind}${l.suspicious ? '!' : ''} ${l.domain} "${l.text}"`).join('\n'));
ok(links[0].kind === 'billing' && links[0].text === '立即续费', 'billing first');
ok(links.some((l) => l.url === 'https://billing.orimg.com/invoice/42' && l.kind === 'billing'), 'safelinks unwrapped');
ok(links.some((l) => l.domain === 'evil.example.net' && l.suspicious), 'phishing flagged');
ok(links[links.length - 1].kind === 'unsubscribe', 'unsubscribe last');
ok(!links.some((l) => l.url.startsWith('mailto')), 'mailto dropped');
ok(links.some((l) => l.url === 'https://orimg.com/help'), 'plain text url, trailing punctuation trimmed');
ok(primaryLink(links)?.text === '立即续费', 'primary link');

ok(parseRefs(Buffer.from('References: <a@x>\r\n <b@x>\r\n\r\n')) === '<a@x> <b@x>', 'refs folded');
ok(subjectKey('Re: 回复：周五的会议') === subjectKey('周五的会议'), 'subject key strips prefixes');
ok(isReply('回复：周五的会议') && !isReply('Fwd: 周五的会议'), 'reply detection');
console.log(bad ? `${bad} failed` : 'all passed');
if (bad) process.exit(1);
