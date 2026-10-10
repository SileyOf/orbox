// 从邮件里提取验证码。思路：必须先出现"验证码"类关键词，再在关键词附近找最像验证码的一串字符。

const KEYWORD_SOURCE =
  /验证码|校验码|驗證碼|动态码|動態碼|动态密码|确认码|確認碼|激活码|安全码|登录码|登入碼|授权码|一次性密码|verification code|verify code|security code|confirmation code|authentication code|auth code|access code|login code|sign[- ]?in code|one[- ]?time (?:pass)?(?:code|word)|passcode|\bOTP\b|\b2FA\b|\bPIN\b|guard code|temporary (?:login |sign[- ]?in )?code|your code|code is|code below|(?:enter|use) (?:this|the|your) code|認証コード|確認コード|ワンタイム|인증번호|인증 코드/;
// matchAll 会继承正则的 lastIndex，所以每次用都新建，避免上一次调用留下的状态
const keywords = () => new RegExp(KEYWORD_SOURCE.source, 'gi');
const hasKeyword = (s: string) => new RegExp(KEYWORD_SOURCE.source, 'i').test(s);

// 4–8 位纯数字；带字母前缀的数字（G-123456）；带分隔的 6–8 位数字（123 456 / 123-456）；含数字的 4–10 位大写字母数字串（可带 G- 这类前缀）
const CANDIDATE_SOURCE =
  /(?<![\w.@/#=&%+-])(?:(\d{3,4})[ -](\d{3,4})|(\d{4,8})|([A-Z]{1,3}-\d{4,8})|((?:[A-Z]{1,3}-)?(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,10}))(?![\w@/=&%+-]|\.\d)/;

// 紧跟这些词的数字是时长、金额之类，不是验证码
const UNIT_AFTER = /^\s*(?:分钟|分鐘|分|秒|小时|小時|天|元|块|次|位|个|年|月|日|minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|digits?|characters?|px|pt|GB|MB|KB|%|％)/i;
const MONEY_BEFORE = /[$¥￥€£]\s*$/;

interface Candidate {
  value: string;
  index: number;
  end: number;
}

function candidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(new RegExp(CANDIDATE_SOURCE.source, 'g'))) {
    const index = m.index!;
    const end = index + m[0].length;
    if (UNIT_AFTER.test(text.slice(end, end + 12)) || MONEY_BEFORE.test(text.slice(Math.max(0, index - 3), index))) continue;
    const value = m[1] ? m[1] + m[2] : m[0];
    // 4 位的年份几乎不会是验证码
    if (/^(19|20)\d\d$/.test(value) && /^(?:\s*[年/.-]|\s*$)/.test(text.slice(end, end + 2))) continue;
    out.push({ value, index, end });
  }
  return out;
}

/** 在一段文字里找离关键词最近的候选，优先取关键词之后的 */
function nearest(text: string): { value: string; score: number } | null {
  const keys = [...text.matchAll(keywords())].map((m) => ({ index: m.index!, end: m.index! + m[0].length }));
  if (!keys.length) return null;
  let best: { value: string; score: number } | null = null;
  for (const c of candidates(text)) {
    for (const k of keys) {
      const after = c.index >= k.end;
      const distance = after ? c.index - k.end : k.index - c.end;
      if (distance < 0 || distance > (after ? 120 : 40)) continue;
      // 关键词之前的候选要打折："123456 is your verification code" 成立，但更常见的是码在后面
      let score = distance * (after ? 1 : 2.5);
      // 纯数字 6 位是最常见的形态，字母数字混合的容易误伤订单号之类，稍微靠后
      if (!/^\d+$/.test(c.value)) score += 25;
      else if (c.value.length === 6) score -= 8;
      if (!best || score < best.score) best = { value: c.value, score };
    }
  }
  return best;
}

export function extractCode(subject: string, body: string): string | null {
  // 去掉链接，避免把 URL 里的 token 片段当成验证码
  const clean = (s: string) => s.replace(/https?:\/\/\S+/gi, ' ').replace(/[​-‏﻿]/g, '');
  const subj = clean(subject || '');
  const text = clean(body || '').slice(0, 6000);

  const inSubject = nearest(subj);
  if (inSubject) return inSubject.value;
  const inBody = nearest(text);
  if (inBody) return inBody.value;

  // 主题说了是验证码、正文只有一个光秃秃的数字的情况（很多模板把码单独放一行大字）
  if (hasKeyword(subj)) {
    const numeric = candidates(text).filter((c) => /^\d+$/.test(c.value));
    const six = numeric.find((c) => c.value.length === 6) || numeric[0];
    if (six) return six.value;
  }
  return null;
}
