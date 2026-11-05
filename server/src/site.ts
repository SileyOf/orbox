import { z } from 'zod';
import { APP_NAME, config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { exec, query } from './db.js';

// 站点级配置：品牌外观、注册策略、后台路径，以及各聊天平台 / OAuth 的凭据。
// 保存在数据库里由管理员在网页上修改；.env 里的同名配置只作为初始值和兜底。

export const siteSchema = z.object({
  name: z.string().trim().min(1).max(40),
  subtitle: z.string().trim().max(80),
  loginText: z.string().trim().max(300),
  footer: z.string().trim().max(200),
  /** data:image/... 形式，空字符串表示用默认图标 */
  logo: z.string().max(400_000).refine((v) => v === '' || /^data:image\/(png|jpeg|webp|svg\+xml|gif);base64,/.test(v), 'Logo 必须是图片'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  theme: z.enum(['system', 'light', 'dark']),
  /** 后台页面的地址，例如 admin → /admin */
  adminPath: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,39}$/, '后台路径只能包含字母、数字、- 和 _，3–40 位'),
  registration: z.enum(['open', 'invite', 'closed']),
  defaultTimezone: z.string().min(1).max(64),
  /** 允许普通用户使用管理员配置的共享模型 */
  shareAi: z.boolean(),
  /** 新用户（以及没单独设置过权限的用户）的默认权限 */
  defaultPerms: z.lazy(() => permsSchema),
});
export type SiteConfig = z.infer<typeof siteSchema>;

/** 用户权限。管理员不受限制 */
export const permsSchema = z.object({
  /** 最多添加几个邮箱，0 表示不限 */
  maxAccounts: z.number().int().min(0).max(100),
  /** 使用管理员配置的共享模型（还需要站点开启"开放共享模型"） */
  sharedAi: z.boolean(),
  /** 自己添加模型服务 */
  ownAi: z.boolean(),
  /** 绑定聊天机器人 */
  bots: z.boolean(),
  /** 生成 MCP 令牌，让外部 AI 连接 */
  mcp: z.boolean(),
  /** 允许邮箱服务器、模型接口填写内网 / 本机地址（有内网探测风险，只给信任的人） */
  privateHosts: z.boolean(),
});
export type Perms = z.infer<typeof permsSchema>;
export const DEFAULT_PERMS: Perms = { maxAccounts: 0, sharedAi: true, ownAi: true, bots: true, mcp: true, privateHosts: false };
export const ALL_PERMS: Perms = { maxAccounts: 0, sharedAi: true, ownAi: true, bots: true, mcp: true, privateHosts: true };

const RESERVED_PATHS = new Set(['mail', 'planner', 'settings', 'api', 'mcp', 'v', 'assets', 'login']);

const defaults = (): SiteConfig => ({
  name: APP_NAME,
  subtitle: '起源 · 邮件与计划',
  loginText: '',
  footer: '',
  logo: '',
  accent: '#cceb79',
  theme: 'system',
  adminPath: 'admin',
  registration: config.allowRegistration ? 'open' : 'closed',
  defaultTimezone: 'Asia/Shanghai',
  shareAi: config.ai.shared,
  defaultPerms: DEFAULT_PERMS,
});

export interface Integrations {
  telegram: { token: string; proxy: string };
  feishu: { appId: string; appSecret: string; domain: 'feishu' | 'lark' };
  discord: { token: string };
  slack: { botToken: string; appToken: string };
  microsoft: { clientId: string; clientSecret: string };
}

/** 这些字段是密钥：加密存储，返回给前端时只给掩码 */
const SECRET = new Set(['token', 'appSecret', 'botToken', 'appToken', 'clientSecret']);

const envIntegrations = (): Integrations => ({
  telegram: { token: config.telegramToken, proxy: config.telegramProxy },
  feishu: { ...config.feishu },
  discord: { token: config.discordToken },
  slack: { ...config.slack },
  microsoft: { ...config.microsoft },
});

let site: SiteConfig = defaults();
let integrations: Integrations = envIntegrations();

export const siteConfig = () => site;
export const integration = <K extends keyof Integrations>(k: K): Integrations[K] => integrations[k];

export async function loadSite(): Promise<void> {
  const rows = await query<{ k: string; v: any }>('SELECT k, v FROM site_settings');
  const saved = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  site = { ...defaults(), ...(saved.site || {}) };
  site.defaultPerms = { ...DEFAULT_PERMS, ...(saved.site?.defaultPerms || {}) };
  const env = envIntegrations();
  const db = (saved.integrations || {}) as Record<string, Record<string, string>>;
  integrations = Object.fromEntries(
    Object.entries(env).map(([platform, fields]) => {
      const stored = db[platform] || {};
      const merged: Record<string, string> = { ...fields };
      for (const [key, value] of Object.entries(stored)) {
        // 数据库里明确保存过的值优先（包括清空），否则用 .env
        merged[key] = SECRET.has(key) && value ? decrypt(value) : value;
      }
      return [platform, merged];
    }),
  ) as unknown as Integrations;
}

export async function saveSite(patch: Partial<SiteConfig>): Promise<SiteConfig> {
  const next = siteSchema.parse({ ...site, ...patch });
  if (RESERVED_PATHS.has(next.adminPath.toLowerCase())) throw new Error('这个后台路径和系统页面冲突，换一个');
  await exec('INSERT INTO site_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['site', JSON.stringify(next)]);
  site = next;
  return site;
}

/** 更新某个平台的凭据。密钥字段传 undefined 表示保持不变，空字符串表示清除 */
export async function saveIntegration<K extends keyof Integrations>(platform: K, patch: Partial<Record<keyof Integrations[K], string>>) {
  const rows = await query<{ v: any }>(`SELECT v FROM site_settings WHERE k = 'integrations'`);
  const stored: Record<string, Record<string, string>> = rows[0]?.v || {};
  const cur = { ...(stored[platform] || {}) };
  for (const [key, value] of Object.entries(patch) as [string, string | undefined][]) {
    if (value === undefined) continue;
    cur[key] = SECRET.has(key) && value ? encrypt(value.trim()) : value.trim();
  }
  stored[platform] = cur;
  await exec('INSERT INTO site_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['integrations', JSON.stringify(stored)]);
  await loadSite();
}

/** 给管理员看的集成配置：密钥只显示是否已设置和末尾几位 */
export function maskedIntegrations() {
  return Object.fromEntries(
    Object.entries(integrations).map(([platform, fields]) => [
      platform,
      Object.fromEntries(
        Object.entries(fields as Record<string, string>).map(([k, v]) =>
          SECRET.has(k) ? [k, v ? `••••${v.slice(-4)}` : ''] : [k, v],
        ),
      ),
    ]),
  );
}

/** 公开给登录页等未登录页面的站点信息（不含后台路径） */
export function publicSite() {
  const { adminPath: _hidden, logo, shareAi: _s, defaultPerms: _p, ...rest } = site;
  return { ...rest, hasLogo: !!logo };
}
