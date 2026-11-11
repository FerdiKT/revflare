import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  META_WAIT_MS,
  buildExtinfo,
  buildMetaEvent,
  metaEventId,
  parseIdentifiers,
  parseMetaConfig,
  parseMetaUpdate,
  planMetaEvent,
  type InstallIdentifiers,
  type MetaConfig,
  type MetaTx,
} from "../worker/lib/meta";

const NOW = Date.UTC(2026, 9, 20, 12);
const HOUR = 3_600_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const tx = (o: Partial<MetaTx> = {}): MetaTx => ({
  transactionId: "2000001",
  originalTransactionId: "2000000",
  customerId: "cus_example",
  kind: "new",
  productId: "com.example.app.monthly",
  purchasedAt: NOW - HOUR,
  grossUsd: 9.99,
  refundedAt: null,
  environment: "Production",
  ...o,
});

const ids = (o: Partial<InstallIdentifiers> = {}): InstallIdentifiers => ({
  fbAnonId: "XZ11111111-2222-3333-4444-555555555555",
  idfa: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
  idfv: "11111111-2222-4333-8444-555555555555",
  attStatus: "authorized",
  bundleId: "com.example.app",
  appVersion: "2.1",
  appBuild: "45",
  osVersion: "18.0",
  deviceModel: "iPhone15,2",
  locale: "en_US",
  timeZone: "Europe/Istanbul",
  extinfo: null,
  ip: "203.0.113.7",
  userAgent: "Example/2.1",
  ...o,
});

const config = (f: (c: MetaConfig) => void = () => {}) => {
  const c = parseMetaConfig(null);
  f(c);
  return c;
};

const plan = (o: { tx?: MetaTx; ids?: InstallIdentifiers | null; linked?: boolean; config?: MetaConfig; enabled?: boolean; queuedAt?: number; testInstall?: string | null } = {}) =>
  planMetaEvent({ tx: o.tx ?? tx(), ids: o.ids === undefined ? ids() : o.ids, linked: o.linked ?? true, config: o.config ?? config(), enabled: o.enabled ?? true, queuedAt: o.queuedAt ?? NOW - HOUR, now: NOW, testInstall: o.testInstall });

describe("Meta config and mapping", () => {
  it("defaults: every event on with Meta's standard names, Sandbox and no-ATT off", () => {
    const c = parseMetaConfig("{}");
    expect(c.sendSandbox).toBe(false);
    expect(c.sendWithoutAtt).toBe(false);
    expect(Object.fromEntries(Object.entries(c.events).map(([k, v]) => [k, v.enabled ? v.name : null]))).toEqual({
      trial_started: "StartTrial",
      initial_purchase: "Subscribe",
      trial_converted: "Subscribe",
      renewal: "Subscribe",
      non_subscription_purchase: "Purchase",
    });
    // Invalid stored names fall back to the default.
    expect(parseMetaConfig(JSON.stringify({ events: { renewal: { enabled: false, name: "Bad!" } } })).events.renewal).toEqual({ enabled: false, name: "Subscribe" });
  });

  it("maps each ledger kind to its event type, name and USD value", async () => {
    const cases: [string, string, string, number][] = [
      ["trial", "trial_started", "StartTrial", 0],
      ["new", "initial_purchase", "Subscribe", 9.99],
      ["conversion", "trial_converted", "Subscribe", 9.99],
      ["renewal", "renewal", "Subscribe", 9.99],
      ["one_time", "non_subscription_purchase", "Purchase", 9.99],
    ];
    for (const [kind, type, name, value] of cases) {
      const p = await plan({ tx: tx({ kind, grossUsd: kind === "trial" ? 0 : 9.99 }) });
      expect(p).toMatchObject({ action: "send", type, name });
      if (p.action === "send") {
        expect(p.event.event_name).toBe(name);
        expect(p.event.custom_data).toMatchObject({ currency: "USD", value });
        expect(p.event.event_id).toBe(`2000001_${type}`);
      }
    }
  });

  it("uses custom names and skips toggled-off types", async () => {
    const c = config((c) => {
      c.events.renewal.name = "Renewal Purchase";
      c.events.trial_started.enabled = false;
    });
    expect(await plan({ tx: tx({ kind: "renewal" }), config: c })).toMatchObject({ action: "send", name: "Renewal Purchase" });
    expect(await plan({ tx: tx({ kind: "trial" }), config: c })).toEqual({ action: "skip", type: "trial_started", name: "StartTrial", reason: "trial_started events are turned off" });
    expect(await plan({ enabled: false })).toMatchObject({ action: "skip", reason: "Integration disabled" });
  });

  it("validates PUT bodies", () => {
    expect(parseMetaUpdate({ enabled: true, datasetId: " 123456789 ", accessToken: "", events: { renewal: { name: "My Renewal_1" }, trial_started: { enabled: false, name: null } } })).toEqual({
      enabled: true,
      datasetId: "123456789",
      accessToken: null,
      events: { renewal: { name: "My Renewal_1" }, trial_started: { enabled: false, name: null } },
    });
    expect(parseMetaUpdate({ datasetId: "abc" })).toHaveProperty("error");
    expect(parseMetaUpdate({ enabled: "yes" })).toHaveProperty("error");
    expect(parseMetaUpdate({ events: { refund: { enabled: true } } })).toHaveProperty("error");
    expect(parseMetaUpdate({ events: { renewal: { name: "x".repeat(41) } } })).toHaveProperty("error");
    expect(parseMetaUpdate({ events: { renewal: { name: "Bad/Name" } } })).toHaveProperty("error");
  });
});

describe("Meta payload", () => {
  it("builds user_data, app_data and custom_data", async () => {
    const e = await buildMetaEvent(tx(), ids(), "initial_purchase", "Subscribe");
    expect(e).toEqual({
      event_name: "Subscribe",
      event_time: Math.floor((NOW - HOUR) / 1000),
      action_source: "app",
      event_id: "2000001_initial_purchase",
      user_data: {
        anon_id: "XZ11111111-2222-3333-4444-555555555555",
        madid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
        external_id: sha("cus_example"),
        client_ip_address: "203.0.113.7",
        client_user_agent: "Example/2.1",
      },
      app_data: {
        advertiser_tracking_enabled: 1,
        application_tracking_enabled: 1,
        vendor_id: "11111111-2222-4333-8444-555555555555",
        extinfo: ["i2", "com.example.app", "2.1", "45", "18.0", "iPhone15,2", "en_US", "", "", "0", "0", "0", "0", "0", "0", "Europe/Istanbul"],
      },
      custom_data: {
        currency: "USD",
        value: 9.99,
        order_id: "2000001_initial_purchase",
        content_type: "product",
        content_ids: ["com.example.app.monthly"],
        contents: [{ id: "com.example.app.monthly", quantity: 1 }],
      },
    });
  });

  it("prefers the SDK's extinfo, hashes the original transaction id without a customer, omits unknown ids", async () => {
    const extinfo = Array.from({ length: 16 }, (_, i) => `x${i}`);
    expect(buildExtinfo({ ...ids(), extinfo })).toBe(extinfo);
    expect(buildExtinfo({ extinfo: null, bundleId: null, appVersion: null, appBuild: null, osVersion: null, deviceModel: null, locale: null, timeZone: null })).toEqual([
      "i2", "", "", "", "", "", "", "", "", "0", "0", "0", "0", "0", "0", "",
    ]);
    const e = await buildMetaEvent(tx({ customerId: null, grossUsd: 4.994 }), ids({ fbAnonId: null, idfv: null, ip: null, userAgent: null, attStatus: "denied", idfa: null }), "renewal", "Subscribe");
    expect(e.user_data).toEqual({ external_id: sha("2000000") });
    expect(e.app_data).toEqual({ advertiser_tracking_enabled: 0, application_tracking_enabled: 1, extinfo: expect.any(Array) });
    expect(e.custom_data.value).toBe(4.99);
  });

  it("event_id = order_id = <transaction id>_<event type>, stable across builds", async () => {
    expect(metaEventId("2000001", "renewal")).toBe("2000001_renewal");
    const a = await buildMetaEvent(tx(), ids(), "renewal", "Subscribe");
    const b = await buildMetaEvent(tx(), ids({ ip: "198.51.100.1" }), "renewal", "Renewal");
    expect(a.event_id).toBe(b.event_id);
    expect(a.custom_data.order_id).toBe(a.event_id);
  });
});

describe("Meta gating", () => {
  it("ATT: authorized sends; denied skips unless sendWithoutAtt", async () => {
    expect(await plan()).toMatchObject({ action: "send" });
    const denied = ids({ attStatus: "denied", idfa: null });
    expect(await plan({ ids: denied })).toMatchObject({ action: "skip", reason: "ATT not authorized (denied)" });
    const p = await plan({ ids: denied, config: config((c) => (c.sendWithoutAtt = true)) });
    expect(p).toMatchObject({ action: "send" });
    if (p.action === "send") {
      expect(p.event.app_data.advertiser_tracking_enabled).toBe(0);
      expect(p.event.user_data.madid).toBeUndefined();
      expect(p.event.user_data.anon_id).toBe("XZ11111111-2222-3333-4444-555555555555");
    }
  });

  it("skips without anon_id and IDFA", async () => {
    expect(await plan({ ids: ids({ fbAnonId: null, idfa: null }) })).toMatchObject({ action: "skip", reason: "No anon_id (Facebook SDK) and no IDFA for this install" });
    expect(await plan({ ids: ids({ fbAnonId: null }) })).toMatchObject({ action: "send" });
  });

  it("Sandbox only with sendSandbox", async () => {
    expect(await plan({ tx: tx({ environment: "Sandbox" }) })).toMatchObject({ action: "skip", reason: "Sandbox transaction (Sandbox sending is off)" });
    expect(await plan({ tx: tx({ environment: "Sandbox" }), config: config((c) => (c.sendSandbox = true)) })).toMatchObject({ action: "send" });
  });

  it("test installs (sandbox / Xcode builds, test devices) only with sendSandbox", async () => {
    expect(await plan({ testInstall: "sandbox" })).toMatchObject({ action: "skip", reason: "Test install (sandbox; Sandbox sending is off)" });
    expect(await plan({ testInstall: "test device" })).toMatchObject({ action: "skip", reason: "Test install (test device; Sandbox sending is off)" });
    expect(await plan({ testInstall: "sandbox", config: config((c) => (c.sendSandbox = true)) })).toMatchObject({ action: "send" });
    expect(await plan({ testInstall: null })).toMatchObject({ action: "send" });
  });

  it("skips refunds and anything older than 7 days", async () => {
    expect(await plan({ tx: tx({ refundedAt: NOW }) })).toMatchObject({ action: "skip", reason: "Refunded" });
    expect(await plan({ tx: tx({ purchasedAt: NOW - 7 * 24 * HOUR - 1 }) })).toMatchObject({ action: "skip", reason: "Older than Meta's 7-day window" });
  });

  it("waits up to 24 h for the install and its identifiers, then skips", async () => {
    expect(await plan({ linked: false, ids: null })).toMatchObject({ action: "wait" });
    expect(await plan({ ids: null })).toMatchObject({ action: "wait", reason: "Waiting for the install's identifiers" });
    expect(await plan({ linked: false, ids: null, queuedAt: NOW - META_WAIT_MS - 1 })).toMatchObject({ action: "skip", reason: expect.stringMatching(/^No install linked/) });
    expect(await plan({ ids: null, queuedAt: NOW - META_WAIT_MS - 1 })).toMatchObject({ action: "skip", reason: expect.stringMatching(/sent no identifiers/) });
    expect(await plan({ tx: tx({ purchasedAt: NOW + HOUR }) })).toEqual({ action: "wait", reason: "Purchase time is in the future", until: NOW + HOUR });
  });
});

describe("POST /sdk/v1/identifiers body", () => {
  const base = { installId: "44444444-4444-4444-8444-444444444444", attStatus: "authorized" };
  it("trims, uppercases ids, treats a zeroed IDFA as missing", () => {
    const r = parseIdentifiers({ ...base, installId: base.installId.toUpperCase(), fbAnonId: "  XZabc  ", idfa: "00000000-0000-0000-0000-000000000000", idfv: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", appVersion: " 2.1 ", locale: "" });
    expect(r).toEqual({
      installId: base.installId,
      ids: { fbAnonId: "XZabc", idfa: null, idfv: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", attStatus: "authorized", bundleId: null, appVersion: "2.1", appBuild: null, osVersion: null, deviceModel: null, locale: null, timeZone: null, extinfo: null },
    });
  });
  it("rejects bad input", () => {
    expect(parseIdentifiers({ ...base, installId: "nope" })).toHaveProperty("error");
    expect(parseIdentifiers({ ...base, attStatus: "maybe" })).toHaveProperty("error");
    expect(parseIdentifiers({ installId: base.installId })).toHaveProperty("error");
    expect(parseIdentifiers({ ...base, idfa: "not-a-uuid" })).toHaveProperty("error");
    expect(parseIdentifiers({ ...base, fbAnonId: "x".repeat(129) })).toHaveProperty("error");
    expect(parseIdentifiers({ ...base, appVersion: 3 })).toHaveProperty("error");
    expect(parseIdentifiers({ ...base, extinfo: ["i2"] })).toHaveProperty("error");
    expect(parseIdentifiers({ ...base, extinfo: Array(16).fill("a") })).toMatchObject({ ids: { extinfo: Array(16).fill("a") } });
  });
});
