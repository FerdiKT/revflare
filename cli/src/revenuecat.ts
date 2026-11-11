// RevenueCat Charts through the user's local, OAuth-authenticated `revenuecat` CLI (never a secret key here).
// Used by `revflare import revenuecat-charts` to push daily history into POST /imports/external-metrics.

import { execFile } from "node:child_process";
import type { Exec } from "./context.js";
import { CliError } from "./errors.js";
import type { ExternalMetric } from "./types.js";

export interface RcProject {
  id: string;
  name: string;
  created_at: number;
}

export interface RcApp {
  id: string;
  name: string;
  type: string;
  project_id: string;
  app_store?: { bundle_id: string | null } | null;
}

interface RcEnvelope<T> {
  ok: boolean;
  data: T | null;
  error: { type?: string; message?: string; status_code?: number; retry_after?: number } | null;
}

interface RcChart {
  measures: { display_name: string; unit: string }[] | null;
  values: { cohort: number; incomplete: boolean; measure: number; value: number; segment?: number }[] | null;
  user_selectors: Record<string, string> | null;
  yaxis_currency?: string | null;
}

/** How one Revflare metric is read from RevenueCat Charts. */
export interface MetricSpec {
  metric: ExternalMetric;
  chart: string;
  /** Measures (display names) summed into the value. */
  measures: string[];
  selectors?: Record<string, string>;
  money?: boolean;
  /** Imported only when asked for with --metric (the definitions differ, see `note`). */
  optIn?: boolean;
  note?: string;
}

export const RC_METRICS: MetricSpec[] = [
  { metric: "revenue", chart: "revenue", measures: ["Revenue"], selectors: { revenue_type: "revenue" }, money: true },
  { metric: "proceeds", chart: "revenue", measures: ["Proceeds"], selectors: { revenue_type: "proceeds" }, money: true },
  { metric: "mrr", chart: "mrr", measures: ["MRR"], selectors: { revenue_type: "revenue" }, money: true },
  { metric: "active_subscriptions", chart: "actives", measures: ["Actives"] },
  { metric: "active_trials", chart: "trials", measures: ["Active Trials"] },
  // Paid subscriptions that start (Revflare: kinds new + conversion); product changes are not new subscriptions.
  { metric: "new_subscriptions", chart: "actives_new", measures: ["Trial Conversions", "Intro Offers", "Direct Subscriptions", "Resubscriptions"] },
  { metric: "trials_started", chart: "trials_new", measures: ["New Trials"] },
  { metric: "refunds", chart: "refunds", measures: ["Refunded Transactions"] },
  { metric: "churned_subscriptions", chart: "actives_movement", measures: ["Churned Actives"] },
  {
    metric: "new_customers",
    chart: "customers_new",
    measures: ["New Customers"],
    optIn: true,
    note: "RevenueCat counts every new app user (SDK install); Revflare counts customers with a first purchase or trial",
  },
];

/** Runs the real binary; a non-zero exit with JSON on stdout is returned (the envelope carries the error). */
export const execRevenuecat: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 180_000 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(new CliError(`"${cmd}" not found. Install the RevenueCat CLI and run \`revenuecat auth login\`, or pass --revenuecat-bin <path>.`));
      }
      if (err && !stdout.trim().startsWith("{")) return reject(new CliError(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${(stderr || err.message).trim().slice(0, 500)}`));
      resolve(stdout);
    });
  });

export class RcClient {
  constructor(
    private readonly exec: Exec,
    private readonly bin = "revenuecat",
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async call<T>(args: string[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const out = await this.exec(this.bin, [...args, "--json"]);
      let env: RcEnvelope<T>;
      try {
        env = JSON.parse(out);
      } catch {
        throw new CliError(`Unexpected output from ${this.bin} ${args.slice(0, 3).join(" ")}: ${out.slice(0, 300)}`);
      }
      if (env.ok && env.data) return env.data;
      const e = env.error ?? {};
      const limited = e.status_code === 429 || /rate.?limit/i.test(`${e.type} ${e.message}`);
      if (limited && attempt < 6) {
        await this.sleep((e.retry_after ? e.retry_after * 1000 : 2000 * 2 ** attempt) + 250);
        continue;
      }
      if (e.status_code === 401 || /auth/i.test(e.type ?? "")) throw new CliError(`RevenueCat: ${e.message ?? "unauthorized"} (run \`revenuecat auth login\`)`);
      throw new RcCallError(e.message ?? `${this.bin} ${args.slice(0, 3).join(" ")} failed`, e.status_code);
    }
  }

  async projects(): Promise<RcProject[]> {
    return (await this.call<{ items: RcProject[] }>(["projects", "list"])).items;
  }

  async apps(projectId: string): Promise<RcApp[]> {
    return (await this.call<{ items: RcApp[] }>(["apps", "list", "--project-id", projectId])).items;
  }

  /** Daily values of `spec` for one RevenueCat app over [from, to] (complete days only), by day. */
  async daily(projectId: string, appId: string, spec: MetricSpec, from: string, to: string): Promise<Map<string, number>> {
    try {
      return await this.dailyRange(projectId, appId, spec, from, to);
    } catch (err) {
      // Long ranges: retry year by year.
      if (!(err instanceof RcCallError) || daysBetween(from, to) <= 366) throw err;
      const out = new Map<string, number>();
      for (const [f, t] of chunkRange(from, to, 365)) for (const [d, v] of await this.dailyRange(projectId, appId, spec, f, t)) out.set(d, v);
      return out;
    }
  }

  private async dailyRange(projectId: string, appId: string, spec: MetricSpec, from: string, to: string): Promise<Map<string, number>> {
    const args = ["metrics", "chart", spec.chart, "--project-id", projectId, "--param", "resolution=day", "--param", `start_date=${from}`, "--param", `end_date=${to}`];
    args.push("--filters-json", JSON.stringify([{ name: "app_id", values: [appId] }]));
    if (spec.selectors) args.push("--selectors-json", JSON.stringify(spec.selectors));
    const chart = await this.call<RcChart>(args);
    return parseChart(chart, spec);
  }
}

export class RcCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RcCallError";
  }
}

/** Day → value (sum of the spec's measures). Throws when the chart does not have the measures or ignored a selector. */
export function parseChart(chart: RcChart, spec: MetricSpec): Map<string, number> {
  const names = (chart.measures ?? []).map((m) => m.display_name.toLowerCase());
  const idx = spec.measures.map((m) => names.indexOf(m.toLowerCase()));
  const missing = spec.measures.filter((_, i) => idx[i] < 0);
  if (missing.length) throw new RcCallError(`chart ${spec.chart} has no measure ${missing.join(", ")} (measures: ${(chart.measures ?? []).map((m) => m.display_name).join(", ")})`);
  for (const [k, v] of Object.entries(spec.selectors ?? {})) {
    if (chart.user_selectors && chart.user_selectors[k] !== undefined && chart.user_selectors[k] !== v) throw new RcCallError(`chart ${spec.chart} ignored ${k}=${v}`);
  }
  if (spec.money && chart.yaxis_currency && chart.yaxis_currency !== "USD") throw new RcCallError(`chart ${spec.chart} is in ${chart.yaxis_currency}, not USD`);
  const wanted = new Set(idx);
  const out = new Map<string, number>();
  for (const v of chart.values ?? []) {
    // Unsegmented charts have no `segment`; segmented ones list the total as segment 0.
    if (!wanted.has(v.measure) || v.incomplete || (typeof v.segment === "number" && v.segment !== 0)) continue;
    if (typeof v.value !== "number" || !Number.isFinite(v.value)) continue;
    const day = new Date(v.cohort * 1000).toISOString().slice(0, 10);
    out.set(day, (out.get(day) ?? 0) + v.value);
  }
  return out;
}

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return dayOf(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** [from, to] split into consecutive ranges of at most `size` days. */
export function chunkRange(from: string, to: string, size: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let f = from; f <= to; f = addDays(f, size)) {
    const t = addDays(f, size - 1);
    out.push([f, t < to ? t : to]);
  }
  return out;
}

/** Splits points into request bodies of at most `max` points. */
export function chunk<T>(items: T[], max: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += max) out.push(items.slice(i, i + max));
  return out;
}
