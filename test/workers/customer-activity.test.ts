import { env, fetchMock } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventsTestHooks, resetEventsState } from "../../worker/lib/events";
import { groupActivity } from "../../worker/lib/customer-activity";
import { resetWaeCache } from "../../worker/lib/wae";
import { DAY, call, notification, ownerClient } from "./helpers";

const CF = "https://api.cloudflare.com";
const SQL_PATH = `/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
beforeEach(() => {
  eventsTestHooks.binding = { writeDataPoint: () => {} };
  resetEventsState();
  resetWaeCache();
});
afterEach(() => {
  eventsTestHooks.binding = null;
  fetchMock.assertNoPendingInterceptors();
});
afterAll(() => {
  resetWaeCache();
});

function sqlAnswer(rows: Record<string, unknown>[] | null, sink: string[]) {
  fetchMock
    .get(CF)
    .intercept({ path: SQL_PATH, method: "POST" })
    .reply((opts) => {
      sink.push(String(opts.body));
      return rows ? { statusCode: 200, data: JSON.stringify({ meta: [], data: rows, rows: rows.length }) } : { statusCode: 500, data: JSON.stringify({ errors: [{ message: "boom" }] }) };
    });
}

describe("customer last seen and activity", () => {
  it("groups events into sessions, newest first, folding repeats", () => {
    const now = 10 * DAY;
    const ev = (name: string, ts: number, sessionId: string, extra: Record<string, string> = {}) => ({
      name,
      ts,
      sessionId,
      installId: "i1",
      appVersion: "2.0",
      environment: "production",
      placement: "",
      offering: "",
      product: "",
      step: "",
      screen: "",
      ...extra,
    });
    const a = groupActivity(
      [
        ev("app_open", now - 5 * HOUR, "s1"),
        ev("screen_view", now - 5 * HOUR + 1000, "s1", { screen: "home" }),
        ev("screen_view", now - 5 * HOUR + 2000, "s1", { screen: "home" }),
        ev("paywall_view", now - 5 * HOUR + 3000, "s1", { placement: "onboarding", product: "pro_yearly" }),
        ev("app_open", now - HOUR, "s2"),
        // No session id: grouped by 30-minute gaps.
        ev("legacy", now - 3 * DAY, ""),
        ev("legacy", now - 3 * DAY + 10 * MIN, ""),
        ev("legacy", now - 2 * DAY, ""),
      ],
      "events",
      now,
    );
    expect(a.lastEventAt).toBe(now - HOUR);
    expect(a.sessions.map((s) => s.sessionId)).toEqual(["s2", "s1", "", ""]);
    expect(a.sessions[1].events).toEqual([
      { name: "app_open", ts: now - 5 * HOUR, detail: null, count: 1 },
      { name: "screen_view", ts: now - 5 * HOUR + 1000, detail: "screen home", count: 2 },
      { name: "paywall_view", ts: now - 5 * HOUR + 3000, detail: "placement onboarding · product pro_yearly", count: 1 },
    ]);
    expect(a.sessions[3].events).toEqual([{ name: "legacy", ts: now - 3 * DAY, detail: null, count: 2 }]);
    expect(a.truncated).toBe(false);
  });

  it("ignores renewals and notifications for last seen; uses the app's events when the customer has an install", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.lastseen";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Last seen", bundleId } });
    const sdkKey = app.json.sdkKey as string;
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const post = async (n: { signedPayload: string }) => expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);

    // No install: bought 9 days ago (weekly), renewed 2 days ago. Last seen = the purchase, not the renewal.
    const t0 = Date.now() - 9 * DAY;
    const buy = { bundleId, transactionId: "98100", originalTransactionId: "98100", purchaseDate: t0, expiresDate: t0 + 7 * DAY, price: 990 };
    const renew = { ...buy, transactionId: "98101", purchaseDate: t0 + 7 * DAY, expiresDate: t0 + 14 * DAY, transactionReason: "RENEWAL" as const };
    await post(await notification("SUBSCRIBED", buy, { subtype: "INITIAL_BUY", signedDate: t0 }));
    await post(await notification("DID_RENEW", renew, { signedDate: t0 + 7 * DAY }));
    const feed = await call(owner, `/api/v1/transactions?apps=${app.json.id}&environment=all`);
    const cid = feed.json.items.find((t: any) => t.transactionId === "98101").customerId;
    const plain = await call(owner, `/api/v1/customers/${cid}`);
    expect(plain.json).toMatchObject({ lastSeenAt: t0, lastSeenSource: "purchase", activity: null, installIds: [] });

    // With an install: RevflareKit events (key events stored exactly) and every event in Analytics Engine.
    const I = "cccccccc-0000-4000-8000-00000000000c";
    const tA = Date.now() - 5 * DAY;
    const sub = { bundleId, transactionId: "98200", originalTransactionId: "98200", purchaseDate: tA, expiresDate: tA + 30 * DAY, price: 990, appAccountToken: I };
    await post(await notification("SUBSCRIBED", sub, { subtype: "INITIAL_BUY", signedDate: tA }));
    const s = "dddddddd-0000-4000-8000-00000000000d";
    const tE = Date.now() - 2 * HOUR;
    const events = [
      { id: "e1", name: "app_open", ts: tE, sessionId: s },
      { id: "e2", name: "paywall_view", ts: tE + 1000, sessionId: s, props: { placement: "settings" } },
      { id: "e3", name: "paywall_close", ts: tE + 9000, sessionId: s },
    ];
    expect((await call(null, "/sdk/v1/events", { body: { installId: I, appVersion: "3.1", events }, headers: { "x-revflare-key": sdkKey } })).status).toBe(200);
    const cid2 = (await call(owner, `/api/v1/transactions?apps=${app.json.id}&environment=all`)).json.items.find((t: any) => t.transactionId === "98200").customerId;

    // Analytics Engine answers: the full stream (app_open included); last seen = its latest event.
    const sqls: string[] = [];
    const row = (name: string, ts: number, extra: Record<string, unknown> = {}) => ({ name, ts, session: s, install: I, app_version: "3.1", environment: "production", placement: "", offering: "", product: "", step: "", screen: "", ...extra });
    sqlAnswer([row("paywall_close", tE + 9000), row("paywall_view", tE + 1000, { placement: "settings" }), row("app_open", tE)], sqls);
    const full = await call(owner, `/api/v1/customers/${cid2}`);
    expect(full.status).toBe(200);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain(`blob2 IN ('${I}')`);
    expect(full.json.installIds).toEqual([I]);
    expect(full.json.activity).toMatchObject({ source: "events", lastEventAt: tE + 9000, truncated: false });
    expect(full.json.activity.sessions).toHaveLength(1);
    expect(full.json.activity.sessions[0]).toMatchObject({ sessionId: s, installId: I, startedAt: tE, endedAt: tE + 9000, appVersion: "3.1" });
    expect(full.json.activity.sessions[0].events.map((e: any) => [e.name, e.detail])).toEqual([
      ["app_open", null],
      ["paywall_view", "placement settings"],
      ["paywall_close", null],
    ]);
    expect(full.json.lastSeenSource).toBe("app");
    expect(full.json.lastSeenAt).toBeGreaterThanOrEqual(tE + 9000);

    // Event queries failing: the exact key events stand in (no app_open: it is not a key event).
    resetWaeCache();
    sqlAnswer(null, sqls);
    const fallback = await call(owner, `/api/v1/customers/${cid2}`);
    expect(fallback.status).toBe(200);
    expect(fallback.json.activity.source).toBe("key_events");
    expect(fallback.json.activity.sessions[0].events.map((e: any) => e.name)).toEqual(["paywall_view", "paywall_close"]);
    expect(fallback.json.lastSeenSource).toBe("app");
  });
});
