// Alerts (silent notification URL, failing syncs, refund spikes, revenue drops, app events gone silent) and the daily /
// weekly summary pushes. Run from the cron inside the database object. Funnel anomaly / release regression alerts and the
// daily digest need Analytics Engine queries: worker/lib/insights.ts, a database call of their own.

import { defineDbFunction } from "./db";
import { FxCache, addDays, dayOf } from "./money";
import { raiseAlert, resolveAlerts } from "./alert-store";
import { digestPushLine, readDigest, type Digest } from "./digest";
import { checkEventSilence, writeLedgerDigest } from "./insights";
import { formatMoney, localParts, parsePrefs, PUSH_VERSION_FUNNEL, PUSH_VERSION_PLAY, pushToDevice } from "./push";
import { now } from "./util";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const raise = raiseAlert;
const resolve = resolveAlerts;

export const checkAlerts = defineDbFunction("checkAlerts", async (db, _args: Record<string, never>, env) => {
  const t = now();
  let raised = 0;
  const { results: apps } = await db
    .prepare(
      `SELECT a.id, a.workspace_id, a.name, a.platform, a.notification_url_status, a.last_notification_at, a.last_history_sync_at,
         (SELECT COUNT(*) FROM events e WHERE e.app_id = a.id AND e.source = CASE a.platform WHEN 'android' THEN 'google_play' WHEN 'web' THEN 'polar' ELSE 'webhook' END AND e.received_at > ?) AS week_events
       FROM apps a WHERE a.archived = 0`,
    )
    .bind(t - 7 * DAY)
    .all<{ id: string; workspace_id: string; name: string; platform: string; notification_url_status: string; last_notification_at: number | null; last_history_sync_at: number | null; week_events: number }>();
  for (const a of apps) {
    // Notifications stopped: an app that usually gets several a day has been silent for a day (or 5x its usual gap).
    // App Store apps whose notification URL is Revflare's; Android apps once Google Play RTDNs arrive (Pub/Sub push).
    const android = a.platform === "android";
    if ((android || a.notification_url_status === "revflare") && a.week_events >= 7 && a.last_notification_at) {
      const usualGap = (7 * DAY) / a.week_events;
      const silent = t - a.last_notification_at;
      const key = `silent:${a.id}`;
      if (silent > Math.max(DAY, 5 * usualGap)) {
        const hours = String(Math.round(silent / HOUR));
        if (
          await raise(env, db, {
            workspaceId: a.workspace_id,
            appId: a.id,
            key: `${key}:${dayOf(a.last_notification_at)}`,
            kind: "notifications_silent",
            severity: "warning",
            title: android ? `No Google Play notifications from ${a.name}` : `No App Store notifications from ${a.name}`,
            body: android
              ? `Nothing arrived for ${hours} hours although ${a.name} usually gets ${Math.round(a.week_events / 7)} a day. Check the Pub/Sub push subscription of the app's real-time developer notifications topic (Play Console → Monetization setup).`
              : `Nothing arrived for ${hours} hours although ${a.name} usually gets ${Math.round(a.week_events / 7)} a day. Check the notification URL in App Store Connect.`,
            push: {
              titleKey: "PUSH_TITLE_ALERT_SILENT",
              titleArgs: [a.name],
              bodyKey: "PUSH_BODY_ALERT_SILENT",
              bodyArgs: [hours],
              // Builds that know the Google Play text get it.
              ...(android ? { newer: { pushVersion: PUSH_VERSION_PLAY, bodyKey: "PUSH_BODY_ALERT_SILENT_PLAY", bodyArgs: [hours] } } : {}),
            },
          })
        )
          raised++;
      } else await resolve(db, a.workspace_id, key);
    }
    // History polling failing for apps whose notifications go elsewhere.
    if (a.notification_url_status === "other") {
      const err = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(`history_error:${a.id}`).first<{ value: string }>();
      const key = `sync:${a.id}`;
      if (err && (!a.last_history_sync_at || t - a.last_history_sync_at < DAY)) {
        if (
          await raise(env, db, {
            workspaceId: a.workspace_id,
            appId: a.id,
            key: `${key}:${dayOf(t)}`,
            kind: "sync_failing",
            severity: "warning",
            title: `Syncing ${a.name} from Apple fails`,
            body: err.value,
          })
        )
          raised++;
      } else if (!err) await resolve(db, a.workspace_id, key);
    }
  }

  // App events gone silent (no Analytics Engine query: the per-app "last event received" notes).
  const silence = await checkEventSilence(env, db, t);
  raised += silence.raised;

  // Per workspace: refund spike and revenue drop (yesterday vs the 14 days before).
  const { results: workspaces } = await db.prepare("SELECT id, currency FROM workspaces").all<{ id: string; currency: string }>();
  const yesterday = dayOf(t - DAY);
  for (const ws of workspaces) {
    const stats = await db
      .prepare(
        `SELECT SUM(CASE WHEN day = ? THEN gross_usd ELSE 0 END) AS y_rev, SUM(CASE WHEN day < ? THEN gross_usd ELSE 0 END) / 14.0 AS avg_rev,
           SUM(CASE WHEN day = ? THEN refunds ELSE 0 END) AS y_ref, SUM(CASE WHEN day < ? THEN refunds ELSE 0 END) / 14.0 AS avg_ref
         FROM daily_metrics WHERE workspace_id = ? AND day >= ? AND day <= ?`,
      )
      .bind(yesterday, yesterday, yesterday, yesterday, ws.id, addDays(yesterday, -14), yesterday)
      .first<{ y_rev: number | null; avg_rev: number | null; y_ref: number | null; avg_ref: number | null }>();
    if (!stats) continue;
    const fx = new FxCache(db);
    const rate = await fx.perUsd(ws.currency, dayOf(t));
    if ((stats.avg_rev ?? 0) >= 20 && (stats.y_rev ?? 0) < 0.4 * (stats.avg_rev ?? 0)) {
      const y = formatMoney((stats.y_rev ?? 0) * rate, ws.currency);
      const avg = formatMoney((stats.avg_rev ?? 0) * rate, ws.currency);
      if (
        await raise(env, db, {
          workspaceId: ws.id,
          appId: null,
          key: `revenue_drop:${yesterday}`,
          kind: "revenue_drop",
          severity: "warning",
          title: "Revenue dropped yesterday",
          body: `Yesterday brought ${y}, against ${avg} a day over the previous two weeks.`,
          push: { titleKey: "PUSH_TITLE_ALERT_DROP", titleArgs: [], bodyKey: "PUSH_BODY_ALERT_DROP", bodyArgs: [y, avg] },
        })
      )
        raised++;
    }
    if ((stats.y_ref ?? 0) >= 3 && (stats.y_ref ?? 0) > 3 * Math.max(0.5, stats.avg_ref ?? 0)) {
      const n = String(stats.y_ref);
      if (
        await raise(env, db, {
          workspaceId: ws.id,
          appId: null,
          key: `refund_spike:${yesterday}`,
          kind: "refund_spike",
          severity: "warning",
          title: "Unusual number of refunds",
          body: `${n} refunds yesterday, against ${(stats.avg_ref ?? 0).toFixed(1)} a day on average.`,
          push: { titleKey: "PUSH_TITLE_ALERT_REFUNDS", titleArgs: [], bodyKey: "PUSH_BODY_ALERT_REFUNDS", bodyArgs: [n] },
        })
      )
        raised++;
    }
  }
  return { raised };
});

/**
 * Daily (09:00 local) and weekly (Monday 09:00 local) summaries, per device. Called every 5 minutes; a device gets
 * each summary once (settings key per device and day).
 */
export const sendSummaries = defineDbFunction("sendSummaries", async (db, args: { at?: number }, env) => {
  const t = args.at ?? now();
  const { results: devices } = await db
    .prepare(
      `SELECT d.id, d.user_id, d.prefs, d.apns_token, d.environment, d.activity_token FROM devices d`,
    )
    .all<{ id: string; user_id: string; prefs: string; apns_token: string; environment: string; activity_token: string | null }>();
  let sent = 0;
  const digests = new Map<string, Promise<Digest | null>>();
  const digestOf = (wsId: string, day: string) => {
    const k = `${wsId}:${day}`;
    if (!digests.has(k))
      digests.set(
        k,
        readDigest(db, wsId, day).then((d) =>
          // A finished UTC day without a digest yet (this tick runs alongside the insights cron): its ledger part now.
          d || day >= dayOf(t) ? d : writeLedgerDigest(env, db, wsId, day, t),
        ),
      );
    return digests.get(k)!;
  };
  /** The device's "yesterday", else the latest digest with event metrics of the 3 days before (labelled with its day). */
  const digestsFor = (wsId: string, day: string) => Promise.all([0, 1, 2, 3].map((i) => digestOf(wsId, addDays(day, -i))));
  for (const d of devices) {
    const prefs = parsePrefs(d.prefs);
    if (!prefs.dailySummary && !prefs.weeklySummary) continue;
    const local = localParts(prefs.timezone || "UTC", t);
    if (local.hm < "09:00" || local.hm >= "09:10") continue;
    const markKey = `summary_sent:${d.id}:${local.day}`;
    const marked = await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(markKey, String(t)).run();
    if (!marked.meta.changes) continue;
    const { results: memberships } = await db
      .prepare("SELECT w.id, w.name, w.currency FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ?")
      .bind(d.user_id)
      .all<{ id: string; name: string; currency: string }>();
    for (const ws of memberships) {
      const fx = new FxCache(db);
      const rate = await fx.perUsd(ws.currency, dayOf(t));
      const yesterday = addDays(local.day, -1);
      const weekly = prefs.weeklySummary && local.weekday === "Mon";
      if (!prefs.dailySummary && !weekly) continue;
      const from = weekly ? addDays(yesterday, -6) : yesterday;
      const prevFrom = weekly ? addDays(from, -7) : addDays(from, -1);
      const s = await db
        .prepare(
          `SELECT SUM(CASE WHEN day >= ? THEN gross_usd ELSE 0 END) AS rev, SUM(CASE WHEN day < ? THEN gross_usd ELSE 0 END) AS prev,
             SUM(CASE WHEN day >= ? THEN new_subscriptions + renewals + one_time_purchases ELSE 0 END) AS sales,
             SUM(CASE WHEN day = ? THEN mrr_usd ELSE 0 END) AS mrr
           FROM daily_metrics WHERE workspace_id = ? AND day >= ? AND day <= ?`,
        )
        .bind(from, from, from, yesterday, ws.id, prevFrom, yesterday)
        .first<{ rev: number | null; prev: number | null; sales: number | null; mrr: number | null }>();
      if (!s || (!s.rev && !s.mrr)) continue;
      const change = s.prev ? Math.round((((s.rev ?? 0) - s.prev) / s.prev) * 100) : null;
      // Daily: one more line from the workspace's digest (computed once per workspace, worker/lib/digest.ts) when it
      // has event metrics: "Installs 1.2K (+8%) · trials 46". Only builds that know the *_DIGEST loc-keys get it: older
      // ones would show an unknown key raw, so they keep the plain summary.
      const digestLine = !weekly && prefs.pushVersion >= PUSH_VERSION_FUNNEL;
      const line = digestLine ? digestPushLine(await digestsFor(ws.id, yesterday), yesterday, prefs.locale) : null;
      const ok = await pushToDevice(env, db, d, {
        kind: "summary",
        titleKey: weekly ? "PUSH_TITLE_WEEKLY" : "PUSH_TITLE_DAILY",
        titleArgs: [ws.name],
        bodyKey: (change === null ? "PUSH_BODY_SUMMARY" : "PUSH_BODY_SUMMARY_CHANGE") + (line ? "_DIGEST" : ""),
        bodyArgs: [
          formatMoney((s.rev ?? 0) * rate, ws.currency, prefs.locale),
          String(s.sales ?? 0),
          formatMoney((s.mrr ?? 0) * rate, ws.currency, prefs.locale),
          ...(change === null ? [] : [`${change >= 0 ? "+" : ""}${change}%`]),
          ...(line ? [line.installs, line.change, line.trials, line.label] : []),
        ],
        threadId: "summary",
      });
      if (ok) sent++;
    }
  }
  // Forget old markers.
  await db.prepare("DELETE FROM settings WHERE key LIKE 'summary_sent:%' AND CAST(value AS INTEGER) < ?").bind(t - 3 * DAY).run();
  return { sent };
});
