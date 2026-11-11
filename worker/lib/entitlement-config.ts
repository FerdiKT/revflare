// Server-driven entitlements and non-renewing durations (pure part: parsing, the SDK payload, the duration math).
// Stored in `offering_configs.entitlements` (migrations/0027_entitlements.sql); changed by worker/lib/entitlements.ts;
// served to RevflareKit inside GET /sdk/v1/offerings (worker/lib/offerings.ts sdkPayload).

import { DURATION_UNITS, ENTITLEMENT_LIMITS, OFFERING_IDENTIFIER_RE, type DurationUnit, type ProductDuration, type SdkOfferings } from "../../shared/types";

export interface StoredEntitlements {
  /** Entitlement → product ids (sorted, unique). */
  entitlements: Record<string, string[]>;
  /** Product id → duration (non-renewing products, passes). */
  durations: Record<string, ProductDuration>;
}

export const EMPTY_ENTITLEMENTS: StoredEntitlements = { entitlements: {}, durations: {} };

type Fail = { error: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const PRODUCT_ID_RE = /^[\x21-\x7e]{1,255}$/;

export function validEntitlementId(v: unknown): v is string {
  return typeof v === "string" && OFFERING_IDENTIFIER_RE.test(v) && !/^\.+$/.test(v);
}

export function validProductId(v: unknown): v is string {
  return typeof v === "string" && PRODUCT_ID_RE.test(v);
}

const UNIT_ALIASES: Record<string, DurationUnit> = {
  d: "day", day: "day", days: "day",
  w: "week", week: "week", weeks: "week",
  m: "month", mo: "month", month: "month", months: "month",
  y: "year", yr: "year", year: "year", years: "year",
};

/** A duration: { unit, count } or a short form "3d", "1w", "6m", "1y", "3 days". */
export function parseDuration(v: unknown, where = "duration"): ProductDuration | Fail {
  let unit: unknown;
  let count: unknown;
  if (typeof v === "string") {
    const m = /^\s*(\d+)\s*([a-z]+)\s*$/i.exec(v);
    if (!m) return { error: `${where}: "${v}" is not a duration (e.g. 3d, 1w, 1m, 1y or { unit, count })` };
    count = Number(m[1]);
    unit = UNIT_ALIASES[m[2].toLowerCase()];
    if (!unit) return { error: `${where}: unknown unit "${m[2]}" (day, week, month or year)` };
  } else if (isObject(v)) {
    unit = typeof v.unit === "string" ? (UNIT_ALIASES[v.unit.toLowerCase()] ?? v.unit) : v.unit;
    count = v.count;
  } else return { error: `${where}: expected { unit, count } or a short form such as "3d"` };
  if (typeof unit !== "string" || !(DURATION_UNITS as readonly string[]).includes(unit)) return { error: `${where}: unit must be one of ${DURATION_UNITS.join(", ")}` };
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > ENTITLEMENT_LIMITS.maxCount) {
    return { error: `${where}: count must be a whole number from 1 to ${ENTITLEMENT_LIMITS.maxCount}` };
  }
  return { unit: unit as DurationUnit, count };
}

export function formatDuration(d: ProductDuration): string {
  return `${d.count} ${d.unit}${d.count === 1 ? "" : "s"}`;
}

/**
 * The end of a pass bought at `from` (ms): UTC calendar; day = 24 h, week = 7 days, month / year keep the day of the
 * month and the time, clamped to the month's last day (Jan 31 + 1 month = Feb 28 / 29). RevflareKit (iOS and Android)
 * uses the same rules.
 */
export function addDuration(from: number, d: ProductDuration): number {
  const DAY = 86_400_000;
  if (d.unit === "day") return from + d.count * DAY;
  if (d.unit === "week") return from + d.count * 7 * DAY;
  const t = new Date(from);
  const months = d.unit === "month" ? d.count : d.count * 12;
  const total = t.getUTCMonth() + months;
  const year = t.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(t.getUTCDate(), last), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds());
}

function parseProductIds(v: unknown, where: string): string[] | Fail {
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list)) return { error: `${where}: productIds must be a list of product ids` };
  const out = new Set<string>();
  for (const p of list) {
    const id = typeof p === "string" ? p.trim() : p;
    if (!validProductId(id)) return { error: `${where}: ${JSON.stringify(p ?? null)} is not a product id (no spaces, at most 255 characters)` };
    out.add(id);
  }
  if (out.size > ENTITLEMENT_LIMITS.productsPerEntitlement) return { error: `${where}: at most ${ENTITLEMENT_LIMITS.productsPerEntitlement} products per entitlement` };
  return [...out].sort();
}

function parseEntitlementMap(v: unknown): Record<string, string[]> | Fail {
  if (v === undefined || v === null) return {};
  const items: { identifier: unknown; productIds: unknown }[] = Array.isArray(v)
    ? v.map((x) => (isObject(x) ? { identifier: x.identifier, productIds: x.productIds } : { identifier: null, productIds: null }))
    : isObject(v)
      ? Object.entries(v).map(([identifier, productIds]) => ({ identifier, productIds }))
      : [{ identifier: null, productIds: null }];
  const out: Record<string, string[]> = {};
  for (const it of items) {
    if (!validEntitlementId(it.identifier)) {
      return { error: `Entitlement ${JSON.stringify(it.identifier ?? null)} is not a valid identifier (letters, digits, _ . $ -, at most 64 characters)` };
    }
    if (it.identifier in out) return { error: `Entitlement "${it.identifier}" appears twice` };
    const ids = parseProductIds(it.productIds ?? [], `Entitlement "${it.identifier}"`);
    if ("error" in ids) return ids;
    out[it.identifier] = ids;
  }
  if (Object.keys(out).length > ENTITLEMENT_LIMITS.entitlements) return { error: `At most ${ENTITLEMENT_LIMITS.entitlements} entitlements per app` };
  return out;
}

function parseDurationMap(v: unknown): Record<string, ProductDuration> | Fail {
  if (v === undefined || v === null) return {};
  const items: { productId: unknown; duration: unknown }[] = Array.isArray(v)
    ? v.map((x) => (isObject(x) ? { productId: x.productId, duration: x.duration ?? { unit: x.unit, count: x.count } } : { productId: null, duration: null }))
    : isObject(v)
      ? Object.entries(v).map(([productId, duration]) => ({ productId, duration: isObject(duration) && duration.duration !== undefined ? duration.duration : duration }))
      : [{ productId: null, duration: null }];
  const out: Record<string, ProductDuration> = {};
  for (const it of items) {
    if (!validProductId(it.productId)) return { error: `Duration: ${JSON.stringify(it.productId ?? null)} is not a product id` };
    if (it.productId in out) return { error: `Duration of "${it.productId}" appears twice` };
    const d = parseDuration(it.duration, `Duration of "${it.productId}"`);
    if ("error" in d) return d;
    out[it.productId] = d;
  }
  if (Object.keys(out).length > ENTITLEMENT_LIMITS.durations) return { error: `At most ${ENTITLEMENT_LIMITS.durations} products with a duration per app` };
  return out;
}

/** PUT body: replaces the parts that are present (`entitlements`, `durations`), keeps the others. */
export function parseEntitlementsInput(body: unknown, prev: StoredEntitlements): StoredEntitlements | Fail {
  if (!isObject(body)) return { error: "Expected a JSON object { entitlements?, durations? }" };
  const entitlements = body.entitlements === undefined ? prev.entitlements : parseEntitlementMap(body.entitlements);
  if ("error" in entitlements) return entitlements as Fail;
  const durations = body.durations === undefined ? prev.durations : parseDurationMap(body.durations);
  if ("error" in durations) return durations as Fail;
  return normalize({ entitlements: entitlements as Record<string, string[]>, durations: durations as Record<string, ProductDuration> });
}

/** Sorted keys (stable JSON, stable version hash). */
export function normalize(e: StoredEntitlements): StoredEntitlements {
  const sortKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return {
    entitlements: sortKeys(Object.fromEntries(Object.entries(e.entitlements).map(([k, v]) => [k, [...new Set(v)].sort()]))),
    durations: sortKeys(Object.fromEntries(Object.entries(e.durations).map(([k, d]) => [k, { unit: d.unit, count: d.count }]))),
  };
}

/** Reads the stored column (null / malformed: none). */
export function readStoredEntitlements(json: string | null | undefined): StoredEntitlements {
  if (!json) return EMPTY_ENTITLEMENTS;
  try {
    const v = JSON.parse(json) as Partial<StoredEntitlements>;
    return normalize({ entitlements: isObject(v.entitlements) ? (v.entitlements as Record<string, string[]>) : {}, durations: isObject(v.durations) ? (v.durations as Record<string, ProductDuration>) : {} });
  } catch {
    return EMPTY_ENTITLEMENTS;
  }
}

/** The fields RevflareKit gets inside GET /sdk/v1/offerings; empty parts are left out (older payloads unchanged). */
export function entitlementsPayload(e: StoredEntitlements): Pick<SdkOfferings, "entitlements" | "products"> {
  const out: Pick<SdkOfferings, "entitlements" | "products"> = {};
  const ents = Object.entries(e.entitlements).filter(([, ids]) => ids.length);
  if (ents.length) out.entitlements = Object.fromEntries(ents);
  const durations = Object.entries(e.durations);
  if (durations.length) out.products = Object.fromEntries(durations.map(([id, d]) => [id, { duration: { unit: d.unit, count: d.count } }]));
  return out;
}

export const isEmptyEntitlements = (e: StoredEntitlements) => !Object.keys(e.entitlements).length && !Object.keys(e.durations).length;
