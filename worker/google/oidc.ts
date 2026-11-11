// Verification of the OIDC token Pub/Sub push subscriptions send (Authorization: Bearer <JWT>): RS256 signed by Google
// (keys at https://www.googleapis.com/oauth2/v3/certs, cached as long as Google's Cache-Control allows), issuer
// accounts.google.com, audience = the push endpoint URL, email = the push subscription's service account (verified),
// not expired. https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions

import { fromBase64url } from "../lib/util";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
/** Clock skew allowed on exp / iat / nbf. */
const SKEW_S = 300;

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

let jwks: { keys: Map<string, Promise<CryptoKey>>; expiresAt: number } | null = null;
/** Last refetch forced by an unknown key id: at most one a minute (a token with a made-up kid can't make us hammer Google). */
let lastForcedAt = 0;
const FORCED_REFRESH_MS = 60_000;

/** Forgets the cached Google keys (tests). */
export function forgetGoogleJwks() {
  jwks = null;
  lastForcedAt = 0;
}

function maxAge(res: Response): number {
  const m = /max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "");
  const s = m ? Number(m[1]) : 3600;
  return Math.min(Math.max(s, 60), 24 * 3600) * 1000;
}

async function googleKeys(force = false): Promise<Map<string, Promise<CryptoKey>>> {
  if (!force && jwks && jwks.expiresAt > Date.now()) return jwks.keys;
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`Google certificates unavailable (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, Promise<CryptoKey>>();
  for (const k of body.keys ?? []) {
    if (k.kty !== "RSA" || !k.kid) continue;
    const p = crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    p.catch(() => {});
    keys.set(k.kid, p);
  }
  jwks = { keys, expiresAt: Date.now() + maxAge(res) };
  return keys;
}

export interface OidcClaims {
  iss?: string;
  aud?: string | string[];
  email?: string;
  email_verified?: boolean | string;
  exp?: number;
  iat?: number;
  nbf?: number;
  sub?: string;
}

export class OidcError extends Error {}

/**
 * Verifies a Pub/Sub push token. `audiences`: the accepted audiences (the push endpoint URL as Revflare knows it and as
 * the request came in); `email`: the service account configured for the app.
 */
export async function verifyPushToken(authorization: string | null | undefined, opts: { audiences: string[]; email: string; at?: number }): Promise<OidcClaims> {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization?.trim() ?? "");
  if (!m) throw new OidcError("Missing bearer token (turn on authentication on the Pub/Sub push subscription)");
  const [, h, p, s] = m;
  let header: { alg?: string; kid?: string };
  let claims: OidcClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64url(h)));
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(p)));
  } catch {
    throw new OidcError("Malformed token");
  }
  if (header.alg !== "RS256" || !header.kid) throw new OidcError("Unexpected token algorithm");
  let keys = await googleKeys();
  // Google rotates its keys: an unknown kid refreshes the set, at most once a minute.
  if (!keys.has(header.kid) && Date.now() - lastForcedAt >= FORCED_REFRESH_MS) {
    lastForcedAt = Date.now();
    keys = await googleKeys(true);
  }
  const key = keys.get(header.kid);
  if (!key) throw new OidcError("Token signed by an unknown key");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await key, fromBase64url(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new OidcError("Bad token signature");
  const at = Math.floor((opts.at ?? Date.now()) / 1000);
  if (!claims.iss || !ISSUERS.includes(claims.iss)) throw new OidcError("Token not issued by Google");
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < at) throw new OidcError("Token expired");
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > at) throw new OidcError("Token not valid yet");
  if (typeof claims.iat === "number" && claims.iat - SKEW_S > at) throw new OidcError("Token issued in the future");
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.some((a) => typeof a === "string" && opts.audiences.includes(a))) throw new OidcError("Token audience is not this push endpoint");
  if ((claims.email ?? "").toLowerCase() !== opts.email.toLowerCase()) throw new OidcError("Token is for another service account");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new OidcError("Service account email not verified");
  return claims;
}
