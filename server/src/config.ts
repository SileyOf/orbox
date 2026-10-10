function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

export const APP_NAME = 'Orbox';
export const APP_VERSION = '0.1.1';

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
  microsoft: {
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
  },
};
