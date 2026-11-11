// Applies migrations/*.sql on first use: inside the database Durable Object when it starts (worker/lib/db.ts), or on
// the first request for a bound D1 database. Uses wrangler's d1_migrations table so both stay in sync.
import type { Db } from "./db";

const files = import.meta.glob("../../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n']*$/gm, "")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Applies pending migrations. */
export async function migrate(db: Db) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    )
    .run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    await db.batch([
      ...splitStatements(m.sql).map((s) => db.prepare(s)),
      db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(m.name),
    ]);
  }
}

const ready = new WeakMap<object, Promise<void>>();

/** For a bound D1 database: migrate once per isolate. The Durable Object database migrates itself. */
export function ensureSchema(env: Env): Promise<void> {
  if (!env.D1) return Promise.resolve();
  let p = ready.get(env.D1);
  if (!p) {
    p = migrate(env.D1 as unknown as Db).catch((err) => {
      ready.delete(env.D1!);
      throw err;
    });
    ready.set(env.D1, p);
  }
  return p;
}
