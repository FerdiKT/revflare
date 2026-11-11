// Google service-account auth (OAuth 2.0 JWT bearer grant, RFC 7523): a JWT signed with the service account's RSA key
// (RS256, WebCrypto) is traded at https://oauth2.googleapis.com/token for an access token with the androidpublisher
// scope. Tokens are cached in memory (the database object, where every Google call runs) for ~55 minutes.

import { pemToBytes } from "../lib/crypto";
import { base64url } from "../lib/util";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | null;
  projectId: string | null;
}

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** Validates a pasted service-account JSON key file; the private key must import as an RSA PKCS#8 key. */
export async function parseServiceAccount(input: unknown): Promise<ServiceAccount | { error: string }> {
  let json: Record<string, unknown> | null = null;
  if (typeof input === "string") {
    try {
      json = JSON.parse(input) as Record<string, unknown>;
    } catch {
      return { error: "The service account key must be the JSON file Google Cloud downloads (Keys → Add key → JSON)" };
    }
  } else if (input && typeof input === "object" && !Array.isArray(input)) json = input as Record<string, unknown>;
  if (!json) return { error: "serviceAccount (the JSON key file) is required" };
  if (json.type !== undefined && json.type !== "service_account") return { error: `This JSON is a "${String(json.type)}" key, not a service account key` };
  const clientEmail = typeof json.client_email === "string" ? json.client_email.trim() : "";
  const privateKey = typeof json.private_key === "string" ? json.private_key.trim() : "";
  if (!EMAIL_RE.test(clientEmail)) return { error: "client_email is missing from the service account key" };
  if (!privateKey.includes("PRIVATE KEY")) return { error: "private_key is missing from the service account key" };
  try {
    await importRsaKey(privateKey);
  } catch {
    return { error: "private_key is not a valid RSA private key (PKCS#8 PEM)" };
  }
  return {
    clientEmail,
    privateKey,
    privateKeyId: typeof json.private_key_id === "string" ? json.private_key_id : null,
    projectId: typeof json.project_id === "string" ? json.project_id : null,
  };
}

const keys = new Map<string, Promise<CryptoKey>>();

function importRsaKey(pem: string): Promise<CryptoKey> {
  let key = keys.get(pem);
  if (!key) {
    key = crypto.subtle.importKey("pkcs8", pemToBytes(pem) as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    key.catch(() => keys.delete(pem));
    keys.set(pem, key);
  }
  return key;
}

/** The signed assertion of the JWT bearer grant (exported for tests). */
export async function serviceAccountAssertion(sa: ServiceAccount, scope: string, at = Date.now()): Promise<string> {
  const iat = Math.floor(at / 1000);
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(sa.privateKeyId ? { kid: sa.privateKeyId } : {}) }));
  const body = base64url(JSON.stringify({ iss: sa.clientEmail, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importRsaKey(sa.privateKey), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(sig)}`;
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

/** Forgets cached tokens (tests; a replaced key). */
export function forgetGoogleTokens() {
  tokens.clear();
}

/** An access token for the service account (cached until 5 minutes before Google's expiry, at most 55 minutes). */
export async function accessToken(sa: ServiceAccount, scope = ANDROID_PUBLISHER_SCOPE): Promise<string> {
  const cacheKey = `${sa.clientEmail}|${sa.privateKeyId ?? ""}|${scope}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const assertion = await serviceAccountAssertion(sa, scope);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const text = await res.text();
  let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok || !json.access_token) {
    throw new GoogleAuthError(`Google sign-in failed (${res.status}): ${json.error_description ?? json.error ?? text.slice(0, 200)}`, res.status);
  }
  const ttl = Math.min(55 * 60, Math.max(60, (json.expires_in ?? 3600) - 300));
  tokens.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + ttl * 1000 });
  return json.access_token;
}
