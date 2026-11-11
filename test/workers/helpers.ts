import { SELF, env } from "cloudflare:test";
import chain from "../fixtures/apple-test-chain.json";

export const ORIGIN = "https://rf.test";

export interface Client {
  cookie?: string;
  token?: string;
  ws?: string;
}

export async function call(client: Client | null, path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.token) headers.authorization = `Bearer ${client.token}`;
  if (client?.ws) headers["x-workspace-id"] = client.ws;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await SELF.fetch(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

export function sessionCookie(headers: Headers): string | undefined {
  return (headers.get("set-cookie") ?? "").match(/rf_session=[^;]+/)?.[0];
}

let owner: Client | null = null;

/** The instance's first user (created once per test run; test files may race for it), pinned to their first workspace. */
export async function ownerClient(): Promise<Client & { email: string; password: string; workspaceId: string }> {
  const email = "owner@rf.test";
  const password = "password123";
  if (!owner) {
    const r = await call(null, "/api/v1/auth/setup", { body: { name: "Owner", email, password, workspaceName: "Apps" } });
    if (r.status === 200) owner = { cookie: sessionCookie(r.headers) };
    else {
      const l = await call(null, "/api/v1/auth/login", { body: { email, password } });
      if (l.status !== 200) throw new Error(`login failed ${l.status} ${l.text}`);
      owner = { cookie: sessionCookie(l.headers) };
    }
  }
  const list = await call(owner, "/api/v1/workspaces");
  const ws = (list.json.items as { id: string; name: string }[]).find((w) => w.name === "Apps")!;
  return { ...owner, ws: ws.id, email, password, workspaceId: ws.id };
}

// --- Signed App Store payloads (test chain: test/fixtures/apple-test-chain.json) ---------------------------------

const b64url = (bytes: Uint8Array | string) => {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let keyPromise: Promise<CryptoKey> | null = null;
function leafKey() {
  keyPromise ??= crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(chain.leafKey), (ch) => ch.charCodeAt(0)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return keyPromise;
}

export async function signJws(payload: unknown, x5c: string[] = [chain.leaf, chain.intermediate, chain.root]): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "ES256", x5c }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await leafKey(), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

export const DAY = 86_400_000;

export interface TxOptions {
  bundleId: string;
  transactionId: string;
  originalTransactionId?: string;
  productId?: string;
  type?: string;
  purchaseDate: number;
  /** The subscription's first purchase (default: purchaseDate). */
  originalPurchaseDate?: number;
  expiresDate?: number;
  price?: number;
  currency?: string;
  storefront?: string;
  offerType?: number;
  offerIdentifier?: string;
  offerDiscountType?: string;
  subscriptionGroupIdentifier?: string;
  transactionReason?: "PURCHASE" | "RENEWAL";
  revocationDate?: number;
  revocationReason?: number;
  revocationPercentage?: number;
  revocationType?: string;
  environment?: string;
  appAccountToken?: string;
}

export function txPayload(o: TxOptions) {
  return {
    transactionId: o.transactionId,
    originalTransactionId: o.originalTransactionId ?? o.transactionId,
    bundleId: o.bundleId,
    productId: o.productId ?? "monthly",
    purchaseDate: o.purchaseDate,
    originalPurchaseDate: o.originalPurchaseDate ?? o.purchaseDate,
    expiresDate: o.expiresDate,
    quantity: 1,
    type: o.type ?? "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    signedDate: Date.now(),
    environment: o.environment ?? "Production",
    storefront: o.storefront ?? "USA",
    transactionReason: o.transactionReason ?? "PURCHASE",
    price: o.price ?? 9990,
    currency: o.currency ?? "USD",
    offerType: o.offerType,
    offerIdentifier: o.offerIdentifier,
    offerDiscountType: o.offerDiscountType,
    subscriptionGroupIdentifier: o.subscriptionGroupIdentifier,
    revocationDate: o.revocationDate,
    revocationReason: o.revocationReason,
    revocationPercentage: o.revocationPercentage,
    revocationType: o.revocationType,
    appAccountToken: o.appAccountToken,
  };
}

let seq = 0;

export async function notification(type: string, tx: TxOptions | null, opts: { subtype?: string; renewal?: Record<string, unknown>; signedDate?: number; uuid?: string; bundleId?: string; data?: Record<string, unknown> } = {}) {
  const payload = {
    notificationType: type,
    subtype: opts.subtype,
    notificationUUID: opts.uuid ?? `uuid-${Date.now()}-${++seq}`,
    version: "2.0",
    signedDate: opts.signedDate ?? Date.now(),
    data: {
      bundleId: tx?.bundleId ?? opts.bundleId,
      environment: tx?.environment ?? "Production",
      ...(tx ? { signedTransactionInfo: await signJws(txPayload(tx)) } : {}),
      ...(opts.data ?? {}),
      ...(opts.renewal ? { signedRenewalInfo: await signJws({ signedDate: Date.now(), originalTransactionId: tx?.originalTransactionId ?? tx?.transactionId, ...opts.renewal }) } : {}),
    },
  };
  return { signedPayload: await signJws(payload), uuid: payload.notificationUUID };
}

export { env };
