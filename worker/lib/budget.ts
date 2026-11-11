// Daily budget for background work (backfills, history polling, imports) in the Durable Object database. The Workers
// Free plan allows 5M rows read and 100k rows written a day; background work may use part of it so live sales and the
// apps always have room. Counts persist in settings (`bg:<day>`), measured with the object's row counters.

import type { Db } from "./db";
import { usage } from "./db";
import { dayOf } from "./money";
import { now, parseJson } from "./util";

/** Defaults fit the Free plan; on Workers Paid raise them with the BACKGROUND_WRITES_PER_DAY / _READS_ vars. */
export const BACKGROUND_WRITES_PER_DAY = 55_000;
export const BACKGROUND_READS_PER_DAY = 2_500_000;

export function budgets(env: Env): { writes: number; reads: number } {
  return {
    writes: Number(env.BACKGROUND_WRITES_PER_DAY) || BACKGROUND_WRITES_PER_DAY,
    reads: Number(env.BACKGROUND_READS_PER_DAY) || BACKGROUND_READS_PER_DAY,
  };
}

interface Spent {
  w: number;
  r: number;
}

const key = () => `bg:${dayOf(now())}`;

export async function backgroundSpent(db: Db): Promise<Spent> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key()).first<{ value: string }>();
  return parseJson<Spent>(row?.value, { w: 0, r: 0 });
}

/** False once today's background budget is used up (the work resumes after 00:00 UTC). */
export async function backgroundAllowed(db: Db, env: Env): Promise<boolean> {
  const s = await backgroundSpent(db);
  const b = budgets(env);
  return s.w < b.writes && s.r < b.reads;
}

/**
 * Runs background work and adds the rows it read / wrote to today's count. `prune: false` skips forgetting old days
 * (frequent small work such as key-event ingest: another metered call does it).
 */
export async function metered<T>(db: Db, work: () => Promise<T>, opts: { prune?: boolean } = {}): Promise<T> {
  const w0 = usage.rowsWritten;
  const r0 = usage.rowsRead;
  try {
    return await work();
  } finally {
    const dw = usage.rowsWritten - w0;
    const dr = usage.rowsRead - r0;
    if (dw || dr) {
      const k = key();
      await db
        .prepare(
          `INSERT INTO settings (key, value) VALUES (?, json_object('w', ?, 'r', ?)) ON CONFLICT(key) DO UPDATE SET
           value = json_object('w', json_extract(value, '$.w') + ?, 'r', json_extract(value, '$.r') + ?)`,
        )
        .bind(k, dw, dr, dw, dr)
        .run();
      // Forget old days.
      if (opts.prune !== false) await db.prepare("DELETE FROM settings WHERE key LIKE 'bg:%' AND key < ?").bind(`bg:${dayOf(now() - 7 * 86_400_000)}`).run();
    }
  }
}
