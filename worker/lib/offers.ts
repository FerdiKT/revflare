// Promotional offers (docs/offers.md): signatures for RevflareKit (POST /sdk/v1/offers/sign), the per-app allowlist and
// strict mode, the signature log, the lapsed subscribers segment and promotional / win-back redemption stats.
//
// Signing uses the workspace's In-App Purchase key (credential `appstore_iap`). Two forms are returned:
//   - legacy (SKPaymentDiscount, Product.PurchaseOption.promotionalOffer(offerID:keyID:nonce:signature:timestamp:)):
//     ECDSA P-256 SHA-256 over bundleId ⁣ keyId ⁣ productId ⁣ offerId ⁣ appAccountToken ⁣ nonce ⁣ timestamp
//     (U+2063 separators, lowercase UUIDs), DER encoded, base64;
//   - JWS (iOS 18.4+, Product.PurchaseOption.promotionalOffer(_:compactJWS:)): header { alg: ES256, kid, typ: JWT },
//     claims { iss, iat (s), aud: "promotional-offer", bid, nonce, productId, offerIdentifier, appAccountToken? }, no exp.
//
// The SDK key is public, so the endpoint is public: only allowlisted (product, offer) pairs are signed, installs and
// apps are rate limited in the isolate (10 / hour / install, 1000 / hour / app) and strict mode can require the install
// to be linked to a subscription. The hot path reads nothing from the database while its isolate cache is warm
// (app, allowlist and key for 60 s) except the strict-mode check. The log is background work (worker/lib/budget.ts):
// every signature is logged, refusals are sampled (the first 20 an hour per app and isolate, then 1 in 50 with the
// count it stands for), the log is trimmed every 50 rows, and nothing is logged once the day's background budget is used.

import {
  OFFER_LIMITS,
  OFFER_TYPE_LABELS,
  type LapsedSegment,
  type OfferEntry,
  type OfferKind,
  type OfferSettings,
  type OfferSettingsUpdate,
  type OfferSignature,
  type OfferSignatureLogItem,
  type OfferSignatureStatus,
  type OfferStats,
  type SdkEnvironment,
} from "../../shared/types";
import { getCredential } from "./credentials";
import { ecdsaSigningKey } from "./crypto";
import { backgroundAllowed, metered } from "./budget";
import { defineDbFunction, type Db } from "./db";
import { cachedFn } from "./metrics";
import { keptShareSql } from "./money";
import { parseSdkEnvironment } from "./test-data";
import { base64url, now, parseJson } from "./util";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const SEPARATOR = "⁣";
/** Signature log rows kept per app. */
export const OFFER_LOG_SIZE = 1000;
/** The log is trimmed when seq is a multiple of this (it holds up to OFFER_LOG_SIZE + OFFER_LOG_TRIM_EVERY - 1 rows). */
export const OFFER_LOG_TRIM_EVERY = 50;

// --- Signing ---------------------------------------------------------------------------------------------------------

export interface SignInput {
  bundleId: string;
  keyId: string;
  issuerId: string;
  productId: string;
  offerId: string;
  appAccountToken?: string | null;
  /** Lowercase UUID. */
  nonce: string;
  /** Milliseconds. */
  timestamp: number;
}

/** The string signed by the legacy promotional offer signature. */
export function legacyPayload(i: Omit<SignInput, "issuerId">): string {
  return [i.bundleId, i.keyId, i.productId, i.offerId, (i.appAccountToken ?? "").toLowerCase(), i.nonce.toLowerCase(), String(i.timestamp)].join(SEPARATOR);
}

/** WebCrypto's raw r‖s (IEEE P1363) ECDSA signature → ASN.1 DER SEQUENCE { INTEGER r, INTEGER s }. */
export function p1363ToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return v[0] & 0x80 ? Uint8Array.of(0, ...v) : Uint8Array.from(v);
  };
  const r = int(raw.subarray(0, half));
  const s = int(raw.subarray(half));
  const body = Uint8Array.of(0x02, r.length, ...r, 0x02, s.length, ...s);
  return Uint8Array.of(0x30, body.length, ...body);
}

export function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Both signatures of a promotional offer. */
export async function signPromotionalOffer(privateKeyPem: string, i: SignInput): Promise<{ signature: string; jws: string }> {
  const key = await ecdsaSigningKey(privateKeyPem);
  const algo = { name: "ECDSA", hash: "SHA-256" };
  const legacy = new Uint8Array(await crypto.subtle.sign(algo, key, new TextEncoder().encode(legacyPayload(i))));
  const head = base64url(JSON.stringify({ alg: "ES256", kid: i.keyId, typ: "JWT" }));
  const claims = {
    iss: i.issuerId,
    iat: Math.floor(i.timestamp / 1000),
    aud: "promotional-offer",
    bid: i.bundleId,
    nonce: i.nonce.toLowerCase(),
    productId: i.productId,
    offerIdentifier: i.offerId,
    ...(i.appAccountToken ? { appAccountToken: i.appAccountToken.toLowerCase() } : {}),
  };
  const body = base64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign(algo, key, new TextEncoder().encode(`${head}.${body}`));
  return { signature: base64(p1363ToDer(legacy)), jws: `${head}.${body}.${base64url(sig)}` };
}

// --- Settings --------------------------------------------------------------------------------------------------------

const PRODUCT_RE = /^[\x21-\x7e]{1,255}$/;
const OFFER_RE = /^[\x21-\x7e]{1,255}$/;
const KINDS: OfferKind[] = ["promotional", "win_back"];

interface SettingsRow {
  offers: string;
  strict: number;
  updated_at: number;
}

export const offerKey = (productId: string, offerId: string) => `${productId}\n${offerId}`;

/** Validates an allowlist (duplicates: the last one wins). */
export function parseOffers(v: unknown): OfferEntry[] | { error: string } {
  if (!Array.isArray(v)) return { error: "offers must be a list of { productId, offerId, label?, kind? }" };
  const out = new Map<string, OfferEntry>();
  for (const o of v) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "Each offer must be an object { productId, offerId, label?, kind? }" };
    const r = o as Record<string, unknown>;
    const productId = typeof r.productId === "string" ? r.productId.trim() : "";
    const offerId = typeof r.offerId === "string" ? r.offerId.trim() : "";
    if (!PRODUCT_RE.test(productId)) return { error: `productId ${JSON.stringify(r.productId ?? null)} must be an App Store product id (no spaces, at most 255 characters)` };
    if (!OFFER_RE.test(offerId)) return { error: `offerId ${JSON.stringify(r.offerId ?? null)} must be an App Store offer identifier (no spaces, at most 255 characters)` };
    const kind = (r.kind ?? "promotional") as OfferKind;
    if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(", ")}` };
    let label: string | null = null;
    if (r.label !== undefined && r.label !== null) {
      if (typeof r.label !== "string") return { error: "label must be a string" };
      label = r.label.trim().slice(0, OFFER_LIMITS.labelLength) || null;
    }
    const k = offerKey(productId, offerId);
    out.delete(k);
    out.set(k, { productId, offerId, label, kind });
  }
  if (out.size > OFFER_LIMITS.offers) return { error: `At most ${OFFER_LIMITS.offers} offers per app` };
  return [...out.values()];
}

export function parseOfferUpdate(body: Record<string, unknown>): OfferSettingsUpdate | { error: string } {
  const u: OfferSettingsUpdate = {};
  if (body.offers !== undefined) {
    const offers = parseOffers(body.offers);
    if ("error" in offers) return offers;
    u.offers = offers;
  }
  if (body.strict !== undefined) {
    if (typeof body.strict !== "boolean") return { error: "strict must be true or false" };
    u.strict = body.strict;
  }
  return u;
}

async function settingsRow(db: Db, appId: string) {
  return db.prepare("SELECT offers, strict, updated_at FROM offer_settings WHERE app_id = ?").bind(appId).first<SettingsRow>();
}

export async function offerSettingsView(db: Db, app: { id: string; workspace_id: string; bundle_id: string | null; sdk_key: string | null }): Promise<OfferSettings> {
  const row = await settingsRow(db, app.id);
  const cred = await db
    .prepare("SELECT key_id, issuer_id FROM credentials WHERE workspace_id = ? AND kind = 'appstore_iap' ORDER BY created_at DESC LIMIT 1")
    .bind(app.workspace_id)
    .first<{ key_id: string | null; issuer_id: string | null }>();
  return {
    appId: app.id,
    offers: parseJson<OfferEntry[]>(row?.offers, []),
    strict: !!row?.strict,
    keyConfigured: !!cred?.key_id && !!cred.issuer_id,
    bundleId: app.bundle_id,
    sdkKey: app.sdk_key,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function saveOfferSettings(db: Db, appId: string, u: OfferSettingsUpdate): Promise<void> {
  const row = await settingsRow(db, appId);
  const offers = u.offers ?? parseJson<OfferEntry[]>(row?.offers, []);
  const strict = u.strict ?? !!row?.strict;
  await db
    .prepare(
      `INSERT INTO offer_settings (app_id, offers, strict, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET offers = excluded.offers, strict = excluded.strict, updated_at = excluded.updated_at`,
    )
    .bind(appId, JSON.stringify(offers), strict ? 1 : 0, now())
    .run();
}

/** Adds offers that are not on the list yet (labels of existing ones are filled when empty). Returns how many were added. */
export function mergeOffers(current: OfferEntry[], found: OfferEntry[]): { offers: OfferEntry[]; added: number } {
  const byKey = new Map(current.map((o) => [offerKey(o.productId, o.offerId), { ...o }]));
  let added = 0;
  for (const f of found) {
    const k = offerKey(f.productId, f.offerId);
    const have = byKey.get(k);
    if (have) {
      if (!have.label && f.label) have.label = f.label;
      continue;
    }
    if (byKey.size >= OFFER_LIMITS.offers) break;
    byKey.set(k, f);
    added++;
  }
  return { offers: [...byKey.values()], added };
}

// --- SDK context (isolate cache) -------------------------------------------------------------------------------------

export interface OfferContext {
  appId: string;
  workspaceId: string;
  bundleId: string | null;
  strict: boolean;
  /** Allowlisted promotional offers (offerKey). */
  allowed: Set<string>;
  key: { keyId: string; issuerId: string; privateKey: string } | null;
}

const CONTEXT_TTL_MS = 60_000;
const UNKNOWN_TTL_MS = 60_000;
const MAX_CONTEXTS = 1_000;
const contexts = new Map<string, { value: OfferContext | null; expires: number }>();
export const offerContextStats = { memory: 0, database: 0 };

/** The signing context of an SDK key (null: unknown key), cached in the isolate for 60 s. */
export async function offerContext(env: Env, db: Db, sdkKey: string): Promise<OfferContext | null> {
  const hit = contexts.get(sdkKey);
  if (hit && hit.expires > Date.now()) {
    offerContextStats.memory++;
    return hit.value;
  }
  offerContextStats.database++;
  const row = await db
    .prepare("SELECT a.id, a.workspace_id, a.bundle_id, o.offers, o.strict FROM apps a LEFT JOIN offer_settings o ON o.app_id = a.id WHERE a.sdk_key = ?")
    .bind(sdkKey)
    .first<{ id: string; workspace_id: string; bundle_id: string | null; offers: string | null; strict: number | null }>();
  let value: OfferContext | null = null;
  if (row) {
    const offers = parseJson<OfferEntry[]>(row.offers, []);
    const allowed = new Set(offers.filter((o) => o.kind === "promotional").map((o) => offerKey(o.productId, o.offerId)));
    let key: OfferContext["key"] = null;
    if (allowed.size) {
      const cred = await getCredential(env, db, row.workspace_id, "appstore_iap").catch(() => null);
      if (cred?.keyId && cred.issuerId && cred.secret.privateKey) key = { keyId: cred.keyId, issuerId: cred.issuerId, privateKey: cred.secret.privateKey };
    }
    value = { appId: row.id, workspaceId: row.workspace_id, bundleId: row.bundle_id, strict: !!row.strict, allowed, key };
  }
  if (contexts.size >= MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
  contexts.set(sdkKey, { value, expires: Date.now() + (value ? CONTEXT_TTL_MS : UNKNOWN_TTL_MS) });
  return value;
}

/** After a settings change or a key rotation (this isolate; others pick it up within 60 s). */
export function forgetOfferContext(sdkKey: string | null | undefined) {
  if (sdkKey) contexts.delete(sdkKey);
}

/** After an In-App Purchase key of the workspace is added or deleted: every app of the workspace (this isolate). */
export function forgetWorkspaceOfferContexts(workspaceId: string) {
  for (const [k, v] of contexts) if (v.value?.workspaceId === workspaceId) contexts.delete(k);
}

// --- Rate limits (in-isolate token buckets) --------------------------------------------------------------------------

export const OFFER_RATE_LIMITS = {
  install: { capacity: 10, perSecond: 10 / 3600 },
  app: { capacity: 1000, perSecond: 1000 / 3600 },
};
const MAX_BUCKETS = 20_000;
const buckets = new Map<string, { tokens: number; at: number }>();

function bucket(key: string, limit: { capacity: number; perSecond: number }, at: number) {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value!);
    b = { tokens: limit.capacity, at };
    buckets.set(key, b);
  } else {
    b.tokens = Math.min(limit.capacity, b.tokens + ((at - b.at) / 1000) * limit.perSecond);
    b.at = at;
  }
  return b;
}

/** Takes one signature from the install's and the app's buckets; the seconds to wait when over the limit. */
export function takeSignature(appId: string, installId: string, at = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  const i = bucket(`i:${appId}:${installId}`, OFFER_RATE_LIMITS.install, at);
  const a = bucket(`a:${appId}`, OFFER_RATE_LIMITS.app, at);
  for (const [b, limit] of [
    [i, OFFER_RATE_LIMITS.install],
    [a, OFFER_RATE_LIMITS.app],
  ] as const) {
    if (b.tokens < 1) return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / limit.perSecond)) };
  }
  i.tokens -= 1;
  a.tokens -= 1;
  return { ok: true };
}

// --- Log sampling (in-isolate) ---------------------------------------------------------------------------------------

/** Refusals logged in full per app and hour (per isolate); after that 1 in REFUSAL_SAMPLE, carrying the count. */
export const REFUSAL_LOG_PER_HOUR = 20;
export const REFUSAL_SAMPLE = 50;
const MAX_REFUSAL_COUNTERS = 10_000;
const refusals = new Map<string, { hour: number; n: number; skipped: number }>();

/**
 * How many answers the log row of this one stands for, or 0 to not write it. Signatures are always logged (1).
 * Refusals not written are carried over to the next sampled row.
 */
export function logWeight(appId: string, status: OfferSignatureStatus, at = Date.now()): number {
  if (status === "signed") return 1;
  const hour = Math.floor(at / HOUR);
  let r = refusals.get(appId);
  if (!r) {
    if (refusals.size >= MAX_REFUSAL_COUNTERS) refusals.delete(refusals.keys().next().value!);
    r = { hour, n: 0, skipped: 0 };
    refusals.set(appId, r);
  }
  if (r.hour !== hour) {
    r.hour = hour;
    r.n = 0;
  }
  r.n++;
  if (r.n <= REFUSAL_LOG_PER_HOUR || r.skipped + 1 >= REFUSAL_SAMPLE) {
    const weight = r.skipped + 1;
    r.skipped = 0;
    return weight;
  }
  r.skipped++;
  return 0;
}

/** Tests: empty buckets and caches. */
export function resetOffersState() {
  buckets.clear();
  contexts.clear();
  refusals.clear();
  offerContextStats.memory = offerContextStats.database = 0;
}

// --- Signing request -------------------------------------------------------------------------------------------------

const INSTALL_RE = /^[\x21-\x7e]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SignRequest {
  installId: string;
  productId: string;
  offerId: string;
  appAccountToken: string | null;
  /** The build asking (logged; sandbox and Xcode builds are signed too: testing needs it). */
  environment: SdkEnvironment;
}

export function parseSignRequest(body: unknown): SignRequest | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object { installId, productId, offerId, appAccountToken? }" };
  const b = body as Record<string, unknown>;
  const installId = typeof b.installId === "string" ? b.installId.trim().toLowerCase() : "";
  const productId = typeof b.productId === "string" ? b.productId.trim() : "";
  const offerId = typeof b.offerId === "string" ? b.offerId.trim() : "";
  if (!INSTALL_RE.test(installId)) return { error: "installId is required" };
  if (!PRODUCT_RE.test(productId)) return { error: "productId is required" };
  if (!OFFER_RE.test(offerId)) return { error: "offerId is required" };
  let appAccountToken: string | null = null;
  if (b.appAccountToken !== undefined && b.appAccountToken !== null && b.appAccountToken !== "") {
    if (typeof b.appAccountToken !== "string" || !UUID_RE.test(b.appAccountToken)) return { error: "appAccountToken must be a UUID" };
    appAccountToken = b.appAccountToken.toLowerCase();
  }
  return { installId, productId, offerId, appAccountToken, environment: parseSdkEnvironment(b.environment) };
}

/**
 * Strict mode: the install is linked (install_links) to a subscription of the product's subscription group, or to any
 * subscription of the app when the group is unknown. Lapsed subscriptions count (promotional offers win them back).
 */
export async function installHasSubscription(db: Db, appId: string, installId: string, productId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `WITH t(target) AS (SELECT (SELECT subscription_group FROM products WHERE app_id = ? AND product_id = ?))
       SELECT EXISTS (
         SELECT 1 FROM t, install_links l
         JOIN subscriptions s ON s.app_id = l.app_id AND s.original_transaction_id = l.original_transaction_id
         LEFT JOIN products p ON p.app_id = s.app_id AND p.product_id = s.product_id
         WHERE l.app_id = ? AND l.install_id = ? AND (t.target IS NULL OR p.subscription_group = t.target OR s.product_id = ?)
       ) AS ok`,
    )
    .bind(appId, productId, appId, installId, productId)
    .first<{ ok: number }>();
  return !!row?.ok;
}

export interface SignatureLogRow {
  installId: string;
  productId: string;
  offerId: string;
  status: OfferSignatureStatus;
  at: number;
  /** Answers the row stands for (sampled refusals); default 1. */
  count?: number;
  environment?: SdkEnvironment | null;
}

/** Writes a log row; every OFFER_LOG_TRIM_EVERY rows, trims the app's log to the last OFFER_LOG_SIZE rows (by index). */
export async function logSignature(db: Db, appId: string, r: SignatureLogRow) {
  const row = await db
    .prepare(
      `INSERT INTO offer_signatures (app_id, seq, install_id, product_id, offer_id, status, at, count, environment)
       VALUES (?, COALESCE((SELECT MAX(seq) FROM offer_signatures WHERE app_id = ?), 0) + 1, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
    )
    .bind(appId, appId, r.installId.slice(0, 128), r.productId.slice(0, 255), r.offerId.slice(0, 255), r.status, r.at, Math.max(1, Math.floor(r.count ?? 1)), r.environment ?? null)
    .first<{ seq: number }>();
  if (row && row.seq % OFFER_LOG_TRIM_EVERY === 0) {
    await db.prepare("DELETE FROM offer_signatures WHERE app_id = ? AND seq <= ?").bind(appId, row.seq - OFFER_LOG_SIZE).run();
  }
}

/**
 * The log write as background work, inside the database object: skipped once the day's background budget is used up
 * (signing goes on), and counted in it otherwise. Returns false when skipped.
 */
export const recordSignature = defineDbFunction("offers.recordSignature", async (db, args: { appId: string; row: SignatureLogRow }, env): Promise<boolean> => {
  if (!(await backgroundAllowed(db, env))) return false;
  await metered(db, () => logSignature(db, args.appId, args.row));
  return true;
});

export type SignResult =
  | { status: 200; body: OfferSignature }
  | { status: 400 | 403 | 404 | 409; body: { error: string; code?: string } }
  | { status: 429; body: { error: string; code: string }; retryAfter: number };

/**
 * POST /sdk/v1/offers/sign. `log` receives the rows to write (sampled, see logWeight; the route writes them after the
 * response).
 */
export async function signOfferRequest(
  env: Env,
  db: Db,
  sdkKey: string,
  body: unknown,
  log: (appId: string, r: SignatureLogRow) => void,
  at = Date.now(),
): Promise<SignResult> {
  const req = parseSignRequest(body);
  if ("error" in req) return { status: 400, body: { error: req.error } };
  const ctx = await offerContext(env, db, sdkKey);
  if (!ctx) return { status: 404, body: { error: "Unknown SDK key" } };
  const rate = takeSignature(ctx.appId, req.installId, at);
  if (!rate.ok) return { status: 429, body: { error: "Too many offer signatures: slow down", code: "rate_limited" }, retryAfter: rate.retryAfter };
  const note = (status: OfferSignatureStatus) => {
    const count = logWeight(ctx.appId, status, at);
    if (count) log(ctx.appId, { installId: req.installId, productId: req.productId, offerId: req.offerId, at, status, count, environment: req.environment });
  };
  if (!ctx.allowed.has(offerKey(req.productId, req.offerId))) {
    note("not_allowed");
    return { status: 403, body: { error: "This offer is not on the app's allowlist (Revflare → app → Offers)", code: "offer_not_allowed" } };
  }
  if (!ctx.key || !ctx.bundleId) {
    note("not_configured");
    return { status: 409, body: { error: ctx.bundleId ? "No In-App Purchase key in this workspace" : "The app has no bundle id", code: "not_configured" } };
  }
  if (ctx.strict && !(await installHasSubscription(db, ctx.appId, req.installId, req.productId))) {
    note("not_subscribed");
    return { status: 403, body: { error: "Strict mode: this install has no subscription in the product's group", code: "offer_not_allowed" } };
  }
  const nonce = crypto.randomUUID().toLowerCase();
  const signed = await signPromotionalOffer(ctx.key.privateKey, {
    bundleId: ctx.bundleId,
    keyId: ctx.key.keyId,
    issuerId: ctx.key.issuerId,
    productId: req.productId,
    offerId: req.offerId,
    appAccountToken: req.appAccountToken,
    nonce,
    timestamp: at,
  });
  note("signed");
  return { status: 200, body: { productId: req.productId, offerId: req.offerId, keyId: ctx.key.keyId, nonce, timestamp: at, ...signed } };
}

export async function offerSignatureLog(db: Db, appId: string, limit = 100): Promise<OfferSignatureLogItem[]> {
  const { results } = await db
    .prepare("SELECT at, install_id, product_id, offer_id, status, count, environment FROM offer_signatures WHERE app_id = ? ORDER BY seq DESC LIMIT ?")
    .bind(appId, Math.min(Math.max(Math.floor(limit) || 100, 1), OFFER_LOG_SIZE))
    .all<{ at: number; install_id: string; product_id: string; offer_id: string; status: OfferSignatureStatus; count: number; environment: SdkEnvironment | null }>();
  return results.map((r) => ({ at: r.at, installId: r.install_id, productId: r.product_id, offerId: r.offer_id, status: r.status, count: r.count, environment: r.environment }));
}

// --- Lapsed subscribers ----------------------------------------------------------------------------------------------

export const LAPSED_LIMIT = 200;

/**
 * Subscriptions of the app that expired in the last `days` days without auto-renew (status expired: grace and billing
 * retry are current subscribers, revoked / refunded ones are not lapsed), leaving out customers who have a current
 * subscription in the app (another plan or a new purchase). Amounts in USD (the route converts; it sets `to`).
 */
export const lapsedSubscribers = cachedFn(
  "lapsedSubscribers",
  async (db, args: { workspaceId: string; appId: string; days: number; day: string }): Promise<Omit<LapsedSegment, "currency" | "to">> => {
    const from = Date.parse(`${args.day}T00:00:00Z`) - args.days * DAY;
    // The current subscribers' set is built once (idx_subs_app_status), not per lapsed row.
    const where = `s.app_id = ? AND s.status = 'expired' AND s.expires_at >= ? AND s.auto_renew = 0 AND s.environment = 'Production'
      AND (s.customer_id IS NULL OR s.customer_id NOT IN (
        SELECT customer_id FROM subscriptions WHERE app_id = ? AND status IN ('active', 'trial', 'grace', 'billing_retry') AND customer_id IS NOT NULL))`;
    const { results: groups } = await db
      .prepare(
        `SELECT s.product_id, p.name, COUNT(*) AS n FROM subscriptions s
         LEFT JOIN products p ON p.app_id = s.app_id AND p.product_id = s.product_id
         WHERE ${where} GROUP BY s.product_id ORDER BY n DESC`,
      )
      .bind(args.appId, from, args.appId)
      .all<{ product_id: string; name: string | null; n: number }>();
    const { results: rows } = await db
      .prepare(
        `SELECT s.customer_id, s.original_transaction_id, s.product_id, p.name, s.expires_at, s.country, c.total_usd FROM subscriptions s
         LEFT JOIN products p ON p.app_id = s.app_id AND p.product_id = s.product_id
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE ${where} ORDER BY s.expires_at DESC LIMIT ?`,
      )
      .bind(args.appId, from, args.appId, LAPSED_LIMIT)
      .all<{ customer_id: string | null; original_transaction_id: string; product_id: string; name: string | null; expires_at: number; country: string | null; total_usd: number | null }>();
    return {
      appId: args.appId,
      days: args.days,
      from,
      total: groups.reduce((s, g) => s + g.n, 0),
      byProduct: groups.map((g) => ({ productId: g.product_id, productName: g.name, count: g.n })),
      items: rows.map((r) => ({
        customerId: r.customer_id,
        originalTransactionId: r.original_transaction_id,
        productId: r.product_id,
        productName: r.name,
        expiredAt: r.expires_at,
        country: r.country,
        totalPaid: r.total_usd ?? 0,
      })),
    };
  },
);

// --- Redemption stats ------------------------------------------------------------------------------------------------

/** Promotional (2) and win-back (4) redemptions per offer in [from, to] (UTC days). Amounts in USD (the route converts). */
export const offerStats = cachedFn("offerStats", async (db, args: { workspaceId: string; appId: string; from: string; to: string }): Promise<Omit<OfferStats, "currency">> => {
  const start = Date.parse(`${args.from}T00:00:00Z`);
  const end = Date.parse(`${args.to}T00:00:00Z`) + DAY;
  const kept = keptShareSql("t");
  const { results } = await db
    .prepare(
      `SELECT t.offer_type, t.offer_id, t.product_id, COUNT(*) AS n, COUNT(DISTINCT t.customer_id) AS customers,
         SUM(t.gross_usd * ${kept}) AS revenue, SUM(t.proceeds_usd * ${kept}) AS proceeds
       FROM transactions t
       WHERE t.app_id = ? AND t.purchased_at >= ? AND t.purchased_at < ? AND t.offer_type IN (2, 4) AND t.environment = 'Production'
       GROUP BY t.offer_type, t.offer_id, t.product_id ORDER BY n DESC`,
    )
    .bind(args.appId, start, end)
    .all<{ offer_type: 2 | 4; offer_id: string | null; product_id: string; n: number; customers: number; revenue: number | null; proceeds: number | null }>();
  const settings = await settingsRow(db, args.appId);
  const labels = new Map(parseJson<OfferEntry[]>(settings?.offers, []).map((o) => [offerKey(o.productId, o.offerId), o.label]));
  const items = results.map((r) => ({
    offerType: r.offer_type,
    offerTypeLabel: OFFER_TYPE_LABELS[r.offer_type],
    offerId: r.offer_id,
    productId: r.product_id,
    label: r.offer_id ? (labels.get(offerKey(r.product_id, r.offer_id)) ?? null) : null,
    redemptions: r.n,
    customers: r.customers,
    revenue: r.revenue ?? 0,
    proceeds: r.proceeds ?? 0,
  }));
  return {
    appId: args.appId,
    from: args.from,
    to: args.to,
    totals: items.reduce((t, i) => ({ redemptions: t.redemptions + i.redemptions, revenue: t.revenue + i.revenue, proceeds: t.proceeds + i.proceeds }), { redemptions: 0, revenue: 0, proceeds: 0 }),
    items,
  };
});
