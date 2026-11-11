import { afterEach, describe, expect, it, vi } from "vitest";
import { metaUpdateBody } from "../src/commands/meta.js";
import { run } from "../src/main.js";
import type { MetaIntegration } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.meta")], currency: "USD" };
const ev = (name: string, enabled = true) => ({ enabled, name, defaultName: name });
const META: MetaIntegration = {
  enabled: true,
  datasetId: "100000000000001",
  accessTokenSet: true,
  testEventCode: "TEST123",
  sendSandbox: false,
  sendWithoutAtt: false,
  events: { trial_started: ev("StartTrial"), initial_purchase: ev("Subscribe"), trial_converted: ev("Subscribe"), renewal: { ...ev("Subscribe"), name: "Renewal" }, non_subscription_purchase: ev("Purchase", false) },
  stats: { pending: 2, sent: 40, skipped: 3, failed: 1 },
  lastSentAt: Date.UTC(2026, 9, 20, 12),
  lastError: null,
  backfilledAt: null,
};

describe("metaUpdateBody", () => {
  it("maps set flags to the PUT body", () => {
    expect(
      metaUpdateBody({ enable: true, "dataset-id": " 123456 ", "test-code": "", sandbox: "on", "without-att": "off", event: ["renewal=Renew Sub", "trial-started=default"], "event-off": ["non_subscription_purchase"] }, "EAAtoken"),
    ).toEqual({
      enabled: true,
      datasetId: "123456",
      accessToken: "EAAtoken",
      testEventCode: null,
      sendSandbox: true,
      sendWithoutAtt: false,
      events: { renewal: { enabled: true, name: "Renew Sub" }, trial_started: { enabled: true, name: null }, non_subscription_purchase: { enabled: false } },
    });
    expect(metaUpdateBody({ "clear-token": true })).toEqual({ accessToken: null });
    expect(() => metaUpdateBody({ enable: true, disable: true })).toThrow(/either/);
    expect(() => metaUpdateBody({ event: ["refund=Refund"] })).toThrow(/Unknown event type/);
    expect(() => metaUpdateBody({ event: ["renewal=Bad!"] })).toThrow(/Invalid event name/);
    expect(() => metaUpdateBody({ sandbox: "maybe" })).toThrow(/on or off/);
  });
});

describe("meta", () => {
  it("prints the status, never a token", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/integrations/meta": META });
    expect(await run(["meta", "com.example.meta", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toMatch(/Dataset id\s+100000000000001/);
    expect(out.stdout).toMatch(/Access token\s+set/);
    expect(out.stdout).toContain("40 sent · 2 pending · 3 skipped · 1 failed");
    expect(out.stdout).toMatch(/renewal\s+on\s+Renewal\s+Subscribe/);
    expect(out.stdout).toMatch(/non_subscription_purchase\s+off/);
  });

  it("set sends a PUT (token from stdin), test / backfill / log call their endpoints", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "PUT /apps/app_1/integrations/meta": META,
      "POST /apps/app_1/integrations/meta/test": { ok: true, status: 200, response: { events_received: 1, fbtrace_id: "AbC" } },
      "POST /apps/app_1/integrations/meta/backfill": { queued: 7 },
      "GET /apps/app_1/integrations/meta/log": {
        items: [{ id: 2, at: Date.UTC(2026, 9, 20), transactionId: "2000001", eventType: "renewal", eventName: "Subscribe", eventId: "2000001_renewal", status: "skipped", httpStatus: null, response: null, reason: "ATT not authorized (denied)" }],
      },
    });
    const env = loggedInEnv();
    const readStdin = async () => "EAAexampletoken000000000000\n";
    expect(await run(["meta", "app_1", "set", "--token", "-", "--event", "renewal=Subscribe", "--json"], { env, fetch, readStdin })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ accessToken: "EAAexampletoken000000000000", events: { renewal: { enabled: true, name: "Subscribe" } } });
    expect(await run(["meta", "app_1", "test", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain('"fbtrace_id":"AbC"');
    expect(await run(["meta", "app_1", "backfill"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain("7 purchases of the last 7 days queued");
    expect(await run(["meta", "app_1", "log", "--limit", "5", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("limit")).toBe("5");
    expect(out.stdout).toMatch(/Subscribe\s+2000001\s+skipped\s+-\s+ATT not authorized/);
  });

  it("rejects set flags without set, unknown actions and empty sets", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS });
    expect(await run(["meta", "app_1", "--enable"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(out.stderr).toContain("set ...");
    expect(await run(["meta", "app_1", "delete"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(await run(["meta", "app_1", "set"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(out.stderr).toContain("Nothing to change");
  });
});
