import mysql from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

// 所有 DATETIME 一律按 UTC 读写
export const pool = mysql.createPool({
  ...config.db,
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
});

const LOST = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
const lost = (e: unknown) => LOST.has((e as { code?: string })?.code || '') || /Connection lost|closed state/i.test((e as Error)?.message || '');

// 会话时区也固定为 UTC，否则 DEFAULT CURRENT_TIMESTAMP 会按数据库服务器的本地时区写入
pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

type Params = unknown[];

export async function query<T = any>(sql: string, params: Params = []): Promise<T[]> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return rows as T[];
  } catch (e) {
    // 读操作遇到已断开的旧连接时换一个连接重试一次（写操作不重试，避免重复执行）
    if (!lost(e)) throw e;
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return rows as T[];
  }
}

export async function one<T = any>(sql: string, params: Params = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function exec(sql: string, params: Params = []): Promise<ResultSetHeader> {
  const [res] = await pool.query<ResultSetHeader>(sql, params);
  return res;
}
