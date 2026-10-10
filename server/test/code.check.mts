import { extractCode } from '../src/mail/code.ts';
const cases: [string, string, string | null][] = [
  ['【GitHub】验证码', '您的验证码是 482913，10 分钟内有效，请勿泄露。', '482913'],
  ['Your verification code', 'Hi,\nUse the code below to sign in.\n\n  739 204\n\nThis code expires in 15 minutes.', '739204'],
  ['493817 is your Twitter verification code', 'Confirm your email. 493817', '493817'],
  ['Google 验证码', 'G-582931 是您的 Google 验证码。', 'G-582931'],
  ['登录验证', '您正在登录，校验码：8271。如非本人操作请忽略。客服电话 4008123456', '8271'],
  ['Steam Guard', 'Here is the Steam Guard code you need to login to account yuki:\n\nK7P2M\n', 'K7P2M'],
  ['Your order #20261009 has shipped', 'Order 20261009 total $1299.00, arriving 2026-10-12.', null],
  ['周五的项目评审会议安排', '周五下午 3 点开会，房间 1024，请带上 2026 年预算。', null],
  ['Sign in to Notion', 'Your temporary login code is: mnemonic-sample\nOr copy: 918-273', '918273'],
  ['认证コード', 'あなたの認証コードは 550123 です。有効期限は30分です。', '550123'],
  ['Verify your email', 'Click the link: https://example.com/verify?token=884422AB&uid=123456 to verify your email.', null],
  ['Cloudflare', 'Your one-time code is 204816. It expires in 10 minutes. Request ID 99887766', '204816'],
  ['[Orbox] 安全提醒', '我们在 2026 年 10 月 9 日检测到新设备登录，IP 203.0.113.41。', null],
  ['验证码', '<尊敬的用户>\n\n385920\n\n该验证码 5 分钟内有效。', '385920'],
  ['Apple ID', 'Your Apple ID Code is: 620417. Don\'t share it with anyone.', '620417'],
  ['Password reset', 'We received a request. Your PIN: 4471. If you did not request it call 1-800-555-0199.', '4471'],
];
let bad = 0;
for (const [s, b, want] of cases) { const got = extractCode(s, b); if (got !== want) { bad++; console.log('FAIL', JSON.stringify(s), '=>', got, 'want', want); } }
console.log(`${cases.length - bad}/${cases.length} passed`);
if (bad) process.exit(1);
