// Instance administration helpers (worker/routes/admin.ts): overview figures, owner / admin guards and workspace
// deletion. Everything here reads small tables (users, workspaces, members, apps, jobs, alerts, sessions, settings) or
// the daily rollups (`workspace_daily`); nothing scans `transactions` (Free plan read budget).

import type { AdminOverview, AdminUsage } from "../../shared/types";
import { backgroundSpent, budgets } from "./budget";
import { dbStats, type Db, type Stmt } from "./db";
import { UPDATE_SETTING, updateStatus, versionInfo, type StoredUpdate } from "./updates";
import { now, parseJson } from "./util";

const DAY = 86_400_000;
export const CRON_LAST_RUN = "cron_last_run";
/** The cron trigger runs every 5 minutes: three missed ticks make it stale. */
const CRON_STALE_MS = 15 * 60_000;

export async function adminUsage(env: Env, db: Db): Promise<AdminUsage> {
  const [stats, spent] = await Promise.all([dbStats(env), backgroundSpent(db)]);
  const b = budgets(env);
  return {
    database: stats,
    background: { rowsRead: spent.r, rowsWritten: spent.w, readBudget: b.reads, writeBudget: b.writes },
    freePlan: { rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000, resetsAt: "00:00 UTC" },
  };
}

/** Active instance admins, optionally not counting one user. */
export async function activeAdminCount(db: Db, exceptUserId = ""): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active' AND id != ?").bind(exceptUserId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Workspaces where `userId` is an owner and no other active user is. */
export async function soleOwnerWorkspaces(db: Db, userId: string): Promise<Array<{ id: string; name: string }>> {
  const { results } = await db
    .prepare(
      `SELECT w.id, w.name FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? AND m.role = 'owner' AND NOT EXISTS (
         SELECT 1 FROM workspace_members o JOIN users u ON u.id = o.user_id
         WHERE o.workspace_id = m.workspace_id AND o.role = 'owner' AND o.user_id != m.user_id AND u.status = 'active')
       ORDER BY w.name`,
    )
    .bind(userId)
    .all<{ id: string; name: string }>();
  return results;
}

export function lastOwnerMessage(who: string, workspaces: Array<{ name: string }>): string {
  const names = workspaces.map((w) => `"${w.name}"`).join(", ");
  return `${who} the last owner of ${names}. Make someone else owner or delete the workspace first.`;
}

/** Statements that end every web and iOS session of a user (and their push registrations, pairing codes, sign-in links and app sign-in requests). */
export function endSessionsStatements(db: Db, userId: string): Stmt[] {
  return [
    db.prepare("DELETE FROM devices WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM pairing_codes WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM magic_links WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM web_logins WHERE user_id = ?").bind(userId),
  ];
}

/** Tables with a workspace_id column, deleted with their workspace. */
const WORKSPACE_TABLES = [
  "transactions",
  "subscriptions",
  "customers",
  "events",
  "daily_metrics",
  "workspace_daily",
  "external_metrics",
  "sales_reports",
  "acquisition_requests",
  "acquisition_instances",
  "acquisition_daily",
  "products",
  "goals",
  "jobs",
  "alerts",
  "attributions",
  "funnels",
  "experiments",
  "credentials",
  "api_keys",
  "invitations",
  "workspace_members",
  "pairing_codes",
];

/** Deletes a workspace and everything in it, in one transaction. */
export async function deleteWorkspace(db: Db, id: string): Promise<void> {
  const byApp = (table: string) => db.prepare(`DELETE FROM ${table} WHERE app_id IN (SELECT id FROM apps WHERE workspace_id = ?)`).bind(id);
  await db.batch([
    byApp("rollup_queue"),
    byApp("apple_history_state"),
    byApp("pending_history"),
    byApp("install_links"),
    byApp("offering_configs"),
    byApp("remote_configs"),
    byApp("consumption_requests"),
    byApp("refund_settings"),
    byApp("offer_settings"),
    byApp("offer_signatures"),
    byApp("app_events"),
    byApp("app_event_days"),
    byApp("app_event_counts"),
    db.prepare("DELETE FROM experiment_daily WHERE experiment_id IN (SELECT id FROM experiments WHERE workspace_id = ?)").bind(id),
    ...WORKSPACE_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE workspace_id = ?`).bind(id)),
    db.prepare("UPDATE sessions SET workspace_id = NULL WHERE workspace_id = ?").bind(id),
    db.prepare("DELETE FROM apps WHERE workspace_id = ?").bind(id),
    db.prepare("DELETE FROM settings WHERE key = ?").bind(`data_version:${id}`),
    db.prepare("DELETE FROM workspaces WHERE id = ?").bind(id),
  ]);
}

/** GET /admin/overview: one batch (one round trip to the database object) of small aggregate queries. */
export async function adminOverview(env: Env, db: Db): Promise<AdminOverview> {
  const t = now();
  const since30 = t - 30 * DAY;
  const since7 = t - 7 * DAY;
  const day30 = new Date(since30).toISOString().slice(0, 10);
  const [users, active, workspaces, apps, keys, devices, sales, signups, logins, jobs, failed, alerts, settings] = await db.batch<any>([
    db.prepare("SELECT status, is_admin, COUNT(*) AS n FROM users GROUP BY status, is_admin"),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM users u WHERE u.status = 'active' AND (
           EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.last_used_at > ?1)
           OR EXISTS (SELECT 1 FROM api_keys k WHERE k.user_id = u.id AND k.last_used_at > ?1)
           OR u.last_login_at > ?1)`,
      )
      .bind(since30),
    db.prepare("SELECT COUNT(*) AS n FROM workspaces"),
    db.prepare("SELECT archived, COUNT(*) AS n FROM apps GROUP BY archived"),
    db.prepare("SELECT COUNT(*) AS n FROM api_keys"),
    db.prepare("SELECT COUNT(*) AS n FROM devices"),
    // One row per workspace and day (the rollups' totals): small, and the only source of sales counts here.
    db
      .prepare(
        `SELECT COALESCE(SUM(new_subscriptions + renewals + one_time_purchases), 0) AS purchases,
           COALESCE(SUM(CASE WHEN day >= ?1 THEN new_subscriptions + renewals + one_time_purchases ELSE 0 END), 0) AS purchases30,
           COALESCE(SUM(CASE WHEN day >= ?1 THEN gross_usd ELSE 0 END), 0) AS revenue30, MIN(day) AS first_day
         FROM workspace_daily`,
      )
      .bind(day30),
    db.prepare("SELECT id, name, email, created_at FROM users ORDER BY created_at DESC LIMIT 5"),
    db.prepare("SELECT id, name, email, last_login_at FROM users WHERE last_login_at IS NOT NULL ORDER BY last_login_at DESC LIMIT 5"),
    db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') OR (status = 'failed' AND updated_at > ?) GROUP BY status").bind(since7),
    db
      .prepare(
        `SELECT j.id, j.kind, j.workspace_id, w.name AS workspace_name, j.error, j.updated_at FROM jobs j
         LEFT JOIN workspaces w ON w.id = j.workspace_id WHERE j.status = 'failed' AND j.updated_at > ? ORDER BY j.updated_at DESC LIMIT 5`,
      )
      .bind(since7),
    db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL"),
    db.prepare("SELECT key, value FROM settings WHERE key IN (?, ?)").bind(UPDATE_SETTING, CRON_LAST_RUN),
  ]);
  const usage = await adminUsage(env, db);

  const counts = { users: 0, activeUsers: 0, disabledUsers: 0, admins: 0 };
  for (const r of users.results as Array<{ status: string; is_admin: number; n: number }>) {
    counts.users += r.n;
    if (r.status === "active") counts.activeUsers += r.n;
    else counts.disabledUsers += r.n;
    if (r.is_admin && r.status === "active") counts.admins += r.n;
  }
  const appRows = apps.results as Array<{ archived: number; n: number }>;
  const jobCounts = new Map((jobs.results as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]));
  const set = new Map((settings.results as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  const cron = parseJson<{ at?: number; ms?: number } | null>(set.get(CRON_LAST_RUN), null);
  const cronAt = typeof cron?.at === "number" ? cron.at : null;
  const s = sales.results[0] as { purchases: number; purchases30: number; revenue30: number; first_day: string | null };
  const n = (r: { results: unknown[] }) => (r.results[0] as { n: number } | undefined)?.n ?? 0;

  return {
    generatedAt: t,
    counts: {
      ...counts,
      activeLast30d: n(active),
      workspaces: n(workspaces),
      apps: appRows.filter((r) => !r.archived).reduce((a, r) => a + r.n, 0),
      archivedApps: appRows.filter((r) => r.archived).reduce((a, r) => a + r.n, 0),
      apiKeys: n(keys),
      devices: n(devices),
    },
    sales: { purchases: s?.purchases ?? 0, purchases30d: s?.purchases30 ?? 0, revenue30dUsd: Math.round((s?.revenue30 ?? 0) * 100) / 100, firstDay: s?.first_day ?? null },
    recentSignups: (signups.results as Array<{ id: string; name: string; email: string; created_at: number }>).map((u) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.created_at })),
    recentLogins: (logins.results as Array<{ id: string; name: string; email: string; last_login_at: number }>).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      lastLoginAt: u.last_login_at,
    })),
    jobs: {
      queued: jobCounts.get("queued") ?? 0,
      running: jobCounts.get("running") ?? 0,
      failed7d: jobCounts.get("failed") ?? 0,
      recentFailed: (failed.results as Array<{ id: string; kind: string; workspace_id: string; workspace_name: string | null; error: string | null; updated_at: number }>).map((j) => ({
        id: j.id,
        kind: j.kind,
        workspaceId: j.workspace_id,
        workspaceName: j.workspace_name,
        error: j.error,
        at: j.updated_at,
      })),
    },
    alerts: { open: n(alerts) },
    cron: { lastRunAt: cronAt, durationMs: typeof cron?.ms === "number" ? cron.ms : null, stale: cronAt === null || t - cronAt > CRON_STALE_MS },
    usage,
    version: versionInfo(),
    update: updateStatus(env, parseJson<StoredUpdate | null>(set.get(UPDATE_SETTING), null)),
  };
}
