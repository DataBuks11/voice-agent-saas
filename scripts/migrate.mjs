/**
 * Minimal SQL runner for supabase/migrations/*.sql against DATABASE_URL.
 * Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  // 0001/0002 were applied manually via the Supabase SQL editor — baseline them.
  const baseline = await client.query(`select 1 from information_schema.tables where table_schema='public' and table_name='workspaces'`);
  if (baseline.rowCount) {
    await client.query(`insert into schema_migrations(name) values ('0001_init.sql'),('0002_match.sql') on conflict do nothing`);
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await client.query(`select 1 from schema_migrations where name = $1`, [f]);
    if (done.rowCount) {
      console.log(`skip  ${f}`);
      continue;
    }
    const sql = await readFile(path.join(dir, f), "utf8");
    console.log(`apply ${f} ...`);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(`insert into schema_migrations(name) values ($1)`, [f]);
      await client.query("commit");
      console.log(`ok    ${f}`);
    } catch (e) {
      await client.query("rollback");
      console.error(`FAIL  ${f}: ${e.message}`);
      process.exit(1);
    }
  }
  console.log("migrations complete");
} finally {
  await client.end();
}
