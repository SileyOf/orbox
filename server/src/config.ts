import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 配置来源：环境变量（.env）优先，其次是安装向导写入数据目录的 config.json。
// 两边都没有数据库配置时，启动后进入"首次安装"页面，由用户在网页里填写。

/** 数据目录：保存安装向导写入的配置。Docker 里是 /app/data，需要挂载卷才能在重建容器后保留 */
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

interface SavedConfig {
  db?: { host: string; port: number; user: string; password: string; database: string };
  appSecret?: string;
  publicUrl?: string;
}

function readSaved(): SavedConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as SavedConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[config] 读取 ${CONFIG_FILE} 失败：${(e as Error).message}`);
    return {};
  }
}
let saved = readSaved();
const env = process.env;

export const APP_NAME = 'Orbox';
export const APP_VERSION = '0.6.0';

export const config = {
  port: Number(process.env.PORT || 8787),
  publicUrl: normalizePublicUrl(env.PUBLIC_URL || saved.publicUrl),
  db: {
    host: env.DB_HOST || saved.db?.host || '',
    port: Number(env.DB_PORT || saved.db?.port || 3306),
    user: env.DB_USER || saved.db?.user || '',
    password: env.DB_HOST ? env.DB_PASSWORD || '' : (saved.db?.password ?? ''),
    database: env.DB_NAME || saved.db?.database || '',
  },
  appSecret: env.APP_SECRET || saved.appSecret || '',
  /** 哪些配置来自环境变量（网页里不能改，只能改 .env） */
  fromEnv: { db: !!env.DB_HOST, appSecret: !!env.APP_SECRET, publicUrl: !!env.PUBLIC_URL },
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramProxy: process.env.TELEGRAM_PROXY || '',
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    /** feishu（国内飞书）或 lark（海外版） */
    domain: (process.env.FEISHU_DOMAIN || 'feishu') as 'feishu' | 'lark',
  },
  discordToken: process.env.DISCORD_BOT_TOKEN || '',
  slack: { botToken: process.env.SLACK_BOT_TOKEN || '', appToken: process.env.SLACK_APP_TOKEN || '' },
  /** 服务器默认 AI 配置；AI_SHARED=true 时没有自己配置的用户也能使用 */
  ai: {
    provider: (process.env.AI_PROVIDER || '') as '' | 'anthropic' | 'openai',
    baseUrl: process.env.AI_BASE_URL || '',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || (process.env.AI_PROVIDER === 'openai' ? 'gpt-5' : 'claude-opus-5-5'),
    fastModel: process.env.AI_FAST_MODEL || '',
    shared: process.env.AI_SHARED === 'true',
  },
  microsoft: {
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
  },
};

/**
 * PUBLIC_URL 只写了域名（例如 orbox.example.com）时自动补上协议：本机地址补 http://，其余补 https://。
 * 同时去掉末尾的斜杠和路径，避免拼链接时出错。
 */
function normalizePublicUrl(raw?: string): string {
  let v = (raw || '').trim() || 'http://localhost:8787';
  if (!/^https?:\/\//i.test(v)) {
    const local = /^(localhost|127\.|\[?::1\]?|0\.0\.0\.0)/i.test(v);
    v = `${local ? 'http' : 'https'}://${v}`;
    console.warn(`[config] PUBLIC_URL 缺少 http:// 或 https://，已按 ${v} 处理，建议在 .env 里写完整`);
  }
  try {
    return new URL(v).origin;
  } catch {
    throw new Error(`PUBLIC_URL 格式不对：${raw}，应写成 https://你的域名`);
  }
}

/** 数据库和密钥都已配置（来自 .env 或安装向导） */
export const isConfigured = () => !!(config.db.host && config.db.user && config.db.database && config.appSecret);

/** 安装向导 / 后台保存配置：写入数据目录的 config.json（仅属主可读写），并立即生效 */
export function saveConfig(patch: SavedConfig): void {
  const next: SavedConfig = { ...saved, ...patch };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
  saved = next;
  if (patch.db && !config.fromEnv.db) Object.assign(config.db, patch.db);
  if (patch.appSecret && !config.fromEnv.appSecret) config.appSecret = patch.appSecret;
  if (patch.publicUrl && !config.fromEnv.publicUrl) config.publicUrl = normalizePublicUrl(patch.publicUrl);
}

/** 安装中途失败时撤销已写入的配置，回到未安装状态 */
export function clearSavedConfig(): void {
  rmSync(CONFIG_FILE, { force: true });
  saved = {};
  if (!config.fromEnv.db) Object.assign(config.db, { host: '', port: 3306, user: '', password: '', database: '' });
  if (!config.fromEnv.appSecret) config.appSecret = '';
}

/**
 * 数据目录是否是挂载的卷。只在 Docker 里判断（和根文件系统不在同一个设备上即认为已挂载）；
 * 其他环境返回 null 表示不适用。没挂载时容器重建会丢失 config.json 里的密钥，邮箱密码将无法解密。
 */
export function dataDirPersistent(): boolean | null {
  if (!env.ORBOX_DOCKER) return null;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    return statSync(DATA_DIR).dev !== statSync('/').dev;
  } catch {
    return false;
  }
}

export const normalizeUrl = normalizePublicUrl;
