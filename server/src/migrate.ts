import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { exec, pool, query } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

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
      await exec(stmt);
    }
    await exec('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    console.log(`[migrate] applied ${file}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
