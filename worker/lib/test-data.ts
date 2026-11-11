// Debug vs production data. RevflareKit tells which build it runs in (production = App Store / Google Play, sandbox =
// TestFlight / development build / Play test track, xcode = StoreKit configuration file, debug = debuggable Android build); each app can also list test devices (install ids). Events,
// funnels, experiments, insights, LTV, attributed revenue and Meta sending count production data from other devices
// only, unless a read asks for test data (`includeTest`).

import { INSTALL_SOURCES, SDK_ENVIRONMENTS, TEST_INSTALLS_LIMIT, type InstallSource, type SdkEnvironment } from "../../shared/types";
import type { Db } from "./db";
import { parseJson } from "./util";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The SDK's `environment`: missing or invalid (older SDKs) = production. */
export function parseSdkEnvironment(v: unknown): SdkEnvironment {
  return typeof v === "string" && (SDK_ENVIRONMENTS as readonly string[]).includes(v) ? (v as SdkEnvironment) : "production";
}

export const isInstallSource = (v: unknown): v is InstallSource => typeof v === "string" && (INSTALL_SOURCES as readonly string[]).includes(v);

/**
 * The acquisition source of an install from its attributions row: apple_ads when Apple attributed it; unknown while
 * its token waits for Apple (pending); organic otherwise (resolved without attribution, failed, expired, no token).
 * LTV uses the same rule on settled rows (it has no pending ones: they count as organic until resolved).
 */
export function installSource(a: { status?: string | null; attributed?: number | null; referrer_source?: string | null } | null | undefined): InstallSource {
  if (!a) return "unknown";
  if (a.attributed === 1) return "apple_ads";
  // Android installs: from the Play Install Referrer (worker/lib/attribution.ts).
  if (a.referrer_source === "google_ads" || a.referrer_source === "referral") return a.referrer_source;
  return a.status === "pending" ? "unknown" : "organic";
}

/** Install referrer parameters → acquisition source: google_ads (gclid), referral (utm_source other than Play's organic value), organic. */
export function referrerSource(p: { utmSource?: string | null; utmMedium?: string | null; gclid?: string | null }): "google_ads" | "referral" | "organic" {
  if (p.gclid) return "google_ads";
  const src = (p.utmSource ?? "").trim().toLowerCase();
  const organic = !src || src === "google-play" || src === "(not set)" || src === "(direct)" || (p.utmMedium ?? "").toLowerCase() === "organic";
  return organic ? "organic" : "referral";
}

/** SQL: the attributions row (alias `a`) is a production install (NULL = reported before the SDK sent its environment). */
export const PRODUCTION_INSTALL = (alias = "a") => `(${alias}.environment IS NULL OR ${alias}.environment = 'production')`;

// Installs moving in or out of production (worker/lib/attribution.ts) per workspace, in this isolate: part of LTV's day
// cache key (worker/lib/ltv.ts), so a TestFlight install that later reports from the App Store build counts at once.
const installEpochs = new Map<string, number>();
export const installsChanged = (workspaceId: string) => void installEpochs.set(workspaceId, (installEpochs.get(workspaceId) ?? 0) + 1);
export const installsEpoch = (workspaceId: string) => installEpochs.get(workspaceId) ?? 0;

/** Install ids of an app's test devices (stored JSON; invalid entries dropped). */
export function parseTestInstalls(json: string | null | undefined): string[] {
  const list = parseJson<unknown>(json, []);
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()).filter((x) => UUID_RE.test(x)))].slice(0, TEST_INSTALLS_LIMIT);
}

/** Validates a new list (PUT body, CLI add / rm). */
export function validateTestInstalls(v: unknown): string[] | { error: string } {
  if (!Array.isArray(v)) return { error: "installIds must be a list of install ids (UUIDs)" };
  const out: string[] = [];
  for (const raw of v) {
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!UUID_RE.test(id)) return { error: `${JSON.stringify(raw)} is not an install id (UUID)` };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > TEST_INSTALLS_LIMIT) return { error: `At most ${TEST_INSTALLS_LIMIT} test devices per app` };
  return out;
}

/**
 * `AND <column> NOT IN ('…', …)` for these install ids ('' when none). Install ids are UUIDs checked here, so they are
 * written as literals: lists of several apps would not fit the 100 bound parameters of a statement.
 */
export function excludeInstallsSql(column: string, ids: readonly string[]): string {
  const safe = ids.filter((x) => UUID_RE.test(x));
  return safe.length ? ` AND ${column} NOT IN (${safe.map((x) => `'${x}'`).join(", ")})` : "";
}

/** `<column> IN ('…', …)` for these install ids (literals, like excludeInstallsSql); null when there is none. */
export function installsInSql(column: string, ids: readonly string[]): string | null {
  const safe = ids.filter((x) => UUID_RE.test(x));
  return safe.length ? `${column} IN (${safe.map((x) => `'${x}'`).join(", ")})` : null;
}

/** SQL: the attributions row (alias `a`) carries Apple's AdServices test attribution (development / TestFlight). */
export const NOT_TEST_ATTRIBUTION = (alias = "a") => `${alias}.test_attribution = 0`;

/** Test devices of all the workspace's apps, flattened (install ids are unique across apps). */
export async function workspaceTestInstalls(db: Db, workspaceId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT test_installs FROM apps WHERE workspace_id = ? AND test_installs IS NOT NULL").bind(workspaceId).all<{ test_installs: string | null }>();
  return [...new Set(results.flatMap((r) => parseTestInstalls(r.test_installs)))];
}

/** Test devices of one app. */
export async function appTestInstalls(db: Db, appId: string): Promise<string[]> {
  const row = await db.prepare("SELECT test_installs FROM apps WHERE id = ?").bind(appId).first<{ test_installs: string | null }>();
  return parseTestInstalls(row?.test_installs);
}
