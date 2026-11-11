// A/B experiments on remote config parameters (docs/experiments.md).
//
// Model: an experiment sets 1 to 10 parameters of the app's remote config per variant (2 to 5, "a" = control).
// draft → running → stopped → rolled_out (or archived). Running and stopped experiments are compiled into the app's
// remote config payload (worker/lib/remote-config.ts): GET /sdk/v1/config assigns each device in the Worker (bucket from
// sha256(installId + experiment id): traffic split, then variants by weight; targeting = an existing condition), so
// assignments cost no database work per request, and a stopped experiment keeps serving them (no flip) until it is
// rolled out (the winner's values become the parameters' defaults) or archived.
//
// Exposure: RevflareKit sends `experiment_exposure` { experiment: id, variant: "<id>:<variant>" } (the promoted
// `variant` property, blob17). Results read the exposed installs of each variant from the stored key events when they
// cover the whole window (exact, worker/lib/key-events.ts), else from Analytics Engine (one query per variant, capped),
// and their purchases through install_links in ≤ 90-id statements, all inside the database object.
// They are stored on the experiment row and served from it: the cron recomputes running experiments every few hours
// (within its tick budget), a read computes only when nothing is stored (or once more, final, after the stop), and an
// explicit refresh is allowed once an hour; every computation is metered against the daily background budget
// (worker/lib/budget.ts). A daily cron snapshot keeps exposed installs per variant and day in experiment_daily
// (Analytics Engine keeps 3 months).

import {
  EVENT_LIMITS,
  EXPERIMENT_EXPOSURE_EVENT,
  EXPERIMENT_LIMITS,
  EXPERIMENT_METRICS,
  type Experiment,
  type ExperimentMetric,
  type ExperimentResults,
  type ExperimentStatus,
  type ExperimentVariant,
  type ExperimentVariantResult,
  type RemoteConfigValueType,
} from "../../shared/types";
import { raiseAlert } from "./alert-store";
import { backgroundAllowed, metered } from "./budget";
import { defineDbFunction, type Db } from "./db";
import { compareRates, seedOf } from "./experiment-stats";
import { addDays, dayOf, FxCache, keptShareSql } from "./money";
import {
  activeExperiments,
  coerceValue,
  EMPTY_REMOTE_CONFIG,
  parseRemoteConfig,
  recompileRemoteConfig,
  saveRemoteConfig,
  type StoredRemoteConfig,
} from "./remote-config";
import { getSetting, setSetting } from "./settings";
import { errorMessage, now, parseJson } from "./util";
import { appTestInstalls } from "./test-data";
import { AnalyticsError, analyticsConfig, analyticsMissing, appScope, num, runSql, SqlValueError, sqlInt, sqlString } from "./wae";
import { COLUMNS } from "./events";
import { exactExposures } from "./key-events";
import type { SendBudget } from "./push";

const DAY = 86_400_000;
/** The cron recomputes a running experiment's results at most this often. */
export const RESULTS_INTERVAL_MS = 6 * 3_600_000;
/** An explicit refresh (POST …/results/refresh) is allowed at most this often per experiment. */
export const REFRESH_INTERVAL_MS = 3_600_000;
/** A purchase counts from this long before the first exposure (device clocks drift). */
export const EXPOSURE_GRACE_MS = 5 * 60_000;
/** Analytics Engine keeps events 3 months: older starts use the daily snapshot. */
const WAE_RETENTION_MS = 92 * DAY;
const CHUNK = 90;
const VARIANT_IDS = ["a", "b", "c", "d", "e"] as const;
const ID_RE = /^exp_[a-z0-9]{1,40}$/;
const EXPOSURE_RE = /^exp_[a-z0-9]{1,40}:[a-e]$/;
const EVENT_RE = /^[a-z_]+$/;
/** The daily snapshot runs from 02:00 UTC (yesterday's late events have arrived). */
const SNAPSHOT_HOUR = 2;
const SNAPSHOTS_PER_TICK = 5;
const RESULTS_PER_TICK = 2;

type Fail = { error: string };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "").trim();

/** Stored in experiments.definition. */
export interface ExperimentDefinition {
  keys: string[];
  types: Record<string, RemoteConfigValueType>;
  variants: ExperimentVariant[];
  targeting: string | null;
  traffic: number;
  primaryMetric: ExperimentMetric;
}

export interface ExperimentRow {
  id: string;
  workspace_id: string;
  app_id: string;
  name: string;
  hypothesis: string | null;
  status: ExperimentStatus;
  definition: string;
  started_at: number | null;
  stopped_at: number | null;
  rolled_out_variant: string | null;
  results: string | null;
  results_at: number | null;
  frozen: number;
  snapshot_day: string | null;
  created_at: number;
  updated_at: number;
}

export function newExperimentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `exp_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function definitionOf(r: Pick<ExperimentRow, "definition">): ExperimentDefinition {
  const d = parseJson<Partial<ExperimentDefinition>>(r.definition, {});
  return { keys: d.keys ?? [], types: d.types ?? {}, variants: d.variants ?? [], targeting: d.targeting ?? null, traffic: d.traffic ?? 100, primaryMetric: d.primaryMetric ?? "paid" };
}

export function toExperiment(r: ExperimentRow): Experiment {
  const d = definitionOf(r);
  return {
    id: r.id,
    appId: r.app_id,
    name: r.name,
    hypothesis: r.hypothesis,
    keys: d.keys,
    variants: d.variants,
    targeting: d.targeting,
    traffic: d.traffic,
    primaryMetric: d.primaryMetric,
    status: r.status,
    startedAt: r.started_at,
    stoppedAt: r.stopped_at,
    endsAt: r.started_at === null ? null : r.started_at + EXPERIMENT_LIMITS.maxDays * DAY,
    rolledOutVariant: r.rolled_out_variant,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// --- Validation -------------------------------------------------------------------------------------------------------

export interface ParsedExperiment {
  name: string;
  hypothesis: string | null;
  def: ExperimentDefinition;
}

/** Validates a POST body, or a PATCH body merged over `prev`, against the app's remote config. */
export function parseExperiment(body: unknown, config: StoredRemoteConfig, prev?: ParsedExperiment): ParsedExperiment | Fail {
  if (!isObject(body)) return { error: "Expected a JSON object { name, keys, variants, targeting?, traffic?, primaryMetric?, hypothesis? }" };
  const b: Record<string, unknown> = { ...(prev ? { name: prev.name, hypothesis: prev.hypothesis, ...prev.def } : {}), ...body };
  if (typeof b.name !== "string" || !clean(b.name)) return { error: "name is required" };
  const name = clean(b.name);
  if (name.length > 100) return { error: "name is longer than 100 characters" };
  let hypothesis: string | null = null;
  if (b.hypothesis !== undefined && b.hypothesis !== null && b.hypothesis !== "") {
    if (typeof b.hypothesis !== "string" || b.hypothesis.length > 1000) return { error: "hypothesis must be a string of at most 1000 characters" };
    hypothesis = b.hypothesis.trim() || null;
  }

  if (!Array.isArray(b.keys) || !b.keys.length) return { error: "keys must be a non-empty list of remote config parameter keys" };
  if (b.keys.length > EXPERIMENT_LIMITS.maxKeys) return { error: `At most ${EXPERIMENT_LIMITS.maxKeys} parameters per experiment` };
  const keys: string[] = [];
  const types: Record<string, RemoteConfigValueType> = {};
  for (const k of b.keys) {
    if (typeof k !== "string") return { error: "keys must be strings" };
    const p = config.parameters.find((x) => x.key === k);
    if (!p) return { error: `Parameter "${k}" does not exist in the app's remote config` };
    if (keys.includes(k)) return { error: `Parameter "${k}" appears twice` };
    keys.push(k);
    types[k] = p.type;
  }

  if (!Array.isArray(b.variants)) return { error: "variants must be a list (the first one, a, is the control)" };
  if (b.variants.length < EXPERIMENT_LIMITS.minVariants || b.variants.length > EXPERIMENT_LIMITS.maxVariants)
    return { error: `An experiment has ${EXPERIMENT_LIMITS.minVariants} to ${EXPERIMENT_LIMITS.maxVariants} variants` };
  const raw = b.variants as unknown[];
  if (!raw.every(isObject)) return { error: "Each variant must be an object { id?, name?, weight?, values }" };
  const vs = raw as Record<string, unknown>[];
  const noWeights = vs.every((v) => v.weight === undefined || v.weight === null);
  const variants: ExperimentVariant[] = [];
  let sum = 0;
  for (const [i, v] of vs.entries()) {
    const id = VARIANT_IDS[i];
    if (v.id !== undefined && v.id !== null && v.id !== id) return { error: `Variant ${i + 1} must have id "${id}" (variants are a, b, c... in order; a is the control)` };
    const where = `Variant ${id}`;
    let vname = i === 0 ? "Control" : `Variant ${id.toUpperCase()}`;
    if (v.name !== undefined && v.name !== null && v.name !== "") {
      if (typeof v.name !== "string" || clean(v.name).length > 60) return { error: `${where}: name must be at most 60 characters` };
      vname = clean(v.name) || vname;
    }
    let weight: number;
    if (noWeights) weight = Math.round((100 / vs.length) * 1e6) / 1e6;
    else {
      if (typeof v.weight !== "number" || !Number.isFinite(v.weight) || v.weight <= 0 || v.weight > 100) return { error: `${where}: weight must be a number above 0 (all variants sum to 100)` };
      weight = v.weight;
    }
    sum += weight;
    if (v.values !== undefined && v.values !== null && !isObject(v.values)) return { error: `${where}: values must be an object { key: value }` };
    const values: Record<string, unknown> = {};
    for (const [k, val] of Object.entries((v.values ?? {}) as Record<string, unknown>)) {
      if (!keys.includes(k)) return { error: `${where}: "${k}" is not one of the experiment's keys (${keys.join(", ")})` };
      if (isObject(val) && val.useInAppDefault === true) return { error: `${where}, "${k}": variants need a value (leave the key out of the control to keep the current value)` };
      const c = coerceValue(types[k], val, `${where}, "${k}"`);
      if ("error" in c) return c;
      values[k] = c.value;
    }
    if (i > 0) {
      const missing = keys.filter((k) => !(k in values));
      if (missing.length) return { error: `${where}: needs a value for ${missing.map((k) => `"${k}"`).join(", ")} (only the control may keep the current values)` };
    }
    variants.push({ id, name: vname, weight, values });
  }
  if (Math.abs(sum - 100) > 1e-3) return { error: `Variant weights must sum to 100 (they sum to ${Math.round(sum * 1000) / 1000})` };
  if (noWeights) variants[variants.length - 1].weight = Math.round((100 - variants.slice(0, -1).reduce((s, v) => s + v.weight, 0)) * 1e6) / 1e6;

  let targeting: string | null = null;
  if (b.targeting !== undefined && b.targeting !== null && b.targeting !== "") {
    const cond = typeof b.targeting === "string" ? config.conditions.find((c) => c.name === b.targeting) : undefined;
    if (!cond) return { error: `Targeting condition ${JSON.stringify(b.targeting)} does not exist in the app's remote config` };
    if (cond.unsupported) return { error: `Condition "${cond.name}" never matches (unsupported targeting): pick another one` };
    targeting = cond.name;
  }
  let traffic = 100;
  if (b.traffic !== undefined && b.traffic !== null) {
    if (typeof b.traffic !== "number" || !Number.isFinite(b.traffic) || b.traffic <= 0 || b.traffic > 100) return { error: "traffic must be a percentage above 0 and at most 100" };
    traffic = b.traffic;
  }
  const primaryMetric = (b.primaryMetric ?? "paid") as ExperimentMetric;
  if (!EXPERIMENT_METRICS.includes(primaryMetric)) return { error: `primaryMetric must be one of ${EXPERIMENT_METRICS.join(", ")}` };
  return { name, hypothesis, def: { keys, types, variants, targeting, traffic, primaryMetric } };
}

// --- Storage and lifecycle --------------------------------------------------------------------------------------------

export async function listExperiments(db: Db, workspaceId: string, appId: string): Promise<Experiment[]> {
  const { results } = await db
    .prepare(
      "SELECT id, workspace_id, app_id, name, hypothesis, status, definition, started_at, stopped_at, rolled_out_variant, NULL AS results, results_at, frozen, snapshot_day, created_at, updated_at FROM experiments WHERE app_id = ? AND workspace_id = ? ORDER BY created_at DESC",
    )
    .bind(appId, workspaceId)
    .all<ExperimentRow>();
  return results.map(toExperiment);
}

export async function experimentRow(db: Db, workspaceId: string, appId: string, id: string): Promise<ExperimentRow | null> {
  return db.prepare("SELECT * FROM experiments WHERE id = ? AND app_id = ? AND workspace_id = ?").bind(id, appId, workspaceId).first<ExperimentRow>();
}

export type ExperimentOp =
  | { kind: "create"; body: unknown }
  | { kind: "update"; id: string; body: unknown }
  | { kind: "delete"; id: string }
  | { kind: "start"; id: string }
  | { kind: "stop"; id: string }
  | { kind: "rollout"; id: string; variant: string }
  | { kind: "archive"; id: string };

export type ExperimentChangeResult =
  | { status: 200 | 201; experiment: Experiment | null; sdkKey: string | null; payloadChanged: boolean }
  | { status: 400 | 404 | 409; error: string };

const parsedOf = (r: ExperimentRow): ParsedExperiment => ({ name: r.name, hypothesis: r.hypothesis, def: definitionOf(r) });

/** Every experiment change, inside the database object (read-modify-write, no interleaving). */
export const changeExperiment = defineDbFunction(
  "experiments.change",
  async (db, args: { workspaceId: string; appId: string; op: ExperimentOp }): Promise<ExperimentChangeResult> => {
    const app = await db
      .prepare("SELECT a.id, a.sdk_key, r.config FROM apps a LEFT JOIN remote_configs r ON r.app_id = a.id WHERE a.id = ? AND a.workspace_id = ?")
      .bind(args.appId, args.workspaceId)
      .first<{ id: string; sdk_key: string | null; config: string | null }>();
    if (!app) return { status: 404, error: "Not found" };
    const config = parseJson<StoredRemoteConfig>(app.config, EMPTY_REMOTE_CONFIG);
    const op = args.op;
    const t = now();
    const ok = async (id: string, payloadChanged: boolean, status: 200 | 201 = 200): Promise<ExperimentChangeResult> => {
      const row = await db.prepare("SELECT * FROM experiments WHERE id = ?").bind(id).first<ExperimentRow>();
      return { status, experiment: row ? toExperiment(row) : null, sdkKey: app.sdk_key, payloadChanged };
    };

    if (op.kind === "create") {
      const p = parseExperiment(op.body, config);
      if ("error" in p) return { status: 400, error: p.error };
      const count = await db.prepare("SELECT COUNT(*) AS n FROM experiments WHERE app_id = ?").bind(app.id).first<{ n: number }>();
      if ((count?.n ?? 0) >= EXPERIMENT_LIMITS.perApp) return { status: 409, error: `At most ${EXPERIMENT_LIMITS.perApp} experiments per app: delete archived ones first` };
      const id = newExperimentId();
      await db
        .prepare("INSERT INTO experiments (id, workspace_id, app_id, name, hypothesis, status, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)")
        .bind(id, args.workspaceId, app.id, p.name, p.hypothesis, JSON.stringify(p.def), t, t)
        .run();
      return ok(id, false, 201);
    }

    const row = await db.prepare("SELECT * FROM experiments WHERE id = ? AND app_id = ?").bind(op.id, app.id).first<ExperimentRow>();
    if (!row) return { status: 404, error: "Not found" };
    const wrong = (what: string) => ({ status: 409 as const, error: `The experiment is ${row.status.replace("_", " ")}: ${what}` });

    switch (op.kind) {
      case "update": {
        if (row.status !== "draft") return wrong("only drafts can be edited (create a new experiment instead)");
        const p = parseExperiment(op.body, config, parsedOf(row));
        if ("error" in p) return { status: 400, error: p.error };
        await db
          .prepare("UPDATE experiments SET name = ?, hypothesis = ?, definition = ?, updated_at = ? WHERE id = ?")
          .bind(p.name, p.hypothesis, JSON.stringify(p.def), Math.max(t, row.updated_at + 1), row.id)
          .run();
        return ok(row.id, false);
      }
      case "delete": {
        if (row.status === "running" || row.status === "stopped") return wrong("archive or roll it out before deleting it (devices still get its values)");
        await db.batch([db.prepare("DELETE FROM experiment_daily WHERE experiment_id = ?").bind(row.id), db.prepare("DELETE FROM experiments WHERE id = ?").bind(row.id)]);
        return { status: 200, experiment: null, sdkKey: app.sdk_key, payloadChanged: false };
      }
      case "start": {
        if (row.status !== "draft") return wrong("only drafts can be started");
        // The config may have changed since the draft was saved: validate again (and refresh the types).
        const p = parseExperiment({}, config, parsedOf(row));
        if ("error" in p) return { status: 400, error: p.error };
        for (const other of await activeExperiments(db, app.id)) {
          const shared = other.keys.find((k) => p.def.keys.includes(k));
          if (shared) return { status: 409, error: `Parameter "${shared}" is already in experiment ${other.id} (running or stopped): roll it out or archive it first` };
        }
        await db
          .prepare("UPDATE experiments SET status = 'running', definition = ?, started_at = ?, stopped_at = NULL, results = NULL, results_at = NULL, frozen = 0, snapshot_day = NULL, updated_at = ? WHERE id = ?")
          .bind(JSON.stringify(p.def), t, t, row.id)
          .run();
        await recompileRemoteConfig(db, app.id);
        return ok(row.id, true);
      }
      case "stop": {
        if (row.status !== "running") return wrong("only running experiments can be stopped");
        // Devices keep their variant (no flip); results are computed once more up to now and then frozen.
        await db.prepare("UPDATE experiments SET status = 'stopped', stopped_at = ?, results_at = NULL, updated_at = ? WHERE id = ?").bind(t, t, row.id).run();
        return ok(row.id, false);
      }
      case "rollout": {
        if (row.status !== "running" && row.status !== "stopped") return wrong("only running or stopped experiments can be rolled out");
        const def = definitionOf(row);
        const variant = def.variants.find((v) => v.id === op.variant);
        if (!variant) return { status: 400, error: `Unknown variant ${JSON.stringify(op.variant)} (${def.variants.map((v) => v.id).join(", ")})` };
        // The winner's values become the parameters' defaults (conditional values stay).
        const next: StoredRemoteConfig = {
          conditions: config.conditions,
          parameters: config.parameters.map((p) => {
            if (!(p.key in variant.values)) return p;
            const { useInAppDefault: _, ...rest } = p;
            return { ...rest, defaultValue: variant.values[p.key] };
          }),
        };
        const parsed = parseRemoteConfig(next);
        if ("error" in parsed) return { status: 400, error: parsed.error };
        await db
          .prepare(
            "UPDATE experiments SET status = 'rolled_out', rolled_out_variant = ?, stopped_at = COALESCE(stopped_at, ?), results_at = CASE WHEN stopped_at IS NULL THEN NULL ELSE results_at END, updated_at = ? WHERE id = ?",
          )
          .bind(variant.id, t, t, row.id)
          .run();
        await saveRemoteConfig(db, app.id, parsed, await activeExperiments(db, app.id), t);
        return ok(row.id, true);
      }
      case "archive": {
        if (row.status === "archived" || row.status === "rolled_out") return wrong("nothing to archive");
        const active = row.status === "running" || row.status === "stopped";
        await db
          .prepare(
            "UPDATE experiments SET status = 'archived', stopped_at = CASE WHEN started_at IS NULL THEN NULL ELSE COALESCE(stopped_at, ?) END, results_at = CASE WHEN stopped_at IS NULL THEN NULL ELSE results_at END, updated_at = ? WHERE id = ?",
          )
          .bind(t, t, row.id)
          .run();
        if (active) await recompileRemoteConfig(db, app.id);
        return ok(row.id, active);
      }
    }
  },
);

// --- Exposures (Analytics Engine) ------------------------------------------------------------------------------------

const exposureValue = (id: string, variant: string) => sqlString(`${id}:${variant}`, EXPOSURE_RE);

/**
 * Per install of one variant: the first exposure (event time, double1) and the sample interval. Event times are bounded
 * server-side to the window (EXPOSURE_GRACE_MS of slack for device clocks); events are received after they happen
 * (offline queue: up to 7 days later, the ingest limit), devices may run up to 1 h ahead.
 */
export function exposureSql(dataset: string, appId: string, id: string, variant: string, fromMs: number, toMs: number, limit: number, excludedInstalls: readonly string[] = []): string {
  const ts = COLUMNS.ts;
  const where = [
    // Always production data from other devices than the test ones (no includeTest for experiments).
    appScope(appId, fromMs - 3_600_000, toMs + EVENT_LIMITS.maxAgeMs + DAY, { excludedInstalls }),
    `${COLUMNS.name} = ${sqlString(EXPERIMENT_EXPOSURE_EVENT, EVENT_RE)}`,
    `${COLUMNS.variant} = ${exposureValue(id, variant)}`,
    `${ts} >= ${sqlInt(fromMs - EXPOSURE_GRACE_MS)}`,
    `${ts} < ${sqlInt(toMs)}`,
  ].join(" AND ");
  return `SELECT ${COLUMNS.install} AS install, min(${ts}) AS first, max(_sample_interval) AS si FROM ${dataset} WHERE ${where} GROUP BY install ORDER BY first ASC LIMIT ${sqlInt(limit)}`;
}

/**
 * Exposed installs per UTC day (of reception) and variant: the daily snapshot. count(DISTINCT install) counts the
 * stored (sampled) events' installs: the caller scales it by the sample interval (`si`).
 */
export function snapshotSql(dataset: string, appId: string, id: string, variants: string[], fromMs: number, toMs: number, excludedInstalls: readonly string[] = []): string {
  const where = [
    appScope(appId, fromMs, toMs, { excludedInstalls }),
    `${COLUMNS.name} = ${sqlString(EXPERIMENT_EXPOSURE_EVENT, EVENT_RE)}`,
    `${COLUMNS.variant} IN (${variants.map((v) => exposureValue(id, v)).join(", ")})`,
  ].join(" AND ");
  return `SELECT toStartOfDay(timestamp) AS day, ${COLUMNS.variant} AS v, count(DISTINCT ${COLUMNS.install}) AS exposed, max(_sample_interval) AS si FROM ${dataset} WHERE ${where} GROUP BY day, v LIMIT 1000`;
}

export interface Exposures {
  /** Variant → [install id, first exposure ms]; null: no install lists (snapshot counts only). */
  lists: Record<string, [string, number][]> | null;
  approximate: boolean;
  notes: string[];
}

/** The window of an experiment's results: its start to its stop (or `at`). */
export function resultsWindow(r: Pick<ExperimentRow, "started_at" | "stopped_at">, at: number): { from: number; to: number } | null {
  if (r.started_at === null) return null;
  return { from: r.started_at, to: Math.max(r.started_at, Math.min(r.stopped_at ?? at, at)) };
}

/** Installs read per variant: EXPERIMENT_LIMITS.installCap spread over the variants. */
export const installCapPerVariant = (variants: number) => Math.floor(EXPERIMENT_LIMITS.installCap / Math.max(1, variants));

/**
 * Exposed installs per variant from Analytics Engine (one query per variant, cached 5 minutes by SQL text). Runs inside
 * the database object (computeExperimentResults), so the install lists never cross an RPC boundary.
 */
export async function exposuresOf(env: Env, r: ExperimentRow, at: number, excludedInstalls: readonly string[] = [], db?: Db): Promise<Exposures> {
  const w = resultsWindow(r, at);
  const def = definitionOf(r);
  if (!w) return { lists: null, approximate: false, notes: [] };
  // Exact exposures when experiment_exposure key events cover the whole window (worker/lib/key-events.ts).
  if (db && ID_RE.test(r.id)) {
    const cap = installCapPerVariant(def.variants.length);
    const exact = await exactExposures(
      db,
      { appId: r.app_id, experimentId: r.id, variants: def.variants.map((v) => v.id), fromMs: w.from, toMs: w.to, graceMs: EXPOSURE_GRACE_MS, excludedInstalls, cap },
      at,
    ).catch((err) => {
      console.error("exact exposures failed", errorMessage(err));
      return null;
    });
    if (exact) {
      const notes = exact.over.map((v) => `Variant ${v} had more than ${cap.toLocaleString("en-US")} exposed installs: the first ${cap.toLocaleString("en-US")} were used.`);
      return { lists: exact.lists, approximate: notes.length > 0, notes };
    }
  }
  if (!analyticsMissing(env).query) return { lists: null, approximate: true, notes: ["Event queries are not configured (CF_ACCOUNT_ID, CF_ANALYTICS_TOKEN): exposures come from the daily snapshot and conversions cannot be measured."] };
  if (w.from < at - WAE_RETENTION_MS) return { lists: null, approximate: true, notes: ["The experiment started more than 3 months ago (Analytics Engine keeps events 3 months): exposures are the sum of the daily snapshots (installs exposed on several days count more than once), conversions cannot be measured."] };
  if (!ID_RE.test(r.id)) throw new Error("Invalid experiment id");
  const { dataset } = analyticsConfig(env);
  const cap = installCapPerVariant(def.variants.length);
  // Rounded to 5 minutes: repeated reads hit the query cache.
  const from = Math.floor(w.from / 300_000) * 300_000;
  const to = Math.ceil(w.to / 300_000) * 300_000;
  const notes: string[] = [];
  let sampled = 1;
  const lists: Record<string, [string, number][]> = {};
  await Promise.all(
    def.variants.map(async (v) => {
      const rows = await runSql(env, exposureSql(dataset, r.app_id, r.id, v.id, from, to, cap + 1, excludedInstalls));
      if (rows.length > cap) notes.push(`Variant ${v.id} had more than ${cap.toLocaleString("en-US")} exposed installs: the first ${cap.toLocaleString("en-US")} were used.`);
      const list: [string, number][] = [];
      for (const row of rows.slice(0, cap)) {
        const install = typeof row.install === "string" ? row.install.toLowerCase() : "";
        if (!install) continue;
        sampled = Math.max(sampled, num(row.si) || 1);
        list.push([install, num(row.first)]);
      }
      lists[v.id] = list;
    }),
  );
  if (sampled > 1) notes.push(`Analytics Engine sampled this app's events (1 stored event stands for up to ${sampled}): exposed installs are lower than the real ones, rates stay close.`);
  return { lists, approximate: notes.length > 0, notes };
}

// --- Results ------------------------------------------------------------------------------------------------------------

const KEPT = keptShareSql("t");

/** Kinds of a first paid transaction: a subscription's first paid period (bought, or converted from a trial) or a non-subscription purchase. */
const FIRST_PAID_KINDS = new Set(["new", "conversion", "one_time"]);

interface Purchase {
  install: string;
  kind: string;
  at: number;
  /** When the subscription (or purchase) began: original_purchased_at, else its first stored transaction. */
  orig: number;
  gross: number;
  proceeds: number;
  kept: number;
}

const notStarted = (r: ExperimentRow, currency: string, at: number): ExperimentResults => {
  const def = definitionOf(r);
  return {
    experimentId: r.id,
    status: r.status,
    primaryMetric: def.primaryMetric,
    currency,
    from: null,
    to: null,
    daysRunning: 0,
    variants: def.variants.map((v) => ({
      variant: v.id,
      name: v.name,
      weight: v.weight,
      exposed: 0,
      trials: 0,
      trialRate: null,
      paid: 0,
      paidRate: null,
      revenue: 0,
      proceeds: 0,
      revenuePerInstall: null,
      proceedsPerInstall: null,
      probabilityBest: { trial_started: null, paid: null },
      lift: { trial_started: null, paid: null },
    })),
    enoughData: false,
    reasons: ["The experiment has not started."],
    confident: null,
    exposureSource: "none",
    approximate: false,
    notes: [],
    daily: [],
    frozen: false,
    generatedAt: at,
  };
};

/** Guardrails (no peeking machinery): days running, exposed installs per variant, conversions on the primary metric. */
export function guardrails(days: number, variants: { exposed: number; trials: number; paid: number }[], metric: ExperimentMetric): string[] {
  const out: string[] = [];
  const L = EXPERIMENT_LIMITS;
  if (days < L.minDays) out.push(`Running for ${Math.floor(days)} of at least ${L.minDays} days.`);
  const low = variants.filter((v) => v.exposed < L.minExposed);
  if (low.length) out.push(`${low.length === variants.length ? "Every variant has" : `${low.length} variant${low.length === 1 ? " has" : "s have"}`} fewer than ${L.minExposed} exposed installs.`);
  const conversions = variants.reduce((s, v) => s + (metric === "trial_started" ? v.trials : v.paid), 0);
  if (conversions < L.minConversions) out.push(`${conversions} of at least ${L.minConversions} ${metric === "trial_started" ? "trial starts" : "paid conversions"} in total.`);
  return out;
}

/** Why results are missing, as ExperimentResults with no measured data (not stored). */
const pending = (r: ExperimentRow, currency: string, at: number, reason: string): ExperimentResults => {
  const w = resultsWindow(r, at);
  return { ...notStarted(r, currency, at), from: w?.from ?? null, to: w?.to ?? null, daysRunning: w ? Math.round(((w.to - w.from) / DAY) * 10) / 10 : 0, reasons: [reason] };
};

const BUDGET_USED = "Today's database budget for background work is used up (Cloudflare Free plan): results are computed again after 00:00 UTC.";

export type ResultsMode =
  /** GET …/results: compute only when nothing is stored, or once more (final) for an ended experiment. */
  | "missing"
  /** POST …/results/refresh: recompute unless frozen or computed less than REFRESH_INTERVAL_MS ago. */
  | "refresh"
  /** The cron: recompute (the caller picked it). */
  | "cron";

export type ResultsOutcome = { status: 200; results: ExperimentResults } | { status: 404 | 409 | 429 | 502; error: string; code?: string; retryAfter?: number };

/** Stored results of a row, or null. */
const storedOf = (r: ExperimentRow): ExperimentResults | null => (r.results ? parseJson<ExperimentResults | null>(r.results, null) : null);

/**
 * Results of an experiment, inside the database object: the stored ones, or (per `mode`) a new computation — exposures
 * from Analytics Engine fetched here (the install lists never cross the RPC boundary), purchases via install_links →
 * transactions (Production, ≤ 90 ids per statement), the daily snapshot, the posteriors. Each computation is metered
 * against the daily background budget (worker/lib/budget.ts) and refused once it is used up. Raises one
 * experiment_result alert when a running experiment reaches a confident result, resolves it when it no longer is.
 */
export const computeExperimentResults = defineDbFunction(
  "experiments.results",
  async (db, args: { workspaceId: string; appId?: string; experimentId: string; at: number; mode: ResultsMode }, env): Promise<ResultsOutcome> => {
    const r = await db
      .prepare(`SELECT * FROM experiments WHERE id = ? AND workspace_id = ?${args.appId ? " AND app_id = ?" : ""}`)
      .bind(args.experimentId, args.workspaceId, ...(args.appId ? [args.appId] : []))
      .first<ExperimentRow>();
    if (!r) return { status: 404, error: "Not found" };
    const ws = await db.prepare("SELECT currency FROM workspaces WHERE id = ?").bind(args.workspaceId).first<{ currency: string }>();
    const currency = (ws?.currency ?? "USD").toUpperCase();
    if (r.started_at === null) return { status: 200, results: notStarted(r, currency, args.at) };
    const stored = storedOf(r);
    if (args.mode === "missing" && stored && (r.frozen || r.status === "running")) return { status: 200, results: stored };
    if (args.mode === "refresh") {
      if (r.frozen && stored) return { status: 409, error: "The experiment has ended: its results are final." };
      const wait = r.results_at === null ? 0 : r.results_at + REFRESH_INTERVAL_MS - args.at;
      if (wait > 0 && stored)
        return { status: 429, error: `Results were computed less than an hour ago: refresh again in ${Math.ceil(wait / 60_000)} min.`, retryAfter: Math.ceil(wait / 1000) };
    }
    if (!(await backgroundAllowed(db, env))) {
      if (args.mode === "refresh") return { status: 429, error: BUDGET_USED };
      return { status: 200, results: stored ? { ...stored, notes: [...stored.notes, BUDGET_USED] } : pending(r, currency, args.at, BUDGET_USED) };
    }
    try {
      return { status: 200, results: await metered(db, () => computeResults(db, env, r, currency, args.at)) };
    } catch (err) {
      if (err instanceof AnalyticsError) return { status: err.status, error: err.message, code: err.code };
      if (err instanceof SqlValueError) return { status: 409, error: err.message };
      throw err;
    }
  },
);

async function computeResults(db: Db, env: Env, r: ExperimentRow, currency: string, at: number): Promise<ExperimentResults> {
  const w = resultsWindow(r, at)!;
  const exposures = await exposuresOf(env, r, at, await appTestInstalls(db, r.app_id), db);
  const rate = await new FxCache(db).perUsd(currency, dayOf(at));
  const def = definitionOf(r);
  const { results: dailyRows } = await db
    .prepare("SELECT day, variant, exposed, sample_interval AS si FROM experiment_daily WHERE experiment_id = ? ORDER BY day, variant")
    .bind(r.id)
    .all<{ day: string; variant: string; exposed: number; si: number }>();
  const daily = dailyRows.map(({ day, variant, exposed }) => ({ day, variant, exposed }));
  const lists = exposures.lists;
  const notes = [...exposures.notes];
  let approximate = exposures.approximate;
  const snapshotSampled = dailyRows.some((d) => d.si > 1);

  const counts: { exposed: number; trials: number; paid: number; revenue: number; proceeds: number }[] = [];
  for (const v of def.variants) {
    if (!lists) {
      counts.push({ exposed: daily.filter((d) => d.variant === v.id).reduce((s, d) => s + d.exposed, 0), trials: 0, paid: 0, revenue: 0, proceeds: 0 });
      continue;
    }
    const list = lists[v.id] ?? [];
    const first = new Map(list);
    const trials = new Set<string>();
    const paid = new Set<string>();
    let revenue = 0;
    let proceeds = 0;
    const ids = [...first.keys()];
    // CROSS JOIN keeps install_links as the outer loop (one index probe per install) and `+t.purchased_at` keeps the
    // time range off the index: each link reads only its own transactions (idx_tx_original), never a range of the
    // app's transactions. The subquery (when original_purchased_at is missing) reads the same subscription's rows.
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { results } = await db
        .prepare(
          `SELECT l.install_id AS install, t.kind, t.purchased_at AS at, t.gross_usd AS gross, t.proceeds_usd AS proceeds, ${KEPT} AS kept,
             COALESCE(t.original_purchased_at, (SELECT MIN(o.purchased_at) FROM transactions o WHERE o.app_id = t.app_id AND o.original_transaction_id = t.original_transaction_id)) AS orig
           FROM install_links l CROSS JOIN transactions t ON t.app_id = l.app_id AND t.original_transaction_id = l.original_transaction_id
           WHERE l.app_id = ? AND l.install_id IN (${chunk.map(() => "?").join(",")}) AND t.environment = 'Production'
             AND +t.purchased_at >= ? AND +t.purchased_at < ? AND (t.kind = 'trial' OR t.gross_usd > 0)`,
        )
        .bind(r.app_id, ...chunk, w.from - EXPOSURE_GRACE_MS, w.to)
        .all<Purchase>();
      for (const p of results) {
        const exposedAt = first.get(p.install);
        // Only what began after the install's first exposure: a subscription bought (or a trial started) before it
        // was not influenced by the variant, nor are its renewals.
        if (exposedAt === undefined || p.at < exposedAt - EXPOSURE_GRACE_MS || (p.orig ?? p.at) < exposedAt - EXPOSURE_GRACE_MS) continue;
        if (p.kind === "trial") trials.add(p.install);
        else {
          revenue += p.gross * p.kept;
          proceeds += p.proceeds * p.kept;
          if (p.kept > 0 && FIRST_PAID_KINDS.has(p.kind)) paid.add(p.install);
        }
      }
    }
    counts.push({ exposed: list.length, trials: trials.size, paid: paid.size, revenue: revenue * rate, proceeds: proceeds * rate });
  }
  if (!lists && daily.length) notes.push("Exposures are the sum of the daily snapshots: installs exposed on several days count more than once.");
  if (snapshotSampled) {
    notes.push("Analytics Engine sampled some days' exposure events: those daily counts are scaled by the sample interval (approximate).");
    if (!lists) approximate = true;
  }

  const measured = !!lists && counts.some((c) => c.exposed > 0);
  const trialStats = measured ? compareRates(counts.map((c) => ({ n: c.exposed, x: c.trials })), { seed: seedOf(`${r.id}:trial`) }) : null;
  const paidStats = measured ? compareRates(counts.map((c) => ({ n: c.exposed, x: c.paid })), { seed: seedOf(`${r.id}:paid`) }) : null;
  const per = (x: number, n: number) => (n ? x / n : null);
  const variants: ExperimentVariantResult[] = def.variants.map((v, i) => {
    const c = counts[i];
    return {
      variant: v.id,
      name: v.name,
      weight: v.weight,
      exposed: c.exposed,
      trials: c.trials,
      trialRate: lists ? per(c.trials, c.exposed) : null,
      paid: c.paid,
      paidRate: lists ? per(c.paid, c.exposed) : null,
      revenue: c.revenue,
      proceeds: c.proceeds,
      revenuePerInstall: lists ? per(c.revenue, c.exposed) : null,
      proceedsPerInstall: lists ? per(c.proceeds, c.exposed) : null,
      probabilityBest: { trial_started: trialStats?.probabilityBest[i] ?? null, paid: paidStats?.probabilityBest[i] ?? null },
      lift: { trial_started: trialStats?.lift[i] ?? null, paid: paidStats?.lift[i] ?? null },
    };
  });
  const daysRunning = (w.to - w.from) / DAY;
  const reasons = guardrails(daysRunning, counts, def.primaryMetric);
  if (!lists) reasons.push("Conversions need the exposed installs from Analytics Engine.");
  const enoughData = reasons.length === 0;
  let confident: ExperimentResults["confident"] = null;
  if (enoughData && def.primaryMetric !== "revenue_per_install") {
    const key = def.primaryMetric;
    const best = variants.reduce((a, b) => ((b.probabilityBest[key] ?? 0) > (a.probabilityBest[key] ?? 0) ? b : a));
    const p = best.probabilityBest[key] ?? 0;
    if (p >= 0.95) confident = { variant: best.variant, probability: p };
  }
  const frozen = r.status !== "running";
  const results: ExperimentResults = {
    experimentId: r.id,
    status: r.status,
    primaryMetric: def.primaryMetric,
    currency,
    from: w.from,
    to: w.to,
    daysRunning: Math.round(daysRunning * 10) / 10,
    variants,
    enoughData,
    reasons,
    confident,
    exposureSource: lists ? "events" : daily.length ? "snapshot" : "none",
    approximate,
    notes,
    daily,
    frozen,
    generatedAt: at,
  };
  await db.prepare("UPDATE experiments SET results = ?, results_at = ?, frozen = ? WHERE id = ?").bind(JSON.stringify(results), at, frozen ? 1 : 0, r.id).run();

  const alertKey = `experiment_result:${r.id}`;
  if (confident && r.status === "running") {
    const app = await db.prepare("SELECT name FROM apps WHERE id = ?").bind(r.app_id).first<{ name: string }>();
    const v = variants.find((x) => x.variant === confident!.variant)!;
    const metric = def.primaryMetric === "trial_started" ? "trial start rate" : "paid conversion rate";
    const lift = def.primaryMetric === "trial_started" ? v.lift.trial_started : v.lift.paid;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    // No push: the iOS app has no texts for it yet (loc-keys); the alert shows in Alerts and the web app.
    await raiseAlert(env, db, {
      workspaceId: r.workspace_id,
      appId: r.app_id,
      key: alertKey,
      kind: "experiment_result",
      severity: "info",
      title: `Experiment "${r.name}" in ${app?.name ?? "an app"}: ${v.name} (${v.variant}) is ahead`,
      body:
        `${v.name} has a ${pct(confident.probability)} probability to have the best ${metric} (${pct((def.primaryMetric === "trial_started" ? v.trialRate : v.paidRate) ?? 0)} of ${v.exposed} exposed installs)` +
        (lift ? `, ${lift.expected >= 0 ? "+" : ""}${pct(lift.expected)} against the control (95% interval ${pct(lift.low)} to ${pct(lift.high)})` : "") +
        `. Stop the experiment and roll out the winner when you are ready.`,
    });
  } else if (!confident) {
    // A later computation is no longer confident: the alert's claim does not hold any more (exact key: index probe).
    await db.prepare("UPDATE alerts SET resolved_at = ? WHERE workspace_id = ? AND key = ? AND resolved_at IS NULL").bind(now(), r.workspace_id, alertKey).run();
  }
  return results;
}

/**
 * GET …/results (mode "missing": the stored results, computed only when there are none yet or once more after the
 * stop) and POST …/results/refresh (mode "refresh", at most once an hour). Everything runs in the database object.
 */
export async function experimentResults(env: Env, workspaceId: string, appId: string, id: string, opts: { at?: number; mode?: ResultsMode } = {}): Promise<ResultsOutcome> {
  return computeExperimentResults(env, { workspaceId, appId, experimentId: id, at: opts.at ?? now(), mode: opts.mode ?? "missing" });
}

// --- Cron: auto-stop, daily snapshot, periodic results ---------------------------------------------------------------

/**
 * Every insights tick (inside the database object): running experiments past 90 days are stopped (index range,
 * usually no row). From 02:00 UTC, once a day per running experiment: one Analytics Engine query for the exposed
 * installs per variant of the last days (experiment_daily). Then, at most RESULTS_PER_TICK a tick: the results of
 * running experiments not computed for RESULTS_INTERVAL_MS (one query per variant; they raise or resolve the
 * experiment_result alert) and the final results of ended experiments nobody opened. Every query comes from the tick's
 * budget, every computation from the daily background budget.
 */
export async function cronExperiments(env: Env, db: Db, at: number, budget: SendBudget | null): Promise<Record<string, unknown>> {
  const log: Record<string, unknown> = {};
  const stopped = await db
    .prepare(
      `UPDATE experiments SET status = 'stopped', stopped_at = started_at + ${EXPERIMENT_LIMITS.maxDays * DAY}, results_at = NULL, updated_at = ?
       WHERE status = 'running' AND started_at <= ?`,
    )
    .bind(at, at - EXPERIMENT_LIMITS.maxDays * DAY)
    .run();
  if (stopped.meta.changes) log.stopped = stopped.meta.changes;
  if (!budget) return log;
  let snapshots = 0;
  let computed = 0;
  const errors: string[] = [];
  let more = false;

  const today = dayOf(at);
  const doneKey = `experiments_snapshot_done:${today}`;
  if (new Date(at).getUTCHours() >= SNAPSHOT_HOUR && !(await getSetting(db, doneKey))) {
    const LIMIT = 50;
    const { results: rows } = await db
      .prepare("SELECT * FROM experiments WHERE status = 'running' AND COALESCE(snapshot_day, '') < ? ORDER BY started_at LIMIT ?")
      .bind(today, LIMIT)
      .all<ExperimentRow>();
    let snapshotsLeft = false;
    const todayStart = Date.parse(`${today}T00:00:00Z`);
    for (const r of rows) {
      if (snapshots >= SNAPSHOTS_PER_TICK || !budget.take(1)) {
        snapshotsLeft = more = true;
        break;
      }
      const def = definitionOf(r);
      try {
        const { dataset } = analyticsConfig(env);
        // The last 3 days again: events queued offline arrive late.
        const from = Math.max(r.started_at ?? todayStart, Date.parse(`${addDays(today, -3)}T00:00:00Z`));
        const out = await runSql(env, snapshotSql(dataset, r.app_id, r.id, def.variants.map((v) => v.id), Math.floor(from / 300_000) * 300_000, todayStart, await appTestInstalls(db, r.app_id)));
        const stmts = [];
        for (const row of out) {
          const day = String(row.day ?? "").slice(0, 10);
          const variant = String(row.v ?? "").split(":")[1] ?? "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !def.variants.some((v) => v.id === variant)) continue;
          // Sampled days: a stored event stands for `si` events, so distinct installs are scaled (approximate).
          const si = Math.max(1, Math.round(num(row.si)) || 1);
          stmts.push(
            db
              .prepare(
                `INSERT INTO experiment_daily (experiment_id, variant, day, exposed, sample_interval) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(experiment_id, day, variant) DO UPDATE SET exposed = excluded.exposed, sample_interval = excluded.sample_interval
                 WHERE experiment_daily.exposed != excluded.exposed OR experiment_daily.sample_interval != excluded.sample_interval`,
              )
              .bind(r.id, variant, day, Math.round(num(row.exposed) * si), si),
          );
        }
        if (stmts.length) await db.batch(stmts);
      } catch (err) {
        errors.push(`${r.id}: ${errorMessage(err)}`);
      }
      // Marked done even when the query failed: each snapshot re-queries the last 3 days, so tomorrow's run fills the
      // days missed today (and a failing query is not retried every tick at the cost of the tick's budget).
      await db.prepare("UPDATE experiments SET snapshot_day = ? WHERE id = ?").bind(today, r.id).run();
      snapshots++;
    }
    if (!snapshotsLeft && rows.length < LIMIT) await setSetting(db, doneKey, String(at));
  }

  // Results: running experiments whose results are older than RESULTS_INTERVAL_MS (the oldest first), then the final
  // results of ended experiments (stopped by hand or after 90 days, rolled out, archived) nobody opened, while
  // Analytics Engine still has their exposures.
  const { results: due } = await db
    .prepare(
      `SELECT * FROM (SELECT * FROM experiments WHERE status = 'running' AND started_at IS NOT NULL AND COALESCE(results_at, 0) <= ? ORDER BY COALESCE(results_at, 0) LIMIT ?)
       UNION ALL SELECT * FROM (SELECT * FROM experiments WHERE status IN ('stopped', 'rolled_out', 'archived') AND started_at IS NOT NULL AND frozen = 0 ORDER BY stopped_at LIMIT ?)`,
    )
    .bind(at - RESULTS_INTERVAL_MS, RESULTS_PER_TICK + 1, RESULTS_PER_TICK + 1)
    .all<ExperimentRow>();
  for (const r of due) {
    if (computed >= RESULTS_PER_TICK || !budget.take(definitionOf(r).variants.length)) {
      more = true;
      break;
    }
    computed++;
    try {
      const out = await computeExperimentResults(env, { workspaceId: r.workspace_id, experimentId: r.id, at, mode: "cron" });
      if (out.status !== 200) errors.push(`${r.id} results: ${out.error}`);
      else if (out.results.notes.includes(BUDGET_USED)) {
        // Today's background budget is used up: nothing more until 00:00 UTC.
        computed--;
        log.budget = "used up";
        break;
      }
    } catch (err) {
      // Retried at a later tick (or computed when someone opens it).
      errors.push(`${r.id} results: ${errorMessage(err)}`);
    }
  }
  if (snapshots) log.snapshots = snapshots;
  if (computed) log.results = computed;
  if (errors.length) log.errors = errors;
  if (more) log.more = true;
  return log;
}
