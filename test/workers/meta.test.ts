import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GRAPH_VERSION, sendMetaEvents } from "../../worker/lib/meta";
import { DAY, call, notification, ownerClient } from "./helpers";

const GRAPH = "https://graph.facebook.com";
const DATASET = "100000000000001";
const TOKEN = "EAAexampletoken0000000000000000";
const MIN = 60_000;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

type Sent = { body: Record<string, any>; headers: Record<string, string> };

/** Intercepts one Conversions API request and records it. */
function interceptMeta(statusCode: number, data: unknown, sink: Sent[]) {
  fetchMock
    .get(GRAPH)
    .intercept({ path: `/${GRAPH_VERSION}/${DATASET}/events`, method: "POST" })
    .reply((opts) => {
      const h = opts.headers as Record<string, string> | string[] | undefined;
      const headers: Record<string, string> = {};
      if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) headers[h[i].toLowerCase()] = h[i + 1];
      else for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = String(v);
      sink.push({ body: JSON.parse(String(opts.body)), headers });
      return { statusCode, data: JSON.stringify(data) };
    });
}

describe("Meta Ads integration", () => {
  it("sends purchases to the Conversions API once the install's identifiers are known", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.meta";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Meta", bundleId } });
    const id = app.json.id as string;
    const sdkKey = app.json.sdkKey as string;
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const url = `/api/v1/apps/${id}/integrations/meta`;
    const put = (body: object) => call(owner, url, { method: "PUT", body });

    // Settings: defaults, validation, write-only token.
    const initial = await call(owner, url);
    expect(initial.json).toMatchObject({ enabled: false, datasetId: null, accessTokenSet: false, sendSandbox: false, sendWithoutAtt: false, stats: { pending: 0, sent: 0, skipped: 0, failed: 0 } });
    expect(initial.json.events.renewal).toEqual({ enabled: true, name: "Subscribe", defaultName: "Subscribe" });
    expect((await put({ enabled: true })).status).toBe(400);
    expect((await put({ datasetId: "not-a-number" })).status).toBe(400);
    expect((await put({ events: { renewal: { name: "Bad/Name" } } })).status).toBe(400);
    const saved = await put({ datasetId: DATASET, accessToken: TOKEN, testEventCode: "TEST123", enabled: true, events: { renewal: { name: "Renewal" } } });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ enabled: true, datasetId: DATASET, accessTokenSet: true, testEventCode: "TEST123", events: { renewal: { enabled: true, name: "Renewal" } } });
    expect(saved.text).not.toContain("EAAexample");
    expect((await call(owner, url)).text).not.toContain("EAAexample");
    expect((await call(owner, `/api/v1/apps/${id}`)).json.metaEnabled).toBe(true);

    // A subscription bought with appAccountToken = install id, before the SDK sent identifiers: it waits.
    const install = "44444444-4444-4444-8444-444444444444";
    const t0 = Date.now() - 2 * 3_600_000;
    const sub = await notification("SUBSCRIBED", { bundleId, transactionId: "9900", purchaseDate: t0, expiresDate: t0 + 30 * DAY, price: 4990, appAccountToken: install });
    expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: sub.signedPayload } })).status).toBe(200);
    const waiting = await sendMetaEvents(env, {});
    expect(waiting[id]).toMatchObject({ waiting: 1, requests: 0 });
    expect((await call(owner, url)).json.stats.pending).toBe(1);

    // RevflareKit: POST /sdk/v1/identifiers.
    const ids = { installId: install, fbAnonId: "XZ-anon-1", idfa: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", idfv: "11111111-2222-4333-8444-555555555555", attStatus: "authorized", bundleId, appVersion: "2.1", appBuild: "45", osVersion: "18.0", deviceModel: "iPhone15,2", locale: "en_US", timeZone: "Europe/Istanbul" };
    expect((await call(null, "/sdk/v1/identifiers", { body: { ...ids, sdkKey, idfa: "bad" } })).status).toBe(400);
    expect((await call(null, "/sdk/v1/identifiers", { body: { ...ids, sdkKey, attStatus: undefined } })).status).toBe(400);
    expect((await call(null, "/sdk/v1/identifiers", { body: { ...ids, sdkKey: "rfp_unknown" } })).status).toBe(404);
    const reported = await call(null, "/sdk/v1/identifiers", { body: ids, headers: { "x-revflare-key": sdkKey, "cf-connecting-ip": "203.0.113.7", "user-agent": "Example/2.1" } });
    expect(reported.status).toBe(200);
    expect(reported.json).toEqual({ ok: true });

    // Meta answers 500: the event stays pending and is retried after a minute.
    const sent: Sent[] = [];
    interceptMeta(500, { error: { message: "Service temporarily unavailable", fbtrace_id: "Aex1" } }, sent);
    const at = Date.now() + 10 * MIN;
    expect((await sendMetaEvents(env, { at }))[id]).toMatchObject({ requests: 1, retrying: 1, sent: 0 });
    let status = (await call(owner, url)).json;
    expect(status.stats).toEqual({ pending: 1, sent: 0, skipped: 0, failed: 0 });
    expect(status.lastError).toContain("500");
    expect((await sendMetaEvents(env, { at: at + 30_000 }))[id]).toBeUndefined();

    interceptMeta(200, { events_received: 1, messages: [], fbtrace_id: "Aex2" }, sent);
    expect((await sendMetaEvents(env, { at: at + 2 * MIN }))[id]).toMatchObject({ requests: 1, sent: 1 });
    expect(sent).toHaveLength(2);
    const req = sent[1];
    expect(req.headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(req.body).toMatchObject({ partner_agent: "revflare", access_token: TOKEN, test_event_code: "TEST123" });
    expect(req.body.data).toHaveLength(1);
    const ev = req.body.data[0];
    expect(ev).toMatchObject({ event_name: "Subscribe", event_time: Math.floor(t0 / 1000), action_source: "app", event_id: "9900_initial_purchase" });
    expect(ev.user_data).toEqual({ anon_id: "XZ-anon-1", madid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", external_id: expect.stringMatching(/^[0-9a-f]{64}$/), client_ip_address: "203.0.113.7", client_user_agent: "Example/2.1" });
    expect(ev.app_data).toEqual({
      advertiser_tracking_enabled: 1,
      application_tracking_enabled: 1,
      vendor_id: "11111111-2222-4333-8444-555555555555",
      extinfo: ["i2", bundleId, "2.1", "45", "18.0", "iPhone15,2", "en_US", "", "", "0", "0", "0", "0", "0", "0", "Europe/Istanbul"],
    });
    expect(ev.custom_data).toEqual({ currency: "USD", value: 4.99, order_id: "9900_initial_purchase", content_type: "product", content_ids: ["monthly"], contents: [{ id: "monthly", quantity: 1 }] });

    // A renewal (custom name) and an ATT-denied install's purchase: one request with the renewal, the other skipped.
    const renewal = await notification("DID_RENEW", { bundleId, transactionId: "9901", originalTransactionId: "9900", purchaseDate: t0 + 3_600_000, expiresDate: t0 + 60 * DAY, price: 4990, transactionReason: "RENEWAL" });
    expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: renewal.signedPayload } })).status).toBe(200);
    const denied = "55555555-5555-4555-8555-555555555555";
    expect((await call(null, "/sdk/v1/identifiers", { body: { sdkKey, installId: denied, fbAnonId: "XZ-anon-2", idfa: "00000000-0000-0000-0000-000000000000", attStatus: "denied" } })).status).toBe(200);
    const other = await notification("SUBSCRIBED", { bundleId, transactionId: "9910", purchaseDate: t0, expiresDate: t0 + 30 * DAY, price: 4990, appAccountToken: denied });
    expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: other.signedPayload } })).status).toBe(200);
    interceptMeta(200, { events_received: 1, fbtrace_id: "Aex3" }, sent);
    expect((await sendMetaEvents(env, { at: at + 3 * MIN }))[id]).toMatchObject({ requests: 1, sent: 1, skipped: 1 });
    expect(sent[2].body.data.map((e: any) => [e.event_name, e.event_id, e.custom_data.value])).toEqual([["Renewal", "9901_renewal", 4.99]]);

    // Delivery log (newest first) and stats.
    const log = (await call(owner, `${url}/log`)).json.items as any[];
    expect(log.map((d) => [d.transactionId, d.status, d.eventType])).toEqual(
      expect.arrayContaining([
        ["9900", "sent", "initial_purchase"],
        ["9901", "sent", "renewal"],
        ["9910", "skipped", "initial_purchase"],
      ]),
    );
    expect(log.find((d) => d.transactionId === "9910")).toMatchObject({ reason: "ATT not authorized (denied)", httpStatus: null, eventId: "9910_initial_purchase" });
    expect(log.find((d) => d.transactionId === "9900")).toMatchObject({ httpStatus: 200, eventName: "Subscribe", response: expect.stringContaining("Aex2") });
    status = (await call(owner, url)).json;
    expect(status.stats).toEqual({ pending: 0, sent: 2, skipped: 1, failed: 0 });
    expect(status.lastSentAt).toBeGreaterThan(0);
    expect(status.lastError).toBeNull();

    // Backfill: the skipped one goes back to pending, sent ones are never queued again.
    expect((await call(owner, `${url}/backfill`, { body: {} })).json).toEqual({ queued: 1 });
    expect((await call(owner, url)).json.stats.pending).toBe(1);

    // Test event: needs the test code; returns Meta's answer.
    interceptMeta(200, { events_received: 1, fbtrace_id: "Aex4" }, sent);
    const test = await call(owner, `${url}/test`, { body: {} });
    expect(test.status).toBe(200);
    expect(test.json).toMatchObject({ ok: true, status: 200, response: { events_received: 1 } });
    expect(sent[3].body).toMatchObject({ test_event_code: "TEST123", partner_agent: "revflare", data: [{ event_name: "Subscribe", action_source: "app" }] });
    expect((await put({ testEventCode: "" })).json.testEventCode).toBeNull();
    expect((await call(owner, `${url}/test`, { body: {} })).status).toBe(400);
  }, 30_000);

  it("splits a batch Meta rejects and fails only the bad event", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.metasplit";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Meta split", bundleId } });
    const id = app.json.id as string;
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    expect((await call(owner, `/api/v1/apps/${id}/integrations/meta`, { method: "PUT", body: { datasetId: DATASET, accessToken: TOKEN, enabled: true } })).status).toBe(200);
    const install = "66666666-6666-4666-8666-666666666666";
    expect((await call(null, "/sdk/v1/identifiers", { body: { sdkKey: app.json.sdkKey, installId: install, fbAnonId: "XZ-anon-3", attStatus: "authorized" } })).status).toBe(200);
    const t = Date.now() - 3_600_000;
    for (const txId of ["9920", "9930"]) {
      const n = await notification("SUBSCRIBED", { bundleId, transactionId: txId, purchaseDate: t, expiresDate: t + 30 * DAY, appAccountToken: install });
      expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    }
    const sent: Sent[] = [];
    const bad = { error: { message: "Invalid parameter", type: "OAuthException", code: 100, error_user_msg: "event_time is invalid", fbtrace_id: "Aex5" } };
    interceptMeta(400, bad, sent);
    const at = Date.now() + MIN;
    expect((await sendMetaEvents(env, { at }))[id]).toMatchObject({ requests: 1, retrying: 2 });
    interceptMeta(200, { events_received: 1 }, sent);
    interceptMeta(400, bad, sent);
    expect((await sendMetaEvents(env, { at: at + 1 }))[id]).toMatchObject({ requests: 2, sent: 1, failed: 1 });
    expect(sent.map((s) => s.body.data.length)).toEqual([2, 1, 1]);
    const log = (await call(owner, `/api/v1/apps/${id}/integrations/meta/log`)).json.items as any[];
    expect(log.find((d) => d.status === "failed")).toMatchObject({ httpStatus: 400, reason: "400 event_time is invalid", response: expect.stringContaining("Aex5") });
  }, 30_000);
});
