import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { call, notification, ownerClient } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("notification forwarding", () => {
  it("passes verified notifications on unchanged to the app's forward URL", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.forward";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Forward", bundleId } });
    const id = app.json.id as string;
    expect((await call(owner, `/api/v1/apps/${id}`, { method: "PATCH", body: { forwardNotificationUrl: "http://rc.example.com/hook" } })).status).toBe(400);
    expect((await call(owner, `/api/v1/apps/${id}`, { method: "PATCH", body: { forwardNotificationUrl: "https://rc.example.com/hook/secret" } })).status).toBe(200);

    let forwarded = "";
    fetchMock
      .get("https://rc.example.com")
      .intercept({ path: "/hook/secret", method: "POST" })
      .reply((opts) => {
        forwarded = String(opts.body);
        return { statusCode: 200, data: "{}" };
      });
    const n = await notification("ONE_TIME_CHARGE", { bundleId, transactionId: "9700", type: "Non-Consumable", purchaseDate: Date.now() - 60_000, price: 990 });
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);

    let status: { status: number } | null = null;
    for (let i = 0; i < 50 && !status; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = (await call(owner, `/api/v1/apps/${id}`)).json.forwardStatus;
    }
    expect(status?.status).toBe(200);
    expect(JSON.parse(forwarded)).toEqual({ signedPayload: n.signedPayload });

    // Turned off: nothing is forwarded (no interceptor left, net connect disabled).
    expect((await call(owner, `/api/v1/apps/${id}`, { method: "PATCH", body: { forwardNotificationUrl: null } })).status).toBe(200);
    const m = await notification("ONE_TIME_CHARGE", { bundleId, transactionId: "9701", type: "Non-Consumable", purchaseDate: Date.now() - 30_000, price: 990 });
    expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: m.signedPayload } })).status).toBe(200);
    expect((await call(owner, `/api/v1/apps/${id}`)).json.forwardNotificationUrl).toBeNull();
  });
});
