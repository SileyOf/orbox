import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closePool, exec, query } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const ALREADY_APPLIED = new Set(['ER_TABLE_EXISTS_ERROR', 'ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_FK_DUP_NAME', 'ER_CANT_DROP_FIELD_OR_KEY', 'ER_BAD_TABLE_ERROR']);

export async function migrate(): Promise<void> {
  await exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name VARCHAR(190) PRIMARY KEY,
       applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`,
  );
  const done = new Set((await query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
      try {
        await exec(stmt);
      } catch (e: any) {
        // MySQL 的建表 / 加字段不能放进事务：如果上次执行到一半中断（断电、数据库掉线），
        // 重跑时前面已经生效的语句会报"已存在"。这类错误说明这一步做过了，跳过继续，而不是永远卡在启动上。
        if (!ALREADY_APPLIED.has(e?.code)) throw new Error(`迁移 ${file} 失败：${e?.message || e}`);
        console.warn(`[migrate] ${file}：${e.code}，这一步之前已经执行过，跳过`);
      }
    }
    await exec('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    console.log(`[migrate] applied ${file}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => closePool())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
