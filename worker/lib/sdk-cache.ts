// Cache of the RevflareKit read endpoints (GET /sdk/v1/offerings, GET /sdk/v1/config). Every install calls them at
// launch, so they must not cost a database read per request (Free plan: 5M rows read a day, shared with everything else).
//
//   1. Isolate memory: SDK key → { body, version } for 60 s (unknown keys too, so junk keys cannot hammer the database).
//   2. Cloudflare Cache API (`caches.default`, per data center; a no-op on *.workers.dev): the built body for 60 s.
//   3. Database: one indexed read of the app row and its config row, then 1 and 2 are filled.
//
// A change made through the API forgets the entry in this isolate and in this data center's cache right away; other
// isolates / data centers pick it up within 60 s, the same time devices keep the response (Cache-Control: max-age=60).
// The `version` (ETag) lets RevflareKit revalidate with If-None-Match and get a 304 without a body.

import type { Db } from "./db";
import { readSdkOfferings } from "./offerings";
import { compile, EMPTY_REMOTE_CONFIG, readSdkRemoteConfig, type CompiledRemoteConfig } from "./remote-config";

export const SDK_OFFERINGS_TTL_S = 60;
export const SDK_CONFIG_TTL_S = 60;
const MAX_ENTRIES = 1_000;

type Stored = { body: string; version: string };

function cacheApi(): Cache | null {
  try {
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

/** Counters for tests: where answers came from (both endpoints). */
export const sdkCacheStats = { memory: 0, cache: 0, database: 0 };

/** A per-endpoint cache: `read` loads { body, version } from the database, `parse` turns the body into what is kept in memory. */
function sdkCache<T>(path: string, ttl: number, read: (db: Db, key: string) => Promise<Stored | null>, parse: (s: Stored) => T) {
  const memory = new Map<string, { value: T | null; expires: number }>();
  const cacheUrl = (sdkKey: string, requestUrl: string) => new URL(`${path}/__cache/${encodeURIComponent(sdkKey)}`, requestUrl).toString();
  const remember = (sdkKey: string, value: T | null) => {
    if (memory.size >= MAX_ENTRIES) memory.delete(memory.keys().next().value!);
    memory.set(sdkKey, { value, expires: Date.now() + ttl * 1000 });
  };
  return {
    /** The value for an SDK key (null: unknown key). `waitUntil` keeps the Cache API write alive after the response. */
    async get(db: Db, sdkKey: string, requestUrl: string, waitUntil?: (p: Promise<unknown>) => void): Promise<T | null> {
      const hit = memory.get(sdkKey);
      if (hit && hit.expires > Date.now()) {
        sdkCacheStats.memory++;
        return hit.value;
      }
      const cache = cacheApi();
      const url = cacheUrl(sdkKey, requestUrl);
      if (cache) {
        const res = await cache.match(url).catch(() => undefined);
        const version = res?.headers.get("x-revflare-version");
        if (res && version) {
          const value = parse({ body: await res.text(), version });
          sdkCacheStats.cache++;
          remember(sdkKey, value);
          return value;
        }
      }
      sdkCacheStats.database++;
      const stored = await read(db, sdkKey);
      const value = stored ? parse(stored) : null;
      remember(sdkKey, value);
      if (stored && cache) {
        const put = cache
          .put(url, new Response(stored.body, { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}`, "x-revflare-version": stored.version } }))
          .catch(() => undefined);
        if (waitUntil) waitUntil(put);
        else await put;
      }
      return value;
    },
    /** Drops an SDK key's cached value (after a change, a key rotation). */
    async forget(sdkKey: string | null | undefined, requestUrl: string): Promise<void> {
      if (!sdkKey) return;
      memory.delete(sdkKey);
      await cacheApi()
        ?.delete(cacheUrl(sdkKey, requestUrl))
        .catch(() => undefined);
    },
  };
}

const offerings = sdkCache("/sdk/v1/offerings", SDK_OFFERINGS_TTL_S, readSdkOfferings, (s) => s);

const remoteConfig = sdkCache("/sdk/v1/config", SDK_CONFIG_TTL_S, readSdkRemoteConfig, (s): { config: CompiledRemoteConfig; version: string } => {
  try {
    return { config: JSON.parse(s.body) as CompiledRemoteConfig, version: s.version };
  } catch {
    return { config: compile(EMPTY_REMOTE_CONFIG), version: s.version };
  }
});

/** The offerings payload for an SDK key (null: unknown key). */
export const sdkOfferings = offerings.get;
export const forgetSdkOfferings = offerings.forget;

/** The compiled remote config for an SDK key (null: unknown key); values are resolved per device by the route. */
export const sdkRemoteConfig = remoteConfig.get;
export const forgetSdkRemoteConfig = remoteConfig.forget;
