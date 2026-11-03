function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

export const APP_NAME = 'Orbox';
export const APP_VERSION = '0.4.0';

export const config = {
  port: Number(process.env.PORT || 8787),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:8787').replace(/\/$/, ''),
  db: {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database: required('DB_NAME'),
  },
  appSecret: required('APP_SECRET'),
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
