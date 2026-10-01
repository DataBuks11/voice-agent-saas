import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "supabase", "migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply pending SQL migrations from supabase/migrations against DATABASE_URL.
 * 0001/0002 are baselined when the schema already exists (applied manually).
 */
export async function runMigrations(connectionString: string): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const baseline = await client.query(
      `select 1 from information_schema.tables where table_schema='public' and table_name='workspaces'`,
    );
    if (baseline.rowCount) {
      await client.query(
        `insert into schema_migrations(name) values ('0001_init.sql'),('0002_match.sql') on conflict do nothing`,
      );
    }
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await client.query(`select 1 from schema_migrations where name = $1`, [file]);
      if (done.rowCount) {
        skipped.push(file);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into schema_migrations(name) values ($1)`, [file]);
        await client.query("commit");
        applied.push(file);
      } catch (e) {
        await client.query("rollback");
        throw Object.assign(new Error(`migration ${file} failed: ${(e as Error).message}`), { status: 500 });
      }
    }
    return { applied, skipped };
  } finally {
    await client.end();
  }
}
