// The alerts table: raise once per key (push on first raise), resolve by key prefix. Used by worker/lib/alerts.ts
// (revenue side) and worker/lib/insights.ts (events and funnels).

import type { Db } from "./db";
import { pushToWorkspace, type PushKind, type PushMessage, type SendBudget } from "./push";
import { newId, now } from "./util";

export interface AlertInput {
  workspaceId: string;
  appId: string | null;
  key: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  /** Localized push (loc keys); without it, no push. `kind`: the push kind (preferences), "alert" by default. */
  push?: { titleKey: string; titleArgs: string[]; bodyKey: string; bodyArgs: string[]; kind?: PushKind; data?: Record<string, unknown>; newer?: PushMessage["newer"] };
  /** Caps the APNs requests of the push (the insights cron's per-invocation budget). */
  budget?: SendBudget;
}

/** Raises an alert once per key; returns true when it is new. */
export async function raiseAlert(env: Env, db: Db, a: AlertInput): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO alerts (id, workspace_id, app_id, key, kind, severity, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, key) DO NOTHING`,
    )
    .bind(newId("alr_"), a.workspaceId, a.appId, a.key, a.kind, a.severity, a.title, a.body, now())
    .run();
  if (!res.meta.changes) return false;
  if (a.push) {
    const { kind = "alert", ...msg } = a.push;
    await pushToWorkspace(env, db, a.workspaceId, { kind, appId: a.appId, ...msg, threadId: "alerts" }, a.budget);
  }
  return true;
}

/** Resolves the open alerts whose key starts with `keyPrefix`. */
export async function resolveAlerts(db: Db, workspaceId: string, keyPrefix: string) {
  await db.prepare("UPDATE alerts SET resolved_at = ? WHERE workspace_id = ? AND key LIKE ? AND resolved_at IS NULL").bind(now(), workspaceId, `${keyPrefix}%`).run();
}

/** The funnel of a funnel_anomaly / release_regression alert (from its key). */
export function alertFunnelId(kind: string, key: string): string | null {
  if (kind !== "funnel_anomaly" && kind !== "release_regression") return null;
  return key.split(":")[1] || null;
}

/** The experiment of an experiment_result alert (from its key). */
export function alertExperimentId(kind: string, key: string): string | null {
  if (kind !== "experiment_result") return null;
  return key.split(":")[1] || null;
}
