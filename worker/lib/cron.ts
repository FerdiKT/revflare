// The one cron trigger (*/5): Free accounts share 5 cron triggers across all Workers. Each tick runs inside the
// database object (one RPC) and picks its outbound work by slot so a tick stays well under the subrequest limit:
//   every tick      metrics rollups (no fetch), daily/weekly summary pushes at 09:00 local
//   slot 0 (:00, :15, :30, :45)  poll Notification History for apps whose notifications go elsewhere (RevenueCat)
//   slot 1 (:05, :20, :35, :50)  continue Transaction History backlogs and large pass-expiry recomputes
//   slot 2 (:10, :25, :40, :55)  goal-reached pushes, hourly alerts, product names, daily FX / expiry / Sales reports, daily update check (:55)
// App Analytics imports (cronAcquisition) run on slot 1 ticks as a second database call from the scheduled handler, so
// their App Store requests have a subrequest budget of their own: a few apps per tick, each app at most every 6 hours;
// report requests for new apps (and failed / stopped ones, once a day) at 01:05–01:50.
// Meta Ads (Conversions API) sends run every tick as their own database call too (sendMetaEvents: a few apps, at most
// 10 requests), and so do answers to Apple's refund requests (sendConsumptionInfo in worker/lib/refunds.ts: at most 5
// requests).
// Funnel anomaly / release regression checks and the daily digest (cronInsights in worker/lib/insights.ts) run every tick
// as their own database call too: at most 40 outbound requests (Analytics Engine SQL API, alert pushes, digest emails)
// and 10 funnels per tick, each funnel once a day; the hourly alert check (slot 2, :10) also raises events_silent from
// the "last event" notes (no queries). The same call stops experiments after 90 days and, from 02:00 UTC, snapshots each
// running experiment's daily exposures, and recomputes running experiments' results every 6 hours (at most 2 a tick,
// within the daily background budget; worker/lib/experiments.ts).
// Every tick also deletes key events past their app's retention until the day's pass is done (pruneKeyEvents: ≤ 5,000
// rows a tick through the (app_id, name, ts) index, then one settings read per tick).
// Google Play voided purchases (pollVoidedPurchases in worker/google/ingest.ts) run on slot 0 ticks from 03:00 to 05:59 UTC
// as their own database call: at most 4 Android apps a tick (≤ 6 requests each), each app once a day, metered.
// Each tick records when it ran (settings `cron_last_run`, shown in Admin → Overview): one row write per tick.

import { ensureAcquisitionRequests, syncAcquisition } from "../apple/analytics";
import { syncNotificationHistory, syncTransactionHistory } from "../apple/ingest";
import { syncSalesReports } from "../apple/sales";
import { syncProducts } from "../apple/setup";
import { checkAlerts, sendSummaries } from "./alerts";
import { checkGoalPushes } from "./goals";
import { retryAttributions } from "./attribution";
import { defineDbFunction, type Db } from "./db";
import { continuePassRecompute } from "./entitlements";
import { refreshFxRates } from "./fx";
import { queueRollup } from "./ledger";
import { expireSubscriptions, rebuildQueued } from "./rollup";
import { startJob } from "./jobs";
import { CRON_LAST_RUN } from "./admin";
import { setSetting } from "./settings";
import { pruneKeyEvents } from "./key-events";
import { updateCheckCron } from "./updates";
import { errorMessage, now } from "./util";

const HOUR = 3_600_000;

async function rollups(db: Db, limit: number) {
  const { results } = await db.prepare("SELECT app_id FROM rollup_queue ORDER BY queued_at LIMIT ?").bind(limit).all<{ app_id: string }>();
  for (const r of results) await rebuildQueued(db, r.app_id);
  return results.length;
}

export const cronTick = defineDbFunction("cronTick", async (db, args: { at: number }, env) => {
  const d = new Date(args.at);
  const minute = d.getUTCMinutes();
  const hour = d.getUTCHours();
  const slot = Math.floor(minute / 5) % 3;
  const started = now();
  const log: Record<string, unknown> = { slot };
  // Renewals Apple announced ahead of their period start count once that time has come: rebuild their day.
  const lastDue = Number((await db.prepare("SELECT value FROM settings WHERE key = 'due_checked_until'").first<{ value: string }>())?.value ?? args.at - 10 * 60_000);
  const { results: due } = await db
    .prepare(
      `SELECT DISTINCT t.app_id FROM workspaces w JOIN transactions t ON t.workspace_id = w.id AND t.purchased_at > ? AND t.purchased_at <= ?`,
    )
    .bind(lastDue, args.at)
    .all<{ app_id: string }>();
  for (const r of due) await queueRollup(db, r.app_id, new Date(args.at).toISOString().slice(0, 10));
  await db.prepare("INSERT INTO settings (key, value) VALUES ('due_checked_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(args.at)).run();

  log.rollups = await rollups(db, 25);
  // Key events older than each app's retention: once a day, at most 5,000 rows a tick (worker/lib/key-events.ts).
  const pruned = await pruneKeyEvents(db, args.at).catch((e) => ({ error: errorMessage(e) }));
  if (pruned) log.keyEvents = pruned;

  if (slot === 0) {
    // Apps whose notifications go to another server: pull what Apple sent there. Revflare-connected apps are
    // re-checked every 6 hours to catch anything a failed delivery missed.
    const { results: apps } = await db
      .prepare(
        `SELECT id FROM apps WHERE archived = 0 AND platform = 'ios' AND bundle_id IS NOT NULL AND workspace_id IN (SELECT workspace_id FROM credentials WHERE kind = 'appstore_iap')
           AND history_backfilled_from IS NOT NULL
           AND (notification_url_status = 'other' OR (notification_url_status = 'revflare' AND COALESCE(last_history_sync_at, 0) < ?))
         ORDER BY COALESCE(last_history_sync_at, 0) LIMIT 8`,
      )
      .bind(now() - 6 * HOUR)
      .all<{ id: string }>();
    let processed = 0;
    for (const a of apps) {
      const r = await syncNotificationHistory(env, { appId: a.id, maxRequests: 4 });
      processed += r.processed;
      const key = `history_error:${a.id}`;
      if (r.error && r.error !== "rate_limited") await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, r.error).run();
      else if (!r.error) await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
    }
    log.polled = { apps: apps.length, processed };
  } else if (slot === 1) {
    const app = await db.prepare("SELECT app_id FROM pending_history ORDER BY created_at LIMIT 1").first<{ app_id: string }>();
    if (app) log.transactions = await syncTransactionHistory(env, { appId: app.app_id, maxRequests: 30, background: true });
    // Pass expiries left over by a large month / year duration change (worker/lib/entitlements.ts): one batch, metered.
    const passes = await continuePassRecompute(db, env).catch((e) => errorMessage(e));
    if (passes) log.passes = passes;
  } else {
    log.attributions = await retryAttributions(env, { limit: 20 }).catch((e) => errorMessage(e));
    if (minute >= 10 && minute < 15) log.alerts = await checkAlerts(env, {}).catch((e) => errorMessage(e));
    // Goals reached (notify): once per period, from the cached goal lists (worker/lib/goals.ts), metered.
    log.goals = await checkGoalPushes(env, {}).catch((e) => errorMessage(e));
    const { results: workspaces } = await db.prepare("SELECT DISTINCT workspace_id FROM credentials WHERE kind IN ('appstore_connect', 'appstore_reports')").all<{ workspace_id: string }>();
    if (minute >= 40 && minute < 45) {
      for (const w of workspaces) log.products = await syncProducts(env, { workspaceId: w.workspace_id, limit: 4 }).catch((e) => errorMessage(e));
    }
    if (hour === 0 && minute >= 10 && minute < 15) {
      log.fx = await refreshFxRates(env, {}).catch((e) => errorMessage(e));
      log.expired = await expireSubscriptions(env, {});
      // A new day: every app gets a row for today (MRR and actives carry over) and yesterday is closed at its end
      // (today's row is measured at the time of the rollup, worker/lib/rollup.ts). Sundays rebuild everything, which
      // also reclassifies transactions that arrived out of order.
      const full = d.getUTCDay() === 0;
      await db
        .prepare(
          `INSERT INTO rollup_queue (app_id, queued_at, from_day) SELECT id, ?, ? FROM apps WHERE archived = 0
           ON CONFLICT(app_id) DO UPDATE SET from_day = CASE WHEN rollup_queue.from_day IS NULL OR excluded.from_day IS NULL THEN NULL ELSE MIN(rollup_queue.from_day, excluded.from_day) END`,
        )
        .bind(now(), full ? null : new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10))
        .run();
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
        db.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").bind(now() - HOUR),
        db.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(now()),
        db.prepare("DELETE FROM web_logins WHERE expires_at < ?").bind(now() - HOUR),
        db.prepare("DELETE FROM settings WHERE (key LIKE 'login_fail:%' OR key LIKE 'mail\\_link:%' ESCAPE '\\' OR key LIKE 'app\\_login:%' ESCAPE '\\') AND json_extract(value, '$.until') < ?").bind(now()),
      ]);
    }
    // Apps never backfilled (e.g. a backfill stopped by the daily quota): a few per night, so the one-time imports
    // spread over several days of the Free plan's write budget.
    if (hour === 0 && minute >= 25 && minute < 30) {
      const { results: todo } = await db
        .prepare(
          `SELECT a.id, a.workspace_id FROM apps a WHERE a.archived = 0 AND a.platform = 'ios' AND a.bundle_id IS NOT NULL AND a.history_backfilled_from IS NULL
             AND COALESCE(a.store_available, 1) = 1 AND a.workspace_id IN (SELECT workspace_id FROM credentials WHERE kind = 'appstore_iap')
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id = a.workspace_id AND j.kind = 'apple_backfill' AND j.status IN ('queued', 'running')
                             AND j.params = '{"appId":"' || a.id || '"}')
           LIMIT 6`,
        )
        .all<{ id: string; workspace_id: string }>();
      for (const a of todo) await startJob(env, db, a.workspace_id, "apple_backfill", { appId: a.id }, null);
      log.backfills = todo.length;
    }
    // Apple publishes yesterday's Sales and Trends report in the (Pacific) morning: try a few times a day.
    if ([9, 13, 17].includes(hour) && minute >= 25 && minute < 30) {
      for (const w of workspaces) log.sales = await syncSalesReports(env, { workspaceId: w.workspace_id, days: 7, maxRequests: 7 }).catch((e) => errorMessage(e));
    }
  }
  // GitHub release check: one request a day at most (worker/lib/updates.ts); never throws.
  if (slot === 2 && minute >= 55 && env.TEST_MODE !== "true") {
    const update = await updateCheckCron(env, db).catch(() => null);
    if (update) log.update = update.status;
  }
  log.summaries = await sendSummaries(env, {}).catch((e) => errorMessage(e));
  await setSetting(db, CRON_LAST_RUN, JSON.stringify({ at: started, ms: now() - started }));
  return log;
});

/**
 * Google Play voided purchases (refunds RTDN missed): slot 0 ticks from 03:00 to 05:59 UTC, as a database call of its
 * own from the scheduled handler (own subrequest budget), at most 4 Android apps a tick, each app once a day.
 */
export function voidedDue(at: number): boolean {
  const d = new Date(at);
  return Math.floor(d.getUTCMinutes() / 5) % 3 === 0 && d.getUTCHours() >= 3 && d.getUTCHours() < 6;
}

/** Slot 1 ticks (:05, :20, :35, :50). */
export function acquisitionDue(at: number): boolean {
  return Math.floor(new Date(at).getUTCMinutes() / 5) % 3 === 1;
}

export const cronAcquisition = defineDbFunction("cronAcquisition", async (db, args: { at: number }, env) => {
  const log: Record<string, unknown> = {};
  if (new Date(args.at).getUTCHours() === 1) {
    const { results: workspaces } = await db
      .prepare("SELECT DISTINCT workspace_id FROM credentials WHERE kind IN ('appstore_connect', 'appstore_reports')")
      .all<{ workspace_id: string }>();
    const requests: Record<string, unknown> = {};
    for (const w of workspaces) {
      const r = await ensureAcquisitionRequests(env, { workspaceId: w.workspace_id, limit: 6, retry: false }).catch((e) => ({ error: errorMessage(e) }));
      requests[w.workspace_id] = "created" in r ? { created: r.created.length, existing: r.existing.length, failed: r.failed.length, remaining: r.remaining } : r;
    }
    log.requests = requests;
  }
  const r = await syncAcquisition(env, { maxApps: 3, maxRequests: 40, minAgeMs: 6 * HOUR }).catch((e) => ({ error: errorMessage(e) }));
  log.sync = "apps" in r ? { apps: r.apps, requests: r.requests, instances: r.instances, rows: r.rows, more: r.more, errors: r.errors.length, budget: r.budget } : r;
  return log;
});
