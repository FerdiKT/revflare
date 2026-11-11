// Read endpoints: overview, charts, breakdowns, feed, customers, at-risk, forecast, cohorts, reconciliation, goals, alerts.
import { alertExperimentId, alertFunnelId } from "../lib/alert-store";
import { Hono, type Context } from "hono";
import { INSTALL_SOURCES, LTV_DIMENSIONS, METRICS, type Alert, type Interval, type LtvCohortUnit, type LtvDimension, type Metric } from "../../shared/types";
import { reconciliation } from "../apple/sales";
import { listAdsNames, parseAdsNames, putAdsNames } from "../lib/ads-names";
import { attributedRevenue } from "../lib/attribution";
import { isInstallSource } from "../lib/test-data";
import { ltv, ltvSummary } from "../lib/ltv";
import { requirePermission, wsId, type AppEnv } from "../lib/auth";
import { atRisk, breakdown, bumpDataVersion, chart, cohorts, customer, forecast, goalsList, mrrMovement, overview, transactions, type Scope } from "../lib/metrics";
import { GOAL_COLUMNS, GOAL_METRIC_INFO, GOALS_MAX, parseGoalInput, rowScope, rowValues, sameAppSet, sameTarget, unknownApps, type GoalRow, type GoalValues } from "../lib/goals";
import { FxCache, addDays, dayOf } from "../lib/money";
import { newId, now } from "../lib/util";

export const metricRoutes = new Hono<AppEnv>();
const read = requirePermission("read");

type Ctx = Context<AppEnv>;

const isDay = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function scope(c: Ctx): Scope {
  const apps = c.req.query("apps") ?? c.req.query("app");
  const currency = c.req.query("currency");
  return {
    workspaceId: wsId(c),
    appIds: apps ? apps.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60) : null,
    ...(currency && /^[A-Za-z]{3}$/.test(currency) ? { currency: currency.toUpperCase() } : {}),
  };
}

/** from/to (YYYY-MM-DD, inclusive). Default: the last `days` days (or `range=7d|28d|30d|90d|12m|ytd|all`). */
export function range(c: Ctx, defaultDays = 30): { from: string; to: string } {
  const today = dayOf(now());
  const to = isDay(c.req.query("to")) ? c.req.query("to")! : today;
  if (isDay(c.req.query("from"))) {
    const from = c.req.query("from")!;
    return from <= to ? { from, to } : { from: to, to: from };
  }
  const r = c.req.query("range");
  const m = /^(\d+)([dm])$/.exec(r ?? "");
  if (m) return { from: m[2] === "d" ? addDays(to, -(Number(m[1]) - 1)) : addDays(to, -Math.round(Number(m[1]) * 30.44) + 1), to };
  if (r === "ytd") return { from: `${to.slice(0, 4)}-01-01`, to };
  if (r === "mtd") return { from: `${to.slice(0, 8)}01`, to };
  if (r === "all") return { from: "2015-01-01", to };
  return { from: addDays(to, -(defaultDays - 1)), to };
}

function interval(c: Ctx, from: string, to: string): Interval {
  const i = c.req.query("interval");
  if (i === "day" || i === "week" || i === "month") return i;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  return days > 400 ? "month" : days > 120 ? "week" : "day";
}

metricRoutes.get("/overview", read, async (c) => {
  const tz = c.req.query("tzOffset");
  return c.json(await overview(c.env, { ...scope(c), ...(tz && Number.isFinite(Number(tz)) ? { tzOffset: Number(tz) } : {}) }));
});

metricRoutes.get("/charts/:metric", read, async (c) => {
  const metric = c.req.param("metric") as Metric;
  if (!METRICS.includes(metric)) return c.json({ error: `Unknown metric. Use one of: ${METRICS.join(", ")}` }, 400);
  const { from, to } = range(c);
  const g = c.req.query("groupBy");
  const groupBy = g === "app" || g === "country" || g === "product" ? g : null;
  return c.json(await chart(c.env, { ...scope(c), metric, from, to, interval: interval(c, from, to), groupBy }));
});

metricRoutes.get("/mrr-movement", read, async (c) => {
  const { from, to } = range(c, 365);
  return c.json(await mrrMovement(c.env, { ...scope(c), from, to, interval: interval(c, from, to) }));
});

metricRoutes.get("/breakdown", read, async (c) => {
  const metric = (c.req.query("metric") ?? "revenue") as Metric;
  if (!METRICS.includes(metric)) return c.json({ error: "Unknown metric" }, 400);
  const by = c.req.query("by");
  if (by !== "app" && by !== "country" && by !== "product") return c.json({ error: "by must be app, country or product" }, 400);
  const { from, to } = range(c, 28);
  return c.json(await breakdown(c.env, { ...scope(c), metric, by, from, to, limit: Number(c.req.query("limit")) || 50 }));
});

metricRoutes.get("/transactions", read, async (c) => {
  const kinds = c.req.query("kinds")?.split(",").filter(Boolean);
  const env = c.req.query("environment");
  const source = c.req.query("source");
  if (source && !isInstallSource(source)) return c.json({ error: `source must be one of: ${INSTALL_SOURCES.join(", ")}` }, 400);
  return c.json(
    await transactions(c.env, {
      ...scope(c),
      limit: Number(c.req.query("limit")) || 50,
      cursor: c.req.query("cursor") ?? null,
      kinds,
      country: c.req.query("country") ?? null,
      productId: c.req.query("product") ?? null,
      q: c.req.query("q") ?? null,
      refunded: c.req.query("refunded") === "true",
      environment: env === "Sandbox" || env === "all" ? env : "Production",
      upcoming: c.req.query("upcoming") === "true",
      tzOffset: Number(c.req.query("tzOffset")) || 0,
      source: source && isInstallSource(source) ? source : null,
      quick: c.req.query("quick") === "true",
      cancellations: c.req.query("cancellations") === "true",
    }),
  );
});

metricRoutes.get("/customers/:id", read, async (c) => {
  const r = await customer(c.env, { ...scope(c), id: c.req.param("id") });
  return r ? c.json(r) : c.json({ error: "Not found" }, 404);
});

metricRoutes.get("/at-risk", read, async (c) => c.json(await atRisk(c.env, { ...scope(c), limit: Number(c.req.query("limit")) || 100 })));

metricRoutes.get("/forecast", read, async (c) => c.json(await forecast(c.env, { ...scope(c), days: Number(c.req.query("days")) || 30 })));

metricRoutes.get("/cohorts", read, async (c) => c.json(await cohorts(c.env, { ...scope(c), months: Number(c.req.query("months")) || 12 })));

metricRoutes.get("/reconciliation", read, async (c) => {
  const { from, to } = range(c, 30);
  const s = scope(c);
  const r = await reconciliation(c.env, { workspaceId: s.workspaceId, from, to });
  const rate = await new FxCache(c.var.db).perUsd(c.var.workspace!.currency, dayOf(now()));
  const conv = (v: { units: number; proceedsUsd: number; grossUsd: number } | null) => (v ? { units: v.units, proceeds: v.proceedsUsd * rate, gross: v.grossUsd * rate } : null);
  return c.json({
    currency: c.var.workspace!.currency,
    from,
    to,
    reportedDays: r.reportedDays,
    rows: r.rows.filter((x) => !s.appIds?.length || (x.appId && s.appIds.includes(x.appId))).map((x) => ({ day: x.day, appId: x.appId, apple: conv(x.apple), revflare: conv(x.revflare) })),
  });
});

// Goals (worker/lib/goals.ts) ------------------------------------------------------------------------------------------

metricRoutes.get("/goals", read, async (c) => c.json(await goalsList(c.env, { ...scope(c), appIds: null })));

metricRoutes.get("/goals/:id", read, async (c) => {
  const { currency, items } = await goalsList(c.env, { ...scope(c), appIds: null });
  const goal = items.find((g) => g.id === c.req.param("id"));
  return goal ? c.json({ currency, goal }) : c.json({ error: "Goal not found" }, 404);
});

async function goalRate(c: Ctx) {
  return new FxCache(c.var.db).perUsd(c.var.workspace!.currency, dayOf(now()));
}

/** Validates a create / update body over `base`; an error response, or the values to store (target in USD for money). */
async function goalValues(c: Ctx, base: GoalValues | null, rate: number) {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const parsed = parseGoalInput(body, base);
  if ("error" in parsed) return { error: c.json({ error: parsed.error }, 400) };
  const v = parsed.value;
  // Only the apps of the body are checked: a stored app deleted since then must not block other edits.
  const sent = [...(Array.isArray(body.appIds) ? (body.appIds as string[]) : []), ...(typeof body.appId === "string" && body.appId ? [body.appId] : [])];
  const unknown = sent.length ? await unknownApps(c.var.db, wsId(c), [...new Set(sent)]) : [];
  if (unknown.length) return { error: c.json({ error: `Unknown app: ${unknown.join(", ")}` }, 400) };
  return { value: v, targetUsd: GOAL_METRIC_INFO[v.metric].money ? v.target / rate : v.target };
}

async function goalResponse(c: Ctx, id: string, status: 200 | 201 = 200) {
  const { currency, items } = await goalsList(c.env, { workspaceId: wsId(c) });
  return c.json({ id, currency, goal: items.find((g) => g.id === id) ?? null }, status);
}

metricRoutes.post("/goals", requirePermission("manage"), async (c) => {
  const rate = await goalRate(c);
  const r = await goalValues(c, null, rate);
  if (r.error) return r.error;
  const { value: v, targetUsd } = r;
  const count = await c.var.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), -1) AS last FROM goals WHERE workspace_id = ?").bind(wsId(c)).first<{ n: number; last: number }>();
  if ((count?.n ?? 0) >= GOALS_MAX) return c.json({ error: `A workspace can have up to ${GOALS_MAX} goals` }, 400);
  const id = newId("goal_");
  const t = now();
  await c.var.db
    .prepare(
      `INSERT INTO goals (id, workspace_id, name, metric, period, target_usd, app_id, scope, app_ids, start_day, end_day, archived, notify, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, wsId(c), v.name, v.metric, v.period, targetUsd, legacyAppId(v), v.scope, JSON.stringify(v.appIds), v.startDate, v.endDate, v.archived ? 1 : 0, v.notify ? 1 : 0, (count?.last ?? -1) + 1, t, t)
    .run();
  await bumpDataVersion(c.var.db, wsId(c));
  return goalResponse(c, id, 201);
});

const legacyAppId = (v: GoalValues) => (v.scope === "include" && v.appIds.length === 1 ? v.appIds[0] : null);

metricRoutes.patch("/goals/:id", requirePermission("manage"), async (c) => {
  const id = c.req.param("id");
  const row = await c.var.db.prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE id = ? AND workspace_id = ?`).bind(id, wsId(c)).first<GoalRow>();
  if (!row) return c.json({ error: "Goal not found" }, 404);
  const rate = await goalRate(c);
  // Apps deleted from the workspace since leave the stored list.
  const stored = rowScope(row).appIds;
  const gone = stored.length ? new Set(await unknownApps(c.var.db, wsId(c), stored)) : new Set<string>();
  const base = rowValues(row, rate, new Set(stored.filter((id) => !gone.has(id))));
  const r = await goalValues(c, base, rate);
  if (r.error) return r.error;
  const { value: v } = r;
  // An unchanged target (within the rounding of its conversion to the workspace currency) keeps its stored USD value.
  const targetUsd = v.metric === base.metric && sameTarget(v.target, base.target) ? row.target_usd : r.targetUsd;
  // A changed definition may be reached again this period: notify again.
  const redefined =
    v.metric !== base.metric ||
    targetUsd !== row.target_usd ||
    v.period !== base.period ||
    v.startDate !== base.startDate ||
    v.endDate !== base.endDate ||
    v.scope !== base.scope ||
    !sameAppSet(v.appIds, base.appIds);
  await c.var.db
    .prepare(
      `UPDATE goals SET name = ?, metric = ?, period = ?, target_usd = ?, app_id = ?, scope = ?, app_ids = ?, start_day = ?, end_day = ?, archived = ?, notify = ?,
         notified_period = ${redefined ? "NULL" : "notified_period"}, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    )
    .bind(v.name, v.metric, v.period, targetUsd, legacyAppId(v), v.scope, JSON.stringify(v.appIds), v.startDate, v.endDate, v.archived ? 1 : 0, v.notify ? 1 : 0, now(), id, wsId(c))
    .run();
  await bumpDataVersion(c.var.db, wsId(c));
  return goalResponse(c, id);
});

metricRoutes.post("/goals/reorder", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x): x is string => typeof x === "string"))] : [];
  if (!ids.length) return c.json({ error: "ids (the goals in their new order) are required" }, 400);
  const { results } = await c.var.db.prepare("SELECT id FROM goals WHERE workspace_id = ? ORDER BY sort_order, created_at").bind(wsId(c)).all<{ id: string }>();
  const known = new Set(results.map((g) => g.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) return c.json({ error: `Unknown goal: ${unknown.join(", ")}` }, 400);
  // Goals left out keep their relative order after the listed ones.
  const order = [...ids, ...results.map((g) => g.id).filter((id) => !ids.includes(id))];
  await c.var.db.batch(order.map((id, i) => c.var.db.prepare("UPDATE goals SET sort_order = ? WHERE id = ? AND workspace_id = ? AND sort_order != ?").bind(i, id, wsId(c), i)));
  await bumpDataVersion(c.var.db, wsId(c));
  return c.json({ ok: true, ids: order });
});

metricRoutes.delete("/goals/:id", requirePermission("manage"), async (c) => {
  const r = await c.var.db.prepare("DELETE FROM goals WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), wsId(c)).run();
  if (!r.meta.changes) return c.json({ error: "Goal not found" }, 404);
  await bumpDataVersion(c.var.db, wsId(c));
  return c.json({ ok: true });
});

// Alerts --------------------------------------------------------------------------------------------------------------

metricRoutes.get("/alerts", read, async (c) => {
  const { results } = await c.var.db
    .prepare("SELECT id, app_id, key, kind, severity, title, body, created_at, resolved_at FROM alerts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100")
    .bind(wsId(c))
    .all<{ id: string; app_id: string | null; key: string; kind: string; severity: Alert["severity"]; title: string; body: string; created_at: number; resolved_at: number | null }>();
  return c.json({ items: results.map((a): Alert => ({ id: a.id, appId: a.app_id, kind: a.kind, funnelId: alertFunnelId(a.kind, a.key), experimentId: alertExperimentId(a.kind, a.key), severity: a.severity, title: a.title, body: a.body, createdAt: a.created_at, resolvedAt: a.resolved_at })) });
});

metricRoutes.post("/alerts/:id/resolve", read, async (c) => {
  await c.var.db.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ? AND workspace_id = ?").bind(now(), c.req.param("id"), wsId(c)).run();
  await bumpDataVersion(c.var.db, wsId(c));
  return c.json({ ok: true });
});

/**
 * Daily revenue per app for other tools (Adsflare ROAS): one row per app and day with sales. Apps are identified by
 * their App Store id (adam id) and bundle id. Money in `currency` (default USD).
 */
metricRoutes.get("/revenue/daily", read, async (c) => {
  const { from, to } = range(c, 30);
  const s = scope(c);
  const currency = (s.currency ?? "USD").toUpperCase();
  const rate = await new FxCache(c.var.db).perUsd(currency, dayOf(now()));
  const ids = c.req.query("appleAppIds")?.split(",").filter((x) => /^\d+$/.test(x)).slice(0, 60);
  const { results } = await c.var.db
    .prepare(
      `SELECT d.day, a.id AS app_id, a.apple_app_id, a.bundle_id, a.name, d.gross_usd, d.proceeds_usd, d.new_subscriptions, d.renewals,
         d.one_time_purchases, d.trials_started, d.new_customers, d.new_payers, d.refunds, d.mrr_usd
       FROM daily_metrics d JOIN apps a ON a.id = d.app_id
       WHERE d.workspace_id = ? AND d.day >= ? AND d.day <= ?${ids?.length ? ` AND a.apple_app_id IN (${ids.map(() => "?").join(",")})` : ""}
       ORDER BY d.day, a.name`,
    )
    .bind(s.workspaceId, from, to, ...(ids ?? []))
    .all<{
      day: string;
      app_id: string;
      apple_app_id: string | null;
      bundle_id: string | null;
      name: string;
      gross_usd: number;
      proceeds_usd: number;
      new_subscriptions: number;
      renewals: number;
      one_time_purchases: number;
      trials_started: number;
      new_customers: number;
      new_payers: number;
      refunds: number;
      mrr_usd: number;
    }>();
  const r2 = (n: number) => Math.round(n * rate * 100) / 100;
  return c.json({
    currency,
    from,
    to,
    rows: results.map((r) => ({
      date: r.day,
      appId: r.app_id,
      appleAppId: r.apple_app_id,
      bundleId: r.bundle_id,
      name: r.name,
      revenue: r2(r.gross_usd),
      proceeds: r2(r.proceeds_usd),
      transactions: r.new_subscriptions + r.renewals + r.one_time_purchases,
      trials: r.trials_started,
      newCustomers: r.new_customers,
      // Customers who paid for the first time that day.
      payers: r.new_payers,
      refunds: r.refunds,
      mrr: r2(r.mrr_usd),
    })),
  });
});

/** `appleAppIds=` (App Store ids, as Adsflare knows the apps) → Revflare app ids; an empty list when none matches. */
async function appleAppScope(c: Ctx, appIds: string[] | null): Promise<string[] | null> {
  const ids = c.req.query("appleAppIds")?.split(",").filter((x) => /^\d+$/.test(x)).slice(0, 60);
  if (!ids?.length) return appIds;
  const { results } = await c.var.db
    .prepare(`SELECT id FROM apps WHERE workspace_id = ? AND apple_app_id IN (${ids.map(() => "?").join(",")})`)
    .bind(wsId(c), ...ids)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Apple Ads revenue (RevflareKit attribution): per day, app, campaign, ad group and keyword, with the names stored by
 * PUT /attribution/names. Revenue counts on the purchase day, installs on the day they reported. Test data (Apple's
 * test attribution, sandbox / Xcode builds, test devices) only with includeTest=true, rows flagged `test`.
 */
metricRoutes.get("/revenue/attributed", read, async (c) => {
  const { from, to } = range(c, 30);
  const s = scope(c);
  const currency = (s.currency ?? c.var.workspace!.currency).toUpperCase();
  const rate = await new FxCache(c.var.db).perUsd(currency, dayOf(now()));
  const includeTest = c.req.query("includeTest") === "true" || c.req.query("includeTest") === "1";
  const appIds = await appleAppScope(c, s.appIds ?? null);
  if (appIds && !appIds.length) return c.json({ currency, from, to, ...(includeTest ? { includeTest } : {}), coverage: { installs: 0, attributed: 0, testInstalls: 0 }, rows: [] });
  const r = await attributedRevenue(c.env, { workspaceId: wsId(c), from, to, appIds, ...(includeTest ? { includeTest } : {}) });
  const r2 = (n: number) => Math.round(n * rate * 100) / 100;
  return c.json({ currency, from, to, ...(includeTest ? { includeTest } : {}), coverage: r.coverage, rows: r.rows.map((x) => ({ ...x, revenue: r2(x.revenue), proceeds: r2(x.proceeds) })) });
});

/** Apple Ads campaign / ad group / keyword names of the workspace. */
metricRoutes.get("/attribution/names", read, async (c) => c.json(await listAdsNames(c.env, { workspaceId: wsId(c) })));

/** Upserts names (≤ 1000; an empty name deletes): Adsflare, the CLI and the web import. Only changed rows are written. */
metricRoutes.put("/attribution/names", requirePermission("manage"), async (c) => {
  const names = parseAdsNames(await c.req.json().catch(() => null));
  if ("error" in names) return c.json({ error: names.error }, 400);
  return c.json(await putAdsNames(c.env, { workspaceId: wsId(c), names }));
});

const LTV_COHORTS: LtvCohortUnit[] = ["day", "week", "month"];

function ltvDimension(c: Ctx, fallback: LtvDimension): LtvDimension | null {
  const by = (c.req.query("by") ?? fallback) as LtvDimension;
  return LTV_DIMENSIONS.includes(by) ? by : null;
}

/** LTV by acquisition source (docs/ltv.md): install cohorts × source / campaign / ad group / keyword / country (an empty app selection is no app). */
metricRoutes.get("/ltv", read, async (c) => {
  const by = ltvDimension(c, "source");
  if (!by) return c.json({ error: `by must be one of: ${LTV_DIMENSIONS.join(", ")}` }, 400);
  const cohort = (c.req.query("cohort") ?? "week") as LtvCohortUnit;
  if (!LTV_COHORTS.includes(cohort)) return c.json({ error: "cohort must be day, week or month" }, 400);
  const { from, to } = range(c, cohort === "day" ? 30 : cohort === "week" ? 182 : 396);
  const s = scope(c);
  const appIds = await appleAppScope(c, s.appIds ?? null);
  const summary = c.req.query("summary") === "1" || c.req.query("summary") === "true";
  return c.json(await ltv(c.env, { ...s, appIds, by, cohort, from, to, ...(summary ? { summary } : {}) }));
});

/** Per group: installs, payers, conversion and value per install at each horizon, pooled over mature install days (Adsflare: payback, ROAS). */
metricRoutes.get("/ltv/summary", read, async (c) => {
  const by = ltvDimension(c, "campaign");
  if (!by) return c.json({ error: `by must be one of: ${LTV_DIMENSIONS.join(", ")}` }, 400);
  const { from, to } = range(c, 90);
  const s = scope(c);
  const appIds = await appleAppScope(c, s.appIds ?? null);
  return c.json(await ltvSummary(c.env, { ...s, appIds, by, from, to }));
});
