import mysql from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

// 所有 DATETIME 一律按 UTC 读写
export const poolOptions = {
  timezone: 'Z',
  charset: 'utf8mb4',
  connectionLimit: 10,
  // 跨地域连接数据库时握手可能要好几秒，默认 10 秒超时太紧
  connectTimeout: 30_000,
  supportBigNumbers: true,
  // 远程数据库（或中间的防火墙）会悄悄断开长时间空闲的连接：开 TCP 保活，并主动回收空闲超过 1 分钟的连接
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  maxIdle: 4,
  idleTimeout: 60_000,
} as const;

let current: mysql.Pool | null = null;

/** 连接池在第一次使用时才创建：数据库配置可能要等安装向导填完才有 */
export function getPool(): mysql.Pool {
  if (current) return current;
  if (!config.db.host) throw new Error('数据库还没有配置');
  const p = mysql.createPool({ ...config.db, ...poolOptions });
  // 会话时区也固定为 UTC，否则 DEFAULT CURRENT_TIMESTAMP 会按数据库服务器的本地时区写入
  p.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));
  return (current = p);
}

export async function closePool(): Promise<void> {
  const p = current;
  current = null;
  await p?.end().catch(() => {});
}

const LOST = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
const lost = (e: unknown) => LOST.has((e as { code?: string })?.code || '') || /Connection lost|closed state/i.test((e as Error)?.message || '');

/** 把数据库连接错误翻译成能照着处理的提示 */
export function dbHint(e: { code?: string; message?: string }): string {
  switch (e.code) {
    case 'ETIMEDOUT':
      return '连接超时：多半是数据库所在机器的防火墙 / 安全组没有放行本机，或 MySQL 只监听了 127.0.0.1';
    case 'ECONNREFUSED':
      return '连接被拒绝：地址或端口不对。注意容器里的 127.0.0.1 是容器自己，同机数据库请用 host.docker.internal';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '找不到这个主机名，请检查数据库地址';
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_DBACCESS_DENIED_ERROR':
      return '账号、密码或授权的来源主机不对';
    case 'ER_BAD_DB_ERROR':
      return '数据库不存在，请先建库';
    default:
      return '';
  }
}

type Params = unknown[];

export async function query<T = any>(sql: string, params: Params = []): Promise<T[]> {
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(sql, params);
    return rows as T[];
  } catch (e) {
    // 读操作遇到已断开的旧连接时换一个连接重试一次（写操作不重试，避免重复执行）
    if (!lost(e)) throw e;
    const [rows] = await getPool().query<RowDataPacket[]>(sql, params);
    return rows as T[];
  }
}

export async function one<T = any>(sql: string, params: Params = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function exec(sql: string, params: Params = []): Promise<ResultSetHeader> {
  const [res] = await getPool().query<ResultSetHeader>(sql, params);
  return res;
}
