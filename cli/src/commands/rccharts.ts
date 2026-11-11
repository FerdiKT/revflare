// `revflare import revenuecat-charts`: RevenueCat Charts daily history → POST /imports/external-metrics.

import { list, str } from "../args.js";
import type { Command } from "../context.js";
import { QuotaError, UsageError, untilUtcMidnight } from "../errors.js";
import { c, eprintln, fmtNum, println, printJson, table } from "../format.js";
import { RC_METRICS, RcCallError, RcClient, addDays, chunk, dayOf, execRevenuecat, type MetricSpec, type RcApp, type RcProject } from "../revenuecat.js";
import type { App, ExternalMetric, ExternalMetricsSummary } from "../types.js";

export const MAX_POINTS = 5000;

export interface Source {
  project: RcProject;
  app: RcApp;
  bundleId: string;
}

export interface Target {
  app: App;
  sources: Source[];
}

export interface ProjectMapping {
  project: RcProject;
  /** App Store apps of the project and the Revflare app each maps to (null: no Revflare app with that bundle id). */
  apps: { rcApp: RcApp; bundleId: string; revflare: App | null }[];
  skipped: string | null;
}

/** Maps RevenueCat projects to Revflare apps through the bundle ids of their App Store apps. */
export function mapProjects(projects: RcProject[], appsByProject: Map<string, RcApp[]>, revflareApps: App[]): { mappings: ProjectMapping[]; targets: Target[] } {
  const byBundle = new Map<string, App>();
  // Active apps win over archived duplicates.
  for (const a of [...revflareApps].sort((x, y) => Number(y.archived) - Number(x.archived))) if (a.bundleId) byBundle.set(a.bundleId.toLowerCase(), a);
  const targets = new Map<string, Target>();
  const mappings: ProjectMapping[] = [];
  for (const project of projects) {
    const appStore = (appsByProject.get(project.id) ?? []).filter((a) => a.type === "app_store" && a.app_store?.bundle_id);
    const apps = appStore.map((rcApp) => {
      const bundleId = rcApp.app_store!.bundle_id!;
      return { rcApp, bundleId, revflare: byBundle.get(bundleId.toLowerCase()) ?? null };
    });
    let skipped: string | null = null;
    if (!appStore.length) skipped = "no App Store app in the project";
    else if (!apps.some((a) => a.revflare)) skipped = `no Revflare app with bundle id ${apps.map((a) => a.bundleId).join(", ")}`;
    mappings.push({ project, apps, skipped });
    for (const a of apps) {
      if (!a.revflare) continue;
      let t = targets.get(a.revflare.id);
      if (!t) targets.set(a.revflare.id, (t = { app: a.revflare, sources: [] }));
      t.sources.push({ project, app: a.rcApp, bundleId: a.bundleId });
    }
  }
  return { mappings, targets: [...targets.values()] };
}

/**
 * True when the server already holds `metric` for the app over the whole span of `points` (first to last day), so
 * re-sending would change nothing: a finished earlier run, or the part of one that got through before a budget stop.
 */
export function alreadyImported(summary: ExternalMetricsSummary["items"], appId: string, metric: string, points: { day: string }[]): boolean {
  if (!points.length) return false;
  const have = summary.find((s) => s.appId === appId && s.metric === metric);
  return !!have && have.first <= points[0].day && have.last >= points[points.length - 1].day;
}

/** Points to send: complete days before `cutoff` (Revflare's own history), zeros dropped unless `keepZeros`, sorted. */
export function toPoints(values: Map<string, number>, opts: { cutoff?: string | null; keepZeros?: boolean } = {}): { day: string; value: number }[] {
  return [...values.entries()]
    .filter(([day, v]) => (!opts.cutoff || day < opts.cutoff) && (opts.keepZeros || Math.abs(v) > 1e-9))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, value]) => ({ day, value: Math.round(value * 100) / 100 }));
}

interface MetricResult {
  metric: ExternalMetric;
  /** Points read from RevenueCat (to send). */
  points: number;
  /** Points stored in Revflare by this run. */
  sent: number;
  /** Already in Revflare up to the last day (not sent again; --force sends anyway). */
  alreadyImported?: boolean;
  /** Not (completely) sent: the daily budget / quota stopped the import. */
  stopped?: boolean;
  from: string | null;
  to: string | null;
  uploaded: boolean;
  skipped?: string;
}

interface TargetResult {
  appId: string;
  appName: string;
  bundleId: string | null;
  projects: string[];
  cutoff: string | null;
  metrics: MetricResult[];
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export const importRevenuecatCharts: Command = {
  name: "import revenuecat-charts",
  summary: "Import RevenueCat Charts daily history (revenue, proceeds, MRR, actives, trials...) for every RevenueCat project.",
  description:
    "Reads RevenueCat through your local `revenuecat` CLI (OAuth: `revenuecat auth login`), maps each project to Revflare apps\n" +
    "by the bundle ids of its App Store apps, reads each chart filtered to that App Store app (USD) from the project's\n" +
    "creation day, and stores it with POST /imports/external-metrics (source \"revenuecat\"). Revflare shows imported values\n" +
    "only for days before its own history of the app, so only those days are sent (--all-days sends everything); zero days\n" +
    "are skipped. Metrics Revflare already holds up to the last day are not sent again (--force sends them anyway); the\n" +
    "server only rewrites changed values. --replace first deletes the app's imported RevenueCat history.\n" +
    "On the Cloudflare Free plan imports have a daily database budget: when it is used up the import stops (exit code 3)\n" +
    "and re-running the same command after 00:00 UTC continues where it stopped.\n" +
    `Metrics: ${RC_METRICS.filter((m) => !m.optIn).map((m) => m.metric).join(", ")}.\n` +
    `Opt-in with --metric: ${RC_METRICS.filter((m) => m.optIn).map((m) => `${m.metric} (${m.note})`).join("; ")}.`,
  options: {
    project: { type: "string", short: "p", multiple: true, arg: "<id|name>", description: "Only these RevenueCat projects (repeatable)" },
    metric: { type: "string", short: "m", multiple: true, arg: "<metric>", description: "Only these metrics (repeatable, comma separated)" },
    "dry-run": { type: "boolean", description: "Read RevenueCat and show what would be imported, without writing to Revflare" },
    "all-days": { type: "boolean", description: "Also send days Revflare already covers with its own data" },
    "keep-zeros": { type: "boolean", description: "Also send days whose value is 0" },
    replace: { type: "boolean", description: "Delete the app's previously imported RevenueCat history first" },
    force: { type: "boolean", description: "Send metrics even when Revflare already has them up to the last day" },
    "revenuecat-bin": { type: "string", arg: "<path>", description: "The revenuecat CLI (default: revenuecat on PATH; env REVENUECAT_BIN)" },
  },
  max: 0,
  examples: ["revflare import revenuecat-charts --dry-run", "revflare import revenuecat-charts", "revflare import revenuecat-charts --project proj1a2b3c4d --metric mrr,revenue"],
  async run(ctx, { values }) {
    const specs = selectSpecs(list(values.metric));
    const dryRun = !!values["dry-run"];
    const log = (s: string) => (ctx.json ? undefined : eprintln(s));
    const rc = new RcClient(ctx.deps.exec ?? execRevenuecat, str(values["revenuecat-bin"]) || ctx.env.REVENUECAT_BIN || "revenuecat", (ms) => ctx.sleep(ms));

    log(c.gray("Reading RevenueCat projects..."));
    const allProjects = await rc.projects();
    const wanted = list(values.project).flatMap((p) => p.split(",")).map((p) => p.trim()).filter(Boolean);
    for (const w of wanted) if (!allProjects.some((p) => p.id === w || p.name.trim().toLowerCase() === w.toLowerCase())) throw new UsageError(`No RevenueCat project "${w}". Projects: ${allProjects.map((p) => `${p.id} (${p.name.trim()})`).join(", ")}`);
    const selected = (p: RcProject) => !wanted.length || wanted.some((w) => p.id === w || p.name.trim().toLowerCase() === w.toLowerCase());
    // Apps of every project: a bundle id shared by several projects is summed into one Revflare app.
    const appLists = await pool(allProjects, 4, (p) => rc.apps(p.id));
    const appsByProject = new Map(allProjects.map((p, i) => [p.id, appLists[i]]));
    let revflareApps: App[];
    let serverOk = true;
    try {
      revflareApps = (await ctx.apps()).items;
    } catch (err) {
      if (!dryRun || err instanceof QuotaError) throw err;
      serverOk = false;
      // Dry run without a reachable server: pretend every App Store bundle id has a Revflare app.
      log(c.yellow(`Cannot list Revflare apps (${(err as Error).message}); dry run maps every App Store app.`));
      revflareApps = [...new Set(appLists.flat().filter((a) => a.type === "app_store" && a.app_store?.bundle_id).map((a) => a.app_store!.bundle_id!))].map((b) => placeholderApp(b));
    }
    const { mappings, targets } = mapProjects(allProjects, appsByProject, revflareApps);
    const chosen = targets.filter((t) => t.sources.some((s) => selected(s.project)));

    const today = dayOf(ctx.now.getTime());
    const results: TargetResult[] = [];
    const force = !!values.force || !!values.replace;
    /** Set when the server answers 429 budget / 503 quota: nothing more is sent. */
    let stop: { error: QuotaError; appId: string; appName: string; metric: ExternalMetric | null } | null = null;
    let n = 0;
    for (const t of chosen) {
      if (stop) break;
      n++;
      const cutoff = values["all-days"] ? null : t.app.historyBackfilledFrom;
      const label = `[${n}/${chosen.length}] ${t.app.name} (${t.app.bundleId})`;
      const result: TargetResult = { appId: t.app.id, appName: t.app.name, bundleId: t.app.bundleId, projects: t.sources.map((s) => s.project.id), cutoff, metrics: [] };
      results.push(result);
      const to = cutoff && addDays(cutoff, -1) < today ? addDays(cutoff, -1) : today;
      const ranges = t.sources.map((s) => ({ s, from: dayOf(s.project.created_at) })).filter((r) => r.from <= to);
      if (!ranges.length) {
        log(`${label}: ${c.gray(`skipped, Revflare has its own data from ${cutoff}, before the RevenueCat project`)}`);
        for (const spec of specs) result.metrics.push({ metric: spec.metric, points: 0, sent: 0, from: null, to: null, uploaded: false, skipped: `Revflare's own history starts ${cutoff}` });
        continue;
      }
      let summary: ExternalMetricsSummary["items"] = [];
      try {
        if (values.replace && !dryRun) await ctx.api.delete(`/imports/external-metrics?appId=${encodeURIComponent(t.app.id)}&source=revenuecat`);
        if (!force && serverOk) summary = (await ctx.api.get<ExternalMetricsSummary>("/imports/external-metrics", { appId: t.app.id, source: "revenuecat" })).items;
      } catch (err) {
        if (!(err instanceof QuotaError)) throw err;
        stop = { error: err, appId: t.app.id, appName: t.app.name, metric: null };
        break;
      }
      log(`${label}: ${ranges.map((r) => `${r.s.project.name.trim()} from ${r.from}`).join(", ")} to ${to}`);
      const perMetric = await pool(specs, 3, async (spec): Promise<MetricResult> => {
        if (stop) return { metric: spec.metric, points: 0, sent: 0, from: null, to: null, uploaded: false, skipped: "not sent (stopped)", stopped: true };
        const sum = new Map<string, number>();
        const errors: string[] = [];
        for (const r of ranges) {
          try {
            for (const [d, v] of await rc.daily(r.s.project.id, r.s.app.id, spec, r.from, to)) sum.set(d, (sum.get(d) ?? 0) + v);
          } catch (err) {
            if (!(err instanceof RcCallError)) throw err;
            errors.push(`${r.s.project.id}: ${err.message}`);
          }
        }
        const points = toPoints(sum, { cutoff, keepZeros: !!values["keep-zeros"] });
        const res: MetricResult = { metric: spec.metric, points: points.length, sent: 0, from: points[0]?.day ?? null, to: points[points.length - 1]?.day ?? null, uploaded: false };
        if (errors.length === ranges.length) res.skipped = `RevenueCat error: ${errors.join("; ")}`;
        else if (!points.length) res.skipped = "no data";
        else if (!force && alreadyImported(summary, t.app.id, spec.metric, points)) {
          res.alreadyImported = true;
          res.skipped = `already imported up to ${res.to}`;
        }
        if (!res.skipped && !dryRun) {
          try {
            for (const part of chunk(points, MAX_POINTS)) {
              if (stop) break;
              await ctx.api.post("/imports/external-metrics", { appId: t.app.id, source: "revenuecat", metric: spec.metric, points: part });
              res.sent += part.length;
            }
          } catch (err) {
            if (!(err instanceof QuotaError)) throw err;
            stop ??= { error: err, appId: t.app.id, appName: t.app.name, metric: spec.metric };
          }
          res.uploaded = res.sent === res.points;
          if (!res.uploaded) res.stopped = true;
          if (!res.uploaded) res.skipped = `stopped after ${fmtNum(res.sent)} of ${fmtNum(res.points)} points`;
        }
        log(`  ${spec.metric.padEnd(22)} ${res.skipped ? c.gray(res.skipped) : `${fmtNum(res.points)} points ${res.from} → ${res.to}${dryRun ? c.gray(" (dry run)") : c.green(" ✓")}`}`);
        return res;
      });
      result.metrics.push(...perMetric);
    }

    const shown = mappings.filter((m) => selected(m.project));
    const sent = results.reduce((s, r) => s + r.metrics.reduce((a, m) => a + m.sent, 0), 0);
    const already = results.reduce((s, r) => s + r.metrics.filter((m) => m.alreadyImported).length, 0);
    if (stop) process.exitCode = 3;
    const stopped = stop && {
      code: stop.error.code,
      message: stop.error.message,
      appId: stop.appId,
      metric: stop.metric,
      appsDone: results.filter((r) => r.metrics.length === specs.length && !r.metrics.some((m) => m.stopped)).length,
      appsTotal: chosen.length,
      pointsSent: sent,
    };
    if (ctx.json) {
      return printJson({
        dryRun,
        stopped: stopped || null,
        metrics: specs.map((s) => s.metric),
        projects: shown.map((m) => ({
          id: m.project.id,
          name: m.project.name.trim(),
          createdAt: dayOf(m.project.created_at),
          apps: m.apps.map((a) => ({ rcAppId: a.rcApp.id, bundleId: a.bundleId, revflareAppId: a.revflare?.id ?? null })),
          skipped: m.skipped,
        })),
        apps: results,
      });
    }
    println("");
    println(
      table(
        [{ header: "PROJECT" }, { header: "NAME", flex: true }, { header: "BUNDLE ID", flex: true }, { header: "REVFLARE APP" }, { header: "POINTS", align: "right" }, { header: "RANGE" }, { header: "NOTE", flex: true }],
        shown.map((m) => {
          const app = m.apps.find((a) => a.revflare)?.revflare;
          const r = app ? results.find((x) => x.appId === app.id) : undefined;
          const total = r?.metrics.reduce((s, x) => s + (dryRun ? x.points : x.sent), 0) ?? 0;
          const days = r?.metrics.flatMap((x) => [x.from, x.to]).filter((d): d is string => !!d).sort() ?? [];
          const skippedMetrics = r?.metrics.filter((x) => x.skipped && x.skipped !== "no data" && !x.alreadyImported).map((x) => x.metric) ?? [];
          const doneMetrics = r?.metrics.filter((x) => x.alreadyImported).length ?? 0;
          return [
            m.project.id,
            m.project.name.trim(),
            m.apps.map((a) => a.bundleId).join(", ") || "-",
            app?.id ?? "-",
            r ? fmtNum(total) : "",
            days.length ? `${days[0]} → ${days[days.length - 1]}` : "",
            m.skipped
              ? c.yellow(m.skipped)
              : skippedMetrics.length
                ? c.yellow(`skipped: ${skippedMetrics.join(", ")}`)
                : doneMetrics
                  ? c.gray(`${doneMetrics} already imported${r?.cutoff ? `, before ${r.cutoff}` : ""}`)
                  : r?.cutoff
                    ? c.gray(`before ${r.cutoff}`)
                    : "",
          ];
        }),
      ),
    );
    const total = results.reduce((s, r) => s + r.metrics.reduce((a, m) => a + (m.alreadyImported ? 0 : m.points), 0), 0);
    const alreadyNote = already ? ` ${already} metric${already === 1 ? "" : "s"} already imported, not sent again (--force sends them).` : "";
    if (stopped) {
      const where = `${stop!.appName}${stop!.metric ? ` (${stop!.metric})` : ""}`;
      eprintln(c.yellow(`Stopped at ${where}: ${stop!.error.message}`));
      eprintln(`Sent ${fmtNum(sent)} points; ${stopped.appsDone} of ${stopped.appsTotal} apps complete.${alreadyNote}`);
      eprintln(`Re-run the same command after 00:00 UTC (in ${untilUtcMidnight(ctx.now)}) to continue: it skips what is already imported.`);
      return;
    }
    println(dryRun ? c.gray(`Dry run: ${fmtNum(total)} points would be imported into ${results.length} apps.${alreadyNote}`) : `${c.green("✓")} Imported ${fmtNum(sent)} points into ${results.length} apps.${alreadyNote}`);
  },
};

function placeholderApp(bundleId: string): App {
  return {
    id: `(${bundleId})`,
    name: bundleId,
    platform: "ios",
    bundleId,
    appleAppId: null,
    iconUrl: null,
    commissionPct: 15,
    archived: false,
    notificationUrlStatus: "unknown",
    revflareNotificationUrl: "",
    currentNotificationUrl: null,
    lastNotificationAt: null,
    lastHistorySyncAt: null,
    historyBackfilledFrom: null,
    rcProjectId: null,
    storeAvailable: null,
    sdkKey: null,
    mrr: 0,
    revenue28d: 0,
    activeSubscriptions: 0,
    activeTrials: 0,
  };
}

export function selectSpecs(selectors: string[]): MetricSpec[] {
  const names = selectors.flatMap((s) => s.split(",")).map((s) => s.trim().replace(/-/g, "_")).filter(Boolean);
  if (!names.length) return RC_METRICS.filter((m) => !m.optIn);
  return names.map((n) => {
    const spec = RC_METRICS.find((m) => m.metric === n);
    if (!spec) throw new UsageError(`Unknown metric "${n}". Importable: ${RC_METRICS.map((m) => m.metric).join(", ")}`);
    return spec;
  });
}
