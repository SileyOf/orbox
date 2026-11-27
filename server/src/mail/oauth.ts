import { config } from '../config.js';
import { integration } from '../site.js';
import { decrypt, encrypt } from '../crypto.js';
import { exec } from '../db.js';

// Outlook / Microsoft 365 和 Gmail 都已停用（或限制）密码登录，要用 OAuth2 的 XOAUTH2 方式连 IMAP 和 SMTP。
// - 若后台或环境变量已配置 Web OAuth（Client ID + Secret），使用标准网页跳转回调（redirect 模式）；
// - 否则自动降级为内置免配置客户端（paste 模式）：打开授权页登录后把 localhost 回调链接粘回即可。

export type OAuthProvider = 'microsoft' | 'google';
export type OAuthMode = 'redirect' | 'paste';

/** 个人版 outlook.com / hotmail 账号所在的固定租户 */
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const PROVIDERS = {
  microsoft: {
    label: 'Microsoft',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'openid', 'email', 'profile', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'].join(' '),
    // Microsoft 的令牌请求需要带 scope
    scopeOnToken: true,
    extra: { response_mode: 'query', prompt: 'select_account' } as Record<string, string>,
  },
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    // Gmail 的 IMAP / SMTP 只认这一个范围
    scopes: ['https://mail.google.com/', 'openid', 'email', 'profile'].join(' '),
    scopeOnToken: false,
    // access_type=offline + prompt=consent 才会每次都返回刷新令牌
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } as Record<string, string>,
  },
} as const;

interface OAuthClient {
  mode: OAuthMode;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function oauthClient(provider: OAuthProvider, forceMode?: OAuthMode): OAuthClient | null {
  const web = integration(provider);
  if (forceMode !== 'paste' && web.clientId && web.clientSecret) {
    return {
      mode: 'redirect',
      clientId: web.clientId,
      clientSecret: web.clientSecret,
      redirectUri: `${config.publicUrl}/api/oauth/${provider}/callback`,
    };
  }
  if (forceMode === 'redirect') return null;
  if (provider === 'microsoft' && config.msPublicClientId) {
    return {
      mode: 'paste',
      clientId: config.msPublicClientId,
      clientSecret: '',
      redirectUri: 'https://localhost',
    };
  }
  if (provider === 'google' && config.googleDesktop.clientId && config.googleDesktop.clientSecret) {
    return {
      mode: 'paste',
      clientId: config.googleDesktop.clientId,
      clientSecret: config.googleDesktop.clientSecret,
      redirectUri: 'http://localhost',
    };
  }
  return null;
}

export const isOAuthProvider = (p: string): p is OAuthProvider => p === 'microsoft' || p === 'google';
export const oauthLabel = (p: OAuthProvider) => PROVIDERS[p].label;
export const oauthMode = (p: OAuthProvider): OAuthMode | null => oauthClient(p)?.mode ?? null;
export const oauthEnabled = (p: OAuthProvider) => !!oauthClient(p);
export const oauthRedirectUri = (p: OAuthProvider) => `${config.publicUrl}/api/oauth/${p}/callback`;
export const microsoftEnabled = () => oauthEnabled('microsoft');
export const microsoftRedirectUri = () => oauthRedirectUri('microsoft');

export function encodeRefreshToken(refreshToken: string, mode: OAuthMode): string {
  return encrypt(JSON.stringify({ mode, refreshToken }));
}

function decodeRefreshToken(enc: string): { mode: OAuthMode; refreshToken: string } {
  const plain = decrypt(enc);
  if (plain.startsWith('{')) {
    try {
      const parsed = JSON.parse(plain) as { mode?: OAuthMode; refreshToken?: string };
      if (parsed.refreshToken) return { mode: parsed.mode === 'paste' ? 'paste' : 'redirect', refreshToken: parsed.refreshToken };
    } catch {
      // 兼容旧版直接加密存储纯字符串 refresh_token 的记录
    }
  }
  return { mode: 'redirect', refreshToken: plain };
}

export function oauthAuthUrl(provider: OAuthProvider, state: string, loginHint?: string): string {
  const cfg = PROVIDERS[provider];
  const cli = oauthClient(provider);
  if (!cli) throw new Error(`未配置 ${cfg.label} OAuth 客户端`);
  const p = new URLSearchParams({
    client_id: cli.clientId,
    response_type: 'code',
    redirect_uri: cli.redirectUri,
    scope: cfg.scopes,
    state,
    ...cfg.extra,
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${cfg.authorize}?${p}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

async function tokenRequest(provider: OAuthProvider, cli: OAuthClient, params: Record<string, string>): Promise<TokenResponse> {
  const cfg = PROVIDERS[provider];
  const body: Record<string, string> = {
    client_id: cli.clientId,
    ...(cli.clientSecret ? { client_secret: cli.clientSecret } : {}),
    ...(cfg.scopeOnToken ? { scope: cfg.scopes } : {}),
    ...params,
  };
  const res = await fetch(cfg.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description?.split('\n')[0] || data.error || `${cfg.label} 返回 ${res.status}`);
    (err as any).oauthError = data.error;
    throw err;
  }
  return data;
}

export function extractAuthCode(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('请粘贴授权后的回调地址');
  if (/^https?:\/\//i.test(raw) || raw.includes('code=') || raw.includes('error=')) {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://localhost/?${raw.replace(/^\?/, '')}`);
    const err = url.searchParams.get('error_description') || url.searchParams.get('error');
    if (err) throw new Error(err);
    const code = url.searchParams.get('code')?.trim();
    if (!code) throw new Error('粘贴的网址里没有 code 参数，请确认复制了完整地址栏内容');
    return code;
  }
  return raw;
}

export interface OAuthGrant {
  email: string;
  name: string;
  accessToken: string;
  refreshToken: string;
  mode: OAuthMode;
  imapHost: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

/** 用授权码（或完整 localhost 回调链接）换令牌，并从 id_token 里取出邮箱地址 */
export async function exchangeOAuthCode(provider: OAuthProvider, codeOrUrl: string, forceMode?: OAuthMode): Promise<OAuthGrant> {
  const label = PROVIDERS[provider].label;
  const cli = oauthClient(provider, forceMode);
  if (!cli) throw new Error(`未配置 ${label} OAuth 客户端`);
  const code = extractAuthCode(codeOrUrl);
  const t = await tokenRequest(provider, cli, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cli.redirectUri,
  });
  if (!t.refresh_token || !t.id_token)
    throw new Error(
      provider === 'google'
        ? 'Google 没有返回刷新令牌。请到 myaccount.google.com/permissions 移除这个应用的授权后重试'
        : 'Microsoft 没有返回刷新令牌，请确认应用已勾选 offline_access 权限',
    );
  // id_token 直接来自令牌端点（TLS），这里只读取声明，不需要再验签
  const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString('utf8'));
  const email = String(claims.email || claims.preferred_username || claims.upn || '').toLowerCase();
  if (!email.includes('@')) throw new Error(`无法从 ${label} 账号获取邮箱地址`);
  const common = { email, name: claims.name || '', accessToken: t.access_token, refreshToken: t.refresh_token, mode: cli.mode };
  if (provider === 'google') return { ...common, imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true };
  return {
    ...common,
    imapHost: 'outlook.office365.com',
    smtpHost: claims.tid === CONSUMER_TENANT ? 'smtp-mail.outlook.com' : 'smtp.office365.com',
    smtpPort: 587,
    smtpSecure: false,
  };
}

const cache = new Map<number, { token: string; expires: number }>();
const pending = new Map<number, Promise<string>>();

export const forgetAccessToken = (accountId: number) => void cache.delete(accountId);

/** 取可用的访问令牌：缓存未过期直接用，否则用刷新令牌换新的（Microsoft 会同时轮换刷新令牌，Google 不会） */
export function getAccessToken(account: { id: number; oauth_refresh_enc: string | null; oauth_provider?: string | null }): Promise<string> {
  const hit = cache.get(account.id);
  if (hit && hit.expires > Date.now() + 60_000) return Promise.resolve(hit.token);
  let job = pending.get(account.id);
  if (!job) {
    job = (async () => {
      if (!account.oauth_refresh_enc) throw new Error('缺少授权信息，请重新授权');
      try {
        const provider = account.oauth_provider === 'google' ? 'google' : 'microsoft';
        const { mode, refreshToken } = decodeRefreshToken(account.oauth_refresh_enc);
        const cli = oauthClient(provider, mode) || oauthClient(provider);
        if (!cli) throw new Error(`缺少 ${PROVIDERS[provider].label} OAuth 客户端配置`);
        const t = await tokenRequest(provider, cli, { grant_type: 'refresh_token', refresh_token: refreshToken });
        if (t.refresh_token) {
          account.oauth_refresh_enc = encodeRefreshToken(t.refresh_token, mode);
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
