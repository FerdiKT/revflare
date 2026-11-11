// Verification of App Store signed data (JWS with an x5c certificate chain): App Store Server Notifications V2,
// signedTransactionInfo / signedRenewalInfo and App Store Server API responses.
//
// The chain must be [leaf, Apple WWDR intermediate, Apple Root CA - G3]: the root must be byte-identical to the
// pinned Apple root, every certificate must be signed by the next and valid at the time the data was signed, and the
// leaf / intermediate must carry Apple's marker extensions (as Apple's App Store Server Library checks). Verified
// chains are cached per isolate, so only the first payload of a chain pays for the X.509 work.

import { fromBase64url } from "../lib/util";

/** Apple Root CA - G3 (https://www.apple.com/certificateauthority/AppleRootCA-G3.cer), DER, base64. */
export const APPLE_ROOT_CA_G3 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";

const OID_LEAF_MARKER = "1.2.840.113635.100.6.11.1";
const OID_INTERMEDIATE_MARKER = "1.2.840.113635.100.6.2.1";
const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const CURVES: Record<string, { name: "P-256" | "P-384"; size: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
};
const SIG_HASH: Record<string, "SHA-256" | "SHA-384"> = {
  "1.2.840.10045.4.3.2": "SHA-256",
  "1.2.840.10045.4.3.3": "SHA-384",
};

export class JwsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwsError";
  }
}

// --- Minimal DER reader -----------------------------------------------------------------------------------------

interface Tlv {
  tag: number;
  /** Whole element (tag + length + value). */
  raw: Uint8Array;
  value: Uint8Array;
}

function readTlv(buf: Uint8Array, offset: number): Tlv & { end: number } {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let p = offset + 2;
  if (len === undefined || tag === undefined) throw new JwsError("Truncated DER");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new JwsError("Bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  const end = p + len;
  if (end > buf.length) throw new JwsError("Truncated DER");
  return { tag, raw: buf.subarray(offset, end), value: buf.subarray(p, end), end };
}

function children(t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = 0;
  while (p < t.value.length) {
    const c = readTlv(t.value, p);
    out.push(c);
    p = c.end;
  }
  return out;
}

function oid(bytes: Uint8Array): string {
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let v = 0;
  for (let i = 1; i < bytes.length; i++) {
    v = v * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

function time(t: Tlv): number {
  const s = new TextDecoder().decode(t.value);
  // UTCTime YYMMDDHHMMSSZ or GeneralizedTime YYYYMMDDHHMMSSZ
  const full = t.tag === 0x17 ? (Number(s.slice(0, 2)) >= 50 ? "19" : "20") + s : s;
  const iso = `${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)}T${full.slice(8, 10)}:${full.slice(10, 12)}:${full.slice(12, 14)}Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new JwsError("Bad certificate time");
  return ms;
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface Certificate {
  der: Uint8Array;
  tbs: Uint8Array;
  sigHash: "SHA-256" | "SHA-384";
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  spki: Uint8Array;
  curve: { name: "P-256" | "P-384"; size: number };
  extensions: Set<string>;
}

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = readTlv(der, 0);
  const [tbs, sigAlg, sigValue] = children(cert);
  if (!tbs || !sigAlg || !sigValue) throw new JwsError("Bad certificate");
  const f = children(tbs);
  let i = 0;
  if (f[0]?.tag === 0xa0) i++; // [0] version
  const serial = f[i++];
  const innerAlg = f[i++];
  const issuer = f[i++];
  const validity = f[i++];
  const subject = f[i++];
  const spki = f[i++];
  if (!serial || !innerAlg || !issuer || !validity || !subject || !spki) throw new JwsError("Bad certificate");
  const extensions = new Set<string>();
  for (const rest of f.slice(i)) {
    if (rest.tag !== 0xa3) continue;
    const [list] = children(rest);
    for (const ext of list ? children(list) : []) {
      const [id] = children(ext);
      if (id) extensions.add(oid(id.value));
    }
  }
  const [algOid] = children(sigAlg);
  const sigHash = algOid ? SIG_HASH[oid(algOid.value)] : undefined;
  if (!sigHash) throw new JwsError("Unsupported certificate signature algorithm");
  const [keyAlg] = children(spki);
  const [keyType, curveOid] = keyAlg ? children(keyAlg) : [];
  if (!keyType || oid(keyType.value) !== OID_EC_PUBLIC_KEY || !curveOid) throw new JwsError("Unsupported certificate key");
  const curve = CURVES[oid(curveOid.value)];
  if (!curve) throw new JwsError("Unsupported certificate curve");
  const [notBefore, notAfter] = children(validity);
  return {
    der,
    tbs: tbs.raw,
    sigHash,
    // BIT STRING: first byte is the number of unused bits (0)
    signature: sigValue.value.subarray(1),
    issuer: issuer.raw,
    subject: subject.raw,
    notBefore: time(notBefore),
    notAfter: time(notAfter),
    spki: spki.raw,
    curve,
    extensions,
  };
}

/** DER ECDSA signature (SEQUENCE { r, s }) → raw r||s as WebCrypto expects. */
export function derSignatureToRaw(der: Uint8Array, size: number): Uint8Array {
  const seq = readTlv(der, 0);
  const [r, s] = children(seq);
  if (!r || !s) throw new JwsError("Bad signature");
  const out = new Uint8Array(size * 2);
  const put = (v: Uint8Array, at: number) => {
    let b = v;
    while (b.length > size && b[0] === 0) b = b.subarray(1);
    if (b.length > size) throw new JwsError("Bad signature");
    out.set(b, at + size - b.length);
  };
  put(r.value, 0);
  put(s.value, size);
  return out;
}

function importKey(cert: Certificate): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", cert.spki as BufferSource, { name: "ECDSA", namedCurve: cert.curve.name }, false, ["verify"]);
}

async function verifySignedBy(child: Certificate, parent: Certificate): Promise<boolean> {
  if (!equalBytes(child.issuer, parent.subject)) return false;
  const key = await importKey(parent);
  const raw = derSignatureToRaw(child.signature, parent.curve.size);
  return crypto.subtle.verify({ name: "ECDSA", hash: child.sigHash }, key, raw as BufferSource, child.tbs as BufferSource);
}

function b64ToBytes(b64: string): Uint8Array {
  return fromBase64url(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

export interface VerifyOptions {
  /** Trusted roots (base64 DER). Default: Apple Root CA - G3 only. */
  roots?: string[];
  /** Time the chain must be valid at (ms). Default: the payload's signedDate, else now. */
  at?: number;
}

const chainCache = new Map<string, Promise<{ key: CryptoKey; notBefore: number; notAfter: number }>>();

async function verifiedLeafKey(x5c: string[], roots: string[]) {
  const cacheKey = x5c.join(".") + "|" + roots.join(".");
  let p = chainCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      if (x5c.length !== 3) throw new JwsError("Expected a three-certificate chain");
      const [leaf, intermediate, root] = x5c.map((c) => parseCertificate(b64ToBytes(c)));
      if (!roots.some((r) => equalBytes(b64ToBytes(r), root.der))) throw new JwsError("Chain does not end in the Apple root");
      if (!intermediate.extensions.has(OID_INTERMEDIATE_MARKER)) throw new JwsError("Intermediate is not an Apple WWDR certificate");
      if (!leaf.extensions.has(OID_LEAF_MARKER)) throw new JwsError("Leaf is not an App Store signing certificate");
      if (!(await verifySignedBy(intermediate, root))) throw new JwsError("Intermediate certificate signature is invalid");
      if (!(await verifySignedBy(leaf, intermediate))) throw new JwsError("Leaf certificate signature is invalid");
      return {
        key: await importKey(leaf),
        notBefore: Math.max(leaf.notBefore, intermediate.notBefore, root.notBefore),
        notAfter: Math.min(leaf.notAfter, intermediate.notAfter, root.notAfter),
      };
    })();
    p.catch(() => chainCache.delete(cacheKey));
    if (chainCache.size > 50) chainCache.clear();
    chainCache.set(cacheKey, p);
  }
  return p;
}

/** Decodes a JWS without verifying it (for logging and tests). */
export function decodeJws<T>(jws: string): { header: Record<string, unknown>; payload: T } {
  const [h, p] = jws.split(".");
  if (!h || !p) throw new JwsError("Malformed JWS");
  const dec = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64url(s)));
  return { header: dec(h), payload: dec(p) as T };
}

/** Verifies an App Store JWS and returns its payload. Throws JwsError when anything does not check out. */
export async function verifyAppleJws<T extends { signedDate?: number }>(jws: string, opts: VerifyOptions = {}): Promise<T> {
  if (typeof jws !== "string") throw new JwsError("Missing JWS");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new JwsError("Malformed JWS");
  let header: { alg?: string; x5c?: string[] };
  let payload: T;
  try {
    ({ header, payload } = decodeJws<T>(jws) as { header: { alg?: string; x5c?: string[] }; payload: T });
  } catch {
    throw new JwsError("Malformed JWS");
  }
  if (header.alg !== "ES256") throw new JwsError("Unsupported JWS algorithm");
  if (!Array.isArray(header.x5c)) throw new JwsError("Missing certificate chain");
  const chain = await verifiedLeafKey(header.x5c, opts.roots ?? [APPLE_ROOT_CA_G3]);
  const at = opts.at ?? (typeof payload.signedDate === "number" ? payload.signedDate : Date.now());
  if (at < chain.notBefore || at > chain.notAfter) throw new JwsError("Certificate chain was not valid when the data was signed");
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    chain.key,
    fromBase64url(parts[2]) as BufferSource,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`) as BufferSource,
  );
  if (!ok) throw new JwsError("JWS signature is invalid");
  return payload;
}

/** Trusted roots for this deployment (the test root only in TEST_MODE). */
export function trustedRoots(env: Env): string[] {
  return env.TEST_MODE === "true" && env.TEST_APPLE_ROOT ? [APPLE_ROOT_CA_G3, env.TEST_APPLE_ROOT] : [APPLE_ROOT_CA_G3];
}

