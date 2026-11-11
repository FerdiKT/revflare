// Offerings and placements (like RevenueCat offerings): which products each paywall shows, changed remotely.
//
// Storage: one `offering_configs` row per app with the whole config as JSON plus the prebuilt RevflareKit payload
// (`sdk_json`) and its `version` (short hash of the payload). Every change runs inside the database object
// (`changeOfferings`): read the row, apply the change, validate the whole config, write the row back. Inside the object
// nothing awaits real I/O between the read and the write (SQLite calls are synchronous, the hash is synchronous), so
// concurrent edits cannot interleave.
//
// Reads by the SDK (GET /sdk/v1/offerings, hit on every app launch): see worker/routes/sdk.ts (isolate memory + Cache
// API, at most one indexed read of two rows per isolate and minute).

import {
  OFFERING_IDENTIFIER_RE,
  OFFERING_LIMITS,
  type Offering,
  type OfferingPackage,
  type OfferingsChange,
  type OfferingsConfig,
  type Placement,
  type SdkOfferings,
} from "../../shared/types";
import { defineDbFunction, type Db } from "./db";
import { EMPTY_ENTITLEMENTS, entitlementsPayload, readStoredEntitlements, type StoredEntitlements } from "./entitlement-config";
import { now, parseJson } from "./util";

interface StoredOffering {
  identifier: string;
  displayName: string;
  metadata: Record<string, unknown>;
  packages: OfferingPackage[];
  createdAt: number;
  updatedAt: number;
}

export interface StoredConfig {
  currentOfferingId: string | null;
  offerings: StoredOffering[];
  placements: Placement[];
}

export const EMPTY_CONFIG: StoredConfig = { currentOfferingId: null, offerings: [], placements: [] };

type Fail = { error: string; status?: 400 | 404 | 409 };

const bytes = (s: string) => new TextEncoder().encode(s).length;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Offering, package and placement identifiers: letters, digits, _ . $ -, 1 to 64 characters (not only dots). */
export function validIdentifier(v: unknown): v is string {
  return typeof v === "string" && OFFERING_IDENTIFIER_RE.test(v) && !/^\.+$/.test(v);
}

const idError = (what: string, v: unknown) =>
  `${what} ${JSON.stringify(v ?? null)} is not a valid identifier (letters, digits, _ . $ -, at most 64 characters)`;

function parseMetadata(v: unknown, where: string): Record<string, unknown> | Fail {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) return { error: `${where}: metadata must be a JSON object` };
  if (bytes(JSON.stringify(v)) > OFFERING_LIMITS.metadataBytes) return { error: `${where}: metadata is larger than ${OFFERING_LIMITS.metadataBytes / 1024} KB` };
  return v;
}

function parsePackage(v: unknown, where: string): OfferingPackage | Fail {
  if (!isObject(v)) return { error: `${where}: each package must be an object { identifier, productId, metadata? }` };
  if (!validIdentifier(v.identifier)) return { error: `${where}: ${idError("package identifier", v.identifier)}` };
  const at = `${where}, package "${v.identifier}"`;
  const productId = typeof v.productId === "string" ? v.productId.trim() : "";
  if (!/^[\x21-\x7e]{1,255}$/.test(productId)) return { error: `${at}: productId must be an App Store product id (no spaces, at most 255 characters)` };
  const metadata = parseMetadata(v.metadata, at);
  if ("error" in metadata) return metadata as Fail;
  return { identifier: v.identifier, productId, metadata };
}

/** One offering of a request (POST, PATCH merged with the stored one, or an item of PUT). */
export function parseOffering(v: unknown): Omit<StoredOffering, "createdAt" | "updatedAt"> | Fail {
  if (!isObject(v)) return { error: "Each offering must be an object { identifier, displayName?, metadata?, packages? }" };
  if (!validIdentifier(v.identifier)) return { error: idError("Offering identifier", v.identifier) };
  const where = `Offering "${v.identifier}"`;
  let displayName = v.identifier;
  if (v.displayName !== undefined && v.displayName !== null) {
    if (typeof v.displayName !== "string") return { error: `${where}: displayName must be a string` };
    displayName = v.displayName.replace(/[\u0000-\u001f\u007f]/g, "").trim() || v.identifier;
    if (displayName.length > 100) return { error: `${where}: displayName is longer than 100 characters` };
  }
  const metadata = parseMetadata(v.metadata, where);
  if ("error" in metadata) return metadata as Fail;
  if (v.packages !== undefined && v.packages !== null && !Array.isArray(v.packages)) return { error: `${where}: packages must be a list` };
  const raw = (v.packages ?? []) as unknown[];
  if (raw.length > OFFERING_LIMITS.packages) return { error: `${where}: at most ${OFFERING_LIMITS.packages} packages` };
  const packages: OfferingPackage[] = [];
  for (const p of raw) {
    const pkg = parsePackage(p, where);
    if ("error" in pkg) return pkg;
    if (packages.some((x) => x.identifier === pkg.identifier)) return { error: `${where}: package "${pkg.identifier}" appears twice` };
    packages.push(pkg);
  }
  return { identifier: v.identifier, displayName, metadata, packages };
}

function parsePlacements(v: unknown): Placement[] | Fail {
  if (v === undefined || v === null) return [];
  const list: unknown[] = Array.isArray(v) ? v : isObject(v) ? Object.entries(v).map(([identifier, offeringId]) => ({ identifier, offeringId })) : [null];
  const out: Placement[] = [];
  for (const p of list) {
    if (!isObject(p)) return { error: "placements must be a list of { identifier, offeringId } or a map { placement: offeringId | null }" };
    if (!validIdentifier(p.identifier)) return { error: idError("Placement identifier", p.identifier) };
    if (p.offeringId !== undefined && p.offeringId !== null && typeof p.offeringId !== "string") return { error: `Placement "${p.identifier}": offeringId must be an offering identifier or null (the current offering)` };
    if (out.some((x) => x.identifier === p.identifier)) return { error: `Placement "${p.identifier}" appears twice` };
    out.push({ identifier: p.identifier, offeringId: (p.offeringId as string | null | undefined) || null });
  }
  return out;
}

/**
 * Validates a whole config (PUT body, or the stored config after a change). Timestamps: kept from `prev` for unchanged
 * offerings, `at` for new or changed ones.
 */
export function parseConfig(body: unknown, prev: StoredConfig = EMPTY_CONFIG, at = now()): StoredConfig | Fail {
  if (!isObject(body)) return { error: "Expected a JSON object { currentOfferingId?, offerings: [...], placements? }" };
  if (body.offerings !== undefined && !Array.isArray(body.offerings)) return { error: "offerings must be a list" };
  const raw = (body.offerings ?? []) as unknown[];
  if (raw.length > OFFERING_LIMITS.offerings) return { error: `At most ${OFFERING_LIMITS.offerings} offerings per app` };
  const before = new Map(prev.offerings.map((o) => [o.identifier, o]));
  const offerings: StoredOffering[] = [];
  for (const item of raw) {
    const o = parseOffering(item);
    if ("error" in o) return o;
    if (offerings.some((x) => x.identifier === o.identifier)) return { error: `Offering "${o.identifier}" appears twice` };
    const old = before.get(o.identifier);
    const same = old && JSON.stringify([old.displayName, old.metadata, old.packages]) === JSON.stringify([o.displayName, o.metadata, o.packages]);
    offerings.push({ ...o, createdAt: old?.createdAt ?? at, updatedAt: same ? old.updatedAt : at });
  }
  const ids = new Set(offerings.map((o) => o.identifier));
  // isCurrent on an item works too (the GET output can be sent back as is).
  const flagged = raw.find((o) => isObject(o) && o.isCurrent === true) as { identifier: string } | undefined;
  const current = body.currentOfferingId !== undefined ? body.currentOfferingId : (flagged?.identifier ?? null);
  if (current !== null && typeof current !== "string") return { error: "currentOfferingId must be an offering identifier or null" };
  if (current && !ids.has(current)) return { error: `currentOfferingId "${current}" is not one of the offerings` };
  const placements = parsePlacements(body.placements);
  if ("error" in placements) return placements;
  if (placements.length > OFFERING_LIMITS.placements) return { error: `At most ${OFFERING_LIMITS.placements} placements per app` };
  for (const p of placements) if (p.offeringId && !ids.has(p.offeringId)) return { error: `Placement "${p.identifier}" points at "${p.offeringId}", which is not one of the offerings` };
  const config = { currentOfferingId: current || null, offerings, placements };
  if (bytes(JSON.stringify(config)) > OFFERING_LIMITS.configBytes) return { error: `The whole config is larger than ${OFFERING_LIMITS.configBytes / 1024} KB` };
  return config;
}

/** Short hash (cyrb53, synchronous: no await inside the database object's read-modify-write). 12 hex characters. */
export function shortHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0")).slice(0, 12);
}

/**
 * The RevflareKit payload (GET /sdk/v1/offerings): the offerings plus, when set, the server-driven entitlements and the
 * non-renewing durations (worker/lib/entitlements.ts). Without them the payload (and its version) is the same as
 * before they existed.
 */
export function sdkPayload(config: StoredConfig, ents: StoredEntitlements = EMPTY_ENTITLEMENTS): SdkOfferings {
  const body = {
    currentOfferingId: config.currentOfferingId,
    offerings: config.offerings.map((o) => ({ identifier: o.identifier, displayName: o.displayName, metadata: o.metadata, packages: o.packages })),
    placements: Object.fromEntries(config.placements.map((p) => [p.identifier, p.offeringId])),
    ...entitlementsPayload(ents),
  };
  return { version: shortHash(JSON.stringify(body)), ...body };
}

export function configView(config: StoredConfig, updatedAt: number | null, ents: StoredEntitlements = EMPTY_ENTITLEMENTS): OfferingsConfig {
  const preview = sdkPayload(config, ents);
  return {
    currentOfferingId: config.currentOfferingId,
    offerings: config.offerings.map((o) => ({ ...o, isCurrent: o.identifier === config.currentOfferingId }) satisfies Offering),
    placements: config.placements,
    version: preview.version,
    updatedAt,
    preview,
  };
}

/** Packages whose product is not among the app's known products (synced from App Store Connect or seen in sales). */
export function productWarnings(config: StoredConfig, known: Set<string>): string[] {
  const used = config.offerings.flatMap((o) => o.packages.map((p) => ({ o: o.identifier, p })));
  if (!used.length) return [];
  if (!known.size) return ["The app has no known products yet (sync products from App Store Connect on the app page): product ids were not checked."];
  return used.filter(({ p }) => !known.has(p.productId)).map(({ o, p }) => `Offering "${o}", package "${p.identifier}": product "${p.productId}" is not one of the app's known App Store products.`);
}

// --- Changes ----------------------------------------------------------------------------------------------------------

export type OfferingsOp =
  | { kind: "replace"; body: unknown }
  | { kind: "create"; body: unknown }
  | { kind: "update"; identifier: string; body: unknown }
  | { kind: "delete"; identifier: string; force: boolean }
  | { kind: "current"; identifier: string }
  | { kind: "placement"; identifier: string; offeringId: unknown }
  | { kind: "deletePlacement"; identifier: string };

/** Applies a change to the stored config: the result goes through parseConfig (all limits and references checked). */
export function applyOp(config: StoredConfig, op: OfferingsOp, at = now()): { config: StoredConfig; status: 200 | 201 } | (Fail & { status: 400 | 404 | 409 }) {
  const fail = (error: string, status: 400 | 404 | 409 = 400) => ({ error, status });
  const done = (body: unknown, status: 200 | 201 = 200) => {
    const r = parseConfig(body, config, at);
    return "error" in r ? fail(r.error, r.status ?? 400) : { config: r, status };
  };
  const find = (id: string) => config.offerings.find((o) => o.identifier === id);
  switch (op.kind) {
    case "replace":
      return done(op.body);
    case "create": {
      const b = op.body;
      if (!isObject(b)) return fail("Expected a JSON object { identifier, displayName?, metadata?, packages?, isCurrent? }");
      if (validIdentifier(b.identifier) && find(b.identifier)) return fail(`Offering "${b.identifier}" already exists`, 409);
      if (config.offerings.length >= OFFERING_LIMITS.offerings) return fail(`At most ${OFFERING_LIMITS.offerings} offerings per app`);
      // The first offering becomes current unless isCurrent: false.
      const makeCurrent = b.isCurrent === true || (b.isCurrent !== false && !config.currentOfferingId);
      return done({ ...config, currentOfferingId: makeCurrent ? b.identifier : config.currentOfferingId, offerings: [...config.offerings, b] }, 201);
    }
    case "update": {
      const old = find(op.identifier);
      if (!old) return fail(`No offering "${op.identifier}"`, 404);
      const b = op.body;
      if (!isObject(b)) return fail("Expected a JSON object { identifier?, displayName?, metadata?, packages?, isCurrent? }");
      const next = { ...old, ...b, identifier: b.identifier ?? old.identifier };
      const renamed = next.identifier !== old.identifier;
      if (renamed && validIdentifier(next.identifier) && find(next.identifier as string)) return fail(`Offering "${next.identifier}" already exists`, 409);
      const rename = (id: string | null) => (renamed && id === old.identifier ? (next.identifier as string) : id);
      let current = rename(config.currentOfferingId);
      if (b.isCurrent === true) current = next.identifier as string;
      if (b.isCurrent === false && current === next.identifier) current = null;
      return done({
        currentOfferingId: current,
        offerings: config.offerings.map((o) => (o === old ? next : o)),
        placements: config.placements.map((p) => ({ ...p, offeringId: rename(p.offeringId) })),
      });
    }
    case "delete": {
      if (!find(op.identifier)) return fail(`No offering "${op.identifier}"`, 404);
      const users = config.placements.filter((p) => p.offeringId === op.identifier).map((p) => p.identifier);
      if (users.length && !op.force) return fail(`Offering "${op.identifier}" is used by placement${users.length > 1 ? "s" : ""} ${users.map((u) => `"${u}"`).join(", ")}: delete with ?force=true (they fall back to the current offering)`, 409);
      return done({
        currentOfferingId: config.currentOfferingId === op.identifier ? null : config.currentOfferingId,
        offerings: config.offerings.filter((o) => o.identifier !== op.identifier),
        placements: config.placements.map((p) => (p.offeringId === op.identifier ? { ...p, offeringId: null } : p)),
      });
    }
    case "current":
      if (!find(op.identifier)) return fail(`No offering "${op.identifier}"`, 404);
      return done({ ...config, currentOfferingId: op.identifier });
    case "placement": {
      if (!validIdentifier(op.identifier)) return fail(idError("Placement identifier", op.identifier));
      const target = op.offeringId ?? null;
      if (target !== null && typeof target !== "string") return fail("offeringId must be an offering identifier or null (the current offering)");
      if (target && !find(target)) return fail(`No offering "${target}"`, 404);
      const exists = config.placements.some((p) => p.identifier === op.identifier);
      const placements = exists
        ? config.placements.map((p) => (p.identifier === op.identifier ? { identifier: p.identifier, offeringId: target || null } : p))
        : [...config.placements, { identifier: op.identifier, offeringId: target || null }];
      return done({ ...config, placements }, exists ? 200 : 201);
    }
    case "deletePlacement":
      if (!config.placements.some((p) => p.identifier === op.identifier)) return fail(`No placement "${op.identifier}"`, 404);
      return done({ ...config, placements: config.placements.filter((p) => p.identifier !== op.identifier) });
  }
}

interface ConfigRow {
  id: string;
  sdk_key: string | null;
  config: string | null;
  entitlements: string | null;
  updated_at: number | null;
}

const ROW_SQL =
  "SELECT a.id, a.sdk_key, o.config, o.entitlements, o.updated_at FROM apps a LEFT JOIN offering_configs o ON o.app_id = a.id WHERE a.id = ? AND a.workspace_id = ?";

/** GET /apps/:id/offerings (null: no such app in the workspace). One indexed read. */
export async function readOfferings(db: Db, workspaceId: string, appId: string): Promise<OfferingsConfig | null> {
  const row = await db.prepare(ROW_SQL).bind(appId, workspaceId).first<ConfigRow>();
  if (!row) return null;
  return configView(parseJson(row.config, EMPTY_CONFIG), row.updated_at, readStoredEntitlements(row.entitlements));
}

export type ChangeResult = { status: 200 | 201; result: OfferingsChange; sdkKey: string | null } | { status: 400 | 404 | 409; error: string };

/** Applies one change inside the database object (atomic read-modify-write). Writes only when something changed. */
export const changeOfferings = defineDbFunction("offerings.change", async (db, args: { workspaceId: string; appId: string; op: OfferingsOp }): Promise<ChangeResult> => {
  const row = await db.prepare(ROW_SQL).bind(args.appId, args.workspaceId).first<ConfigRow>();
  if (!row) return { status: 404, error: "Not found" };
  const at = now();
  const r = applyOp(parseJson(row.config, EMPTY_CONFIG), args.op, at);
  if ("error" in r) return { status: r.status, error: r.error };
  const json = JSON.stringify(r.config);
  const ents = readStoredEntitlements(row.entitlements);
  let updatedAt = row.updated_at;
  if (json !== row.config) {
    const sdk = sdkPayload(r.config, ents);
    await db
      .prepare(
        `INSERT INTO offering_configs (app_id, config, sdk_json, version, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET config = excluded.config, sdk_json = excluded.sdk_json, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .bind(row.id, json, JSON.stringify(sdk), sdk.version, at)
      .run();
    updatedAt = at;
  }
  const { results } = await db.prepare("SELECT product_id FROM products WHERE app_id = ? AND product_id != ''").bind(row.id).all<{ product_id: string }>();
  const warnings = productWarnings(r.config, new Set(results.map((p) => p.product_id)));
  return { status: r.status, result: { ...configView(r.config, updatedAt, ents), warnings }, sdkKey: row.sdk_key };
});

/** RevflareKit payload by SDK key (null: unknown key). One indexed read of the app row and its config row. */
export async function readSdkOfferings(db: Db, sdkKey: string): Promise<{ body: string; version: string } | null> {
  const row = await db
    .prepare("SELECT o.sdk_json, o.version FROM apps a LEFT JOIN offering_configs o ON o.app_id = a.id WHERE a.sdk_key = ?")
    .bind(sdkKey)
    .first<{ sdk_json: string | null; version: string | null }>();
  if (!row) return null;
  if (row.sdk_json && row.version) return { body: row.sdk_json, version: row.version };
  const empty = sdkPayload(EMPTY_CONFIG);
  return { body: JSON.stringify(empty), version: empty.version };
}
