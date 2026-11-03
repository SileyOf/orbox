import { config } from '../config.js';
import { integration } from '../site.js';
import { decrypt, encrypt } from '../crypto.js';
import { exec } from '../db.js';

// Outlook / Microsoft 365 已停用密码登录，只能用 OAuth2 的 XOAUTH2 方式连 IMAP 和 SMTP
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPES = [
  'offline_access',
  'openid',
  'email',
  'profile',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
].join(' ');
/** 个人版 outlook.com / hotmail 账号所在的固定租户 */
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export const microsoftEnabled = () => !!(integration('microsoft').clientId && integration('microsoft').clientSecret);
export const microsoftRedirectUri = () => `${config.publicUrl}/api/oauth/microsoft/callback`;

export function microsoftAuthUrl(state: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: integration('microsoft').clientId,
    response_type: 'code',
    redirect_uri: microsoftRedirectUri(),
    response_mode: 'query',
    scope: SCOPES,
    state,
    prompt: 'select_account',
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${AUTHORITY}/authorize?${p}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: integration('microsoft').clientId,
      client_secret: integration('microsoft').clientSecret,
      scope: SCOPES,
      ...params,
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description?.split('\n')[0] || data.error || `Microsoft 返回 ${res.status}`);
    (err as any).oauthError = data.error;
    throw err;
  }
  return data;
}

export interface MicrosoftGrant {
  email: string;
  name: string;
  accessToken: string;
  refreshToken: string;
  imapHost: string;
  smtpHost: string;
}

/** 用授权码换令牌，并从 id_token 里取出邮箱地址 */
export async function exchangeMicrosoftCode(code: string): Promise<MicrosoftGrant> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: microsoftRedirectUri() });
  if (!t.refresh_token || !t.id_token) throw new Error('Microsoft 没有返回刷新令牌，请确认应用已勾选 offline_access 权限');
  // id_token 直接来自 Microsoft 的令牌端点（TLS），这里只读取声明，不需要再验签
  const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString('utf8'));
  const email = String(claims.email || claims.preferred_username || '').toLowerCase();
  if (!email.includes('@')) throw new Error('无法从 Microsoft 账号获取邮箱地址');
  return {
    email,
    name: claims.name || '',
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    imapHost: 'outlook.office365.com',
    smtpHost: claims.tid === CONSUMER_TENANT ? 'smtp-mail.outlook.com' : 'smtp.office365.com',
  };
}

const cache = new Map<number, { token: string; expires: number }>();
const pending = new Map<number, Promise<string>>();

export const forgetAccessToken = (accountId: number) => void cache.delete(accountId);

/** 取可用的访问令牌：缓存未过期直接用，否则用刷新令牌换新的（Microsoft 会同时轮换刷新令牌） */
export function getAccessToken(account: { id: number; oauth_refresh_enc: string | null }): Promise<string> {
  const hit = cache.get(account.id);
  if (hit && hit.expires > Date.now() + 60_000) return Promise.resolve(hit.token);
  let job = pending.get(account.id);
  if (!job) {
    job = (async () => {
      if (!account.oauth_refresh_enc) throw new Error('缺少授权信息，请重新授权');
      try {
        const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(account.oauth_refresh_enc) });
        if (t.refresh_token) {
          account.oauth_refresh_enc = encrypt(t.refresh_token);
          await exec('UPDATE accounts SET oauth_refresh_enc = ? WHERE id = ?', [account.oauth_refresh_enc, account.id]);
        }
        cache.set(account.id, { token: t.access_token, expires: Date.now() + t.expires_in * 1000 });
        return t.access_token;
      } catch (e: any) {
        if (e.oauthError === 'invalid_grant') throw new Error('授权已失效，请在设置里重新授权这个邮箱');
        throw e;
      }
    })().finally(() => pending.delete(account.id));
    pending.set(account.id, job);
  }
  return job;
}
