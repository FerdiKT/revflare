import type { Db } from "./db";
import { getSetting } from "./settings";
import { base64url, fromBase64url, randomToken } from "./util";

// Credentials (store API keys) are encrypted with AES-GCM. The key comes from SECRET_KEY, else from a random secret
// generated on first use and kept in the database.
let keyPromise: Promise<CryptoKey> | null = null;

async function rootSecret(env: Env, db: Db): Promise<string> {
  if (env.SECRET_KEY) return env.SECRET_KEY;
  let stored = await getSetting(db, "encryption_key");
  if (!stored) {
    await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('encryption_key', ?)").bind(randomToken(32)).run();
    stored = (await getSetting(db, "encryption_key"))!;
  }
  return stored;
}

function encryptionKey(env: Env, db: Db): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(await rootSecret(env, db)), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("revflare"), info: new TextEncoder().encode("aes") },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyPromise.catch(() => (keyPromise = null));
  }
  return keyPromise;
}

export async function encryptJson(env: Env, db: Db, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env, db), data);
  return `v1.${base64url(iv)}.${base64url(ct)}`;
}

export async function decryptJson<T>(env: Env, db: Db, blob: string): Promise<T> {
  const [version, iv, ct] = blob.split(".");
  if (version !== "v1" || !iv || !ct) throw new Error("Unsupported ciphertext");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, await encryptionKey(env, db), fromBase64url(ct));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

// 20k PBKDF2 iterations (~4-5 ms CPU) fit the Workers Free plan; brute force is limited by the login throttle.
const PBKDF2_ITERATIONS = 20_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !salt || !hash) return false;
  const bits = base64url(await pbkdf2(password, fromBase64url(salt), Number(iter)));
  return timingSafeEqual(bits, hash);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
}

/** PEM (or bare base64) PKCS#8 private key → bytes. */
export function pemToBytes(pem: string): Uint8Array {
  return fromBase64url(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

const signingKeys = new Map<string, Promise<CryptoKey>>();

/** The P-256 signing key of a .p8 (PKCS#8 PEM), imported once per isolate. */
export function ecdsaSigningKey(pem: string): Promise<CryptoKey> {
  let key = signingKeys.get(pem);
  if (!key) {
    key = crypto.subtle.importKey("pkcs8", pemToBytes(pem) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    key.catch(() => signingKeys.delete(pem));
    signingKeys.set(pem, key);
  }
  return key;
}

/** ES256 JWT signed with a .p8 key (App Store Server API, App Store Connect API, APNs). */
export async function es256Jwt(pem: string, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  const key = ecdsaSigningKey(pem);
  const head = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", ...header }));
  const body = base64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(sig)}`;
}
