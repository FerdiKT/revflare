import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { FetchLike } from "../src/api.js";
import type { App } from "../src/types.js";

export const app = (id: string, name: string, bundleId: string | null, extra: Partial<App> = {}): App => ({
  id,
  name,
  platform: "ios",
  bundleId,
  appleAppId: null,
  iconUrl: null,
  commissionPct: 15,
  archived: false,
  notificationUrlStatus: "revflare",
  revflareNotificationUrl: "https://rf.test/apple/notifications/k",
  currentNotificationUrl: null,
  lastNotificationAt: null,
  lastHistorySyncAt: null,
  historyBackfilledFrom: null,
  rcProjectId: null,
  storeAvailable: true,
  sdkKey: null,
  mrr: 0,
  revenue28d: 0,
  activeSubscriptions: 0,
  activeTrials: 0,
  ...extra,
});

export interface Call {
  method: string;
  url: URL;
  body: any;
  headers: Record<string, string>;
}

/** A non-200 answer for `mockFetch` routes. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
export const reply = (status: number, body: unknown) => new Reply(status, body);
export const QUOTA = reply(503, { error: "Revflare reached today's Cloudflare free plan database limit. It resets at 00:00 UTC.", code: "quota" });
export const BUDGET = reply(429, { error: "Today's database budget for imports is used up (Cloudflare free plan). Continue after 00:00 UTC.", code: "budget" });

/** A fetch that answers from `routes` ("GET /apps" → JSON or a function of the call) and records the calls. */
export function mockFetch(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const call: Call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const route = routes[`${method} ${path}`];
    if (route === undefined) return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 404 });
    const data = typeof route === "function" ? (route as (c: Call) => unknown)(call) : route;
    if (data instanceof Reply) return new Response(JSON.stringify(data.body), { status: data.status, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

/** Env with a logged-in profile in a temporary config file. */
export function loggedInEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "revflare-test-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ current: "default", profiles: { default: { url: "https://rf.test", key: "rf_testkey123" } } }));
  return { REVFLARE_CONFIG: path, HOME: dir };
}

/** Captures stdout / stderr. */
export function capture() {
  const out = { stdout: "", stderr: "" };
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => ((out.stdout += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => ((out.stderr += String(s)), true));
  return out;
}
