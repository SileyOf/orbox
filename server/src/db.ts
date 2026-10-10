import mysql from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

// 所有 DATETIME 一律按 UTC 读写
export const pool = mysql.createPool({
  ...config.db,
  timezone: 'Z',
  charset: 'utf8mb4',
  connectionLimit: 10,
  supportBigNumbers: true,
});

// 会话时区也固定为 UTC，否则 DEFAULT CURRENT_TIMESTAMP 会按数据库服务器的本地时区写入
pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

type Params = unknown[];

export async function query<T = any>(sql: string, params: Params = []): Promise<T[]> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows as T[];
}

export async function one<T = any>(sql: string, params: Params = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function exec(sql: string, params: Params = []): Promise<ResultSetHeader> {
  const [res] = await pool.query<ResultSetHeader>(sql, params);
  return res;
}
