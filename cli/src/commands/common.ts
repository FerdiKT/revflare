// Options shared by the metric commands and their translation into query parameters.

import { list, str, type Options, type Parsed } from "../args.js";
import type { Ctx } from "../context.js";
import { ApiError, CliError, UsageError } from "../errors.js";
import { resolveApps } from "../resolve.js";
import { METRICS, type Metric } from "../types.js";

export const APP_OPTION: Options = {
  app: { type: "string", short: "a", multiple: true, arg: "<id|bundle>", description: "Only these apps: id, bundle id, App Store id or name (repeatable, comma separated)" },
};

export const CURRENCY_OPTION: Options = {
  currency: { type: "string", arg: "<code>", description: "Report in this currency, e.g. USD (default: the workspace's)" },
};

export const RANGE_OPTIONS: Options = {
  range: { type: "string", short: "r", arg: "<range>", description: "7d, 28d, 30d, 90d, 12m, mtd, ytd, all (or any Nd / Nm)" },
  from: { type: "string", arg: "<YYYY-MM-DD>", description: "Start day (inclusive, UTC)" },
  to: { type: "string", arg: "<YYYY-MM-DD>", description: "End day (inclusive, UTC; default today)" },
};

export const INTERVAL_OPTION: Options = {
  interval: { type: "string", short: "i", arg: "<day|week|month>", description: "Bucket size (default: by range length)" },
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function rangeQuery(values: Parsed["values"]): Record<string, string | undefined> {
  const range = str(values.range);
  const from = str(values.from);
  const to = str(values.to);
  if (range && !/^(\d+[dm]|mtd|ytd|all)$/.test(range)) throw new UsageError(`Invalid --range "${range}": use 7d, 30d, 90d, 12m, mtd, ytd or all`);
  for (const [k, v] of [["from", from], ["to", to]] as const) if (v && !DAY.test(v)) throw new UsageError(`Invalid --${k} "${v}": use YYYY-MM-DD`);
  if (range && from) throw new UsageError("Use either --range or --from/--to");
  return { range, from, to };
}

export function intervalQuery(values: Parsed["values"]): string | undefined {
  const i = str(values.interval);
  if (i && i !== "day" && i !== "week" && i !== "month") throw new UsageError(`Invalid --interval "${i}": use day, week or month`);
  return i;
}

/** `apps=` (resolved ids) and `currency=`. */
export async function scopeQuery(ctx: Ctx, values: Parsed["values"]): Promise<Record<string, string | undefined>> {
  const selectors = list(values.app);
  const currency = str(values.currency);
  if (currency && !/^[A-Za-z]{3}$/.test(currency)) throw new UsageError(`Invalid --currency "${currency}"`);
  let apps: string | undefined;
  if (selectors.length) apps = resolveApps(selectors, (await ctx.apps()).items).map((a) => a.id).join(",");
  return { apps, currency: currency?.toUpperCase() };
}

export function parseMetric(s: string | undefined, fallback: Metric): Metric {
  if (!s) return fallback;
  const m = s.replace(/-/g, "_").toLowerCase();
  if (!(METRICS as readonly string[]).includes(m)) throw new UsageError(`Unknown metric "${s}". Metrics: ${METRICS.join(", ")}`);
  return m as Metric;
}

export function positiveInt(v: string | undefined, name: string, fallback?: number): number | undefined {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

const ADMIN_HELP = "Admin commands need an instance admin's sign-in, not a workspace API key: revflare login --email <you@example.com>";

/** GET an admin route; a 403 with an API key explains how to sign in instead. */
export async function adminGet<T>(ctx: Ctx, path: string): Promise<T> {
  try {
    return await ctx.api.get<T>(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      throw new CliError(ctx.auth.key.startsWith("rf_") ? ADMIN_HELP : `${err.message} (instance admins only)`);
    }
    throw err;
  }
}
