import { env, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushTestHooks, type PushMessage } from "../../worker/lib/push";
import { verifyPolarSignature } from "../../worker/polar/ingest";
import { call, ownerClient, DAY } from "./helpers";

const db = env.DATABASE.get(env.DATABASE.idFromName("main"));
const rows = async <T = any>(sql: string, ...params: (string | number)[]) =>
  (
    (await db.exec([{ sql, params, mode: "all" }], false)) as {
      results: unknown[];
    }[]
  )[0].results as T[];

const pushes: { deviceId: string; msg: PushMessage }[] = [];
const INSTALL = "7d1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a";
const PRODUCT_LIFETIME = "11111111-1111-4111-8111-111111111111";
const PRODUCT_MONTHLY = "22222222-2222-4222-8222-222222222222";
const SECRET = `whsec_${btoa("revflare-polar-test-secret-key")}`;
const LEGACY_SECRET = "polar_whs_legacy_secret_value";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  pushTestHooks.sink = pushes;
});
afterAll(() => {
  pushTestHooks.sink = null;
});

async function sign(
  body: string,
  id: string,
  secret = SECRET,
  ts = Math.floor(Date.now() / 1000),
) {
  const raw = secret.startsWith("whsec_")
    ? Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${ts}.${body}`),
    ),
  );
  return {
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": `v1,${btoa(String.fromCharCode(...sig))}`,
  };
}

let n = 0;
let key = "";
async function webhook(
  type: string,
  data: unknown,
  opts: { secret?: string; id?: string; headers?: Record<string, string> } = {},
) {
  const body = JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    data,
  });
  const id = opts.id ?? `msg_${++n}`;
  const headers = opts.headers ?? (await sign(body, id, opts.secret));
  return call(null, `/polar/webhooks/${key}`, {
    body: JSON.parse(body),
    headers: { ...headers },
  });
}

const iso = (t: number) => new Date(t).toISOString();
const t0 = Date.now() - 2 * DAY;
const FRESH = Date.now() - 60_000;

function order(o: {
  id: string;
  product: string;
  net: number;
  status?: string;
  refunded?: number;
  subscription?: Record<string, unknown> | null;
  reason?: string;
  created?: number;
  modified?: number;
  fee?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}) {
  const recurring = o.product === PRODUCT_MONTHLY;
  return {
    id: o.id,
    created_at: iso(o.created ?? t0),
    modified_at: iso(o.modified ?? o.created ?? t0),
    status: o.status ?? "paid",
    paid: true,
    subtotal_amount: o.net,
    discount_amount: 0,
    net_amount: o.net,
    tax_amount: Math.round(o.net * 0.2),
    total_amount: Math.round(o.net * 1.2),
    refunded_amount: o.refunded ?? 0,
    refunded_tax_amount: 0,
    currency: o.currency ?? "usd",
    billing_reason:
      o.reason ?? (recurring ? "subscription_create" : "purchase"),
    billing_address: { country: "DE" },
    customer_id: "cus_polar_1",
    product_id: o.product,
    subscription_id: (o.subscription?.id as string) ?? null,
    metadata: o.metadata ?? { revflare_install_id: INSTALL.toUpperCase() },
    platform_fee_amount: o.fee ?? Math.round(o.net * 0.05),
    platform_fee_currency: "usd",
    customer: { id: "cus_polar_1", external_id: null, metadata: {} },
    product: recurring
      ? {
          id: PRODUCT_MONTHLY,
          name: "Pro Monthly",
          is_recurring: true,
          recurring_interval: "month",
          recurring_interval_count: 1,
        }
      : {
          id: PRODUCT_LIFETIME,
          name: "Full Version",
          is_recurring: false,
          recurring_interval: null,
        },
    subscription: o.subscription ?? null,
    items: [],
  };
}

function subscription(s: {
  id: string;
  status: string;
  start: number;
  cancelAtPeriodEnd?: boolean;
  endedAt?: number | null;
  modified?: number;
  reason?: string | null;
}) {
  return {
    id: s.id,
    created_at: iso(s.start),
    modified_at: iso(s.modified ?? s.start),
    amount: 999,
    currency: "usd",
    recurring_interval: "month",
    recurring_interval_count: 1,
    status: s.status,
    current_period_start: iso(s.start),
    current_period_end: iso(s.start + 30 * DAY),
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: !!s.cancelAtPeriodEnd,
    canceled_at:
      s.cancelAtPeriodEnd || s.endedAt ? iso(s.modified ?? s.start) : null,
    started_at: iso(s.start),
    ends_at: s.cancelAtPeriodEnd ? iso(s.start + 30 * DAY) : null,
    ended_at: s.endedAt ? iso(s.endedAt) : null,
    customer_id: "cus_polar_1",
    product_id: PRODUCT_MONTHLY,
    customer_cancellation_reason: s.reason ?? null,
    metadata: { revflare_install_id: INSTALL },
  };
}

let owner: Awaited<ReturnType<typeof ownerClient>>;
let appId = "";
const tx = (id: string) =>
  rows(
    `SELECT * FROM transactions WHERE app_id = ? AND transaction_id = ?`,
    appId,
    id,
  ).then((r) => r[0]);
const sub = (otid: string) =>
  rows(
    `SELECT * FROM subscriptions WHERE app_id = ? AND original_transaction_id = ?`,
    appId,
    otid,
  ).then((r) => r[0]);

describe("Polar", () => {
  it("verifies Standard Webhooks signatures (whsec_ and legacy raw secrets), refusing stale ones", async () => {
    const body = '{"type":"order.paid"}';
    expect(
      await verifyPolarSignature(
        body,
        toHeaders(await sign(body, "m1")),
        SECRET,
      ),
    ).toBe(true);
    expect(
      await verifyPolarSignature(
        body,
        toHeaders(await sign(body, "m1", LEGACY_SECRET)),
        LEGACY_SECRET,
      ),
    ).toBe(true);
    expect(
      await verifyPolarSignature(
        body + " ",
        toHeaders(await sign(body, "m1")),
        SECRET,
      ),
    ).toBe(false);
    expect(
      await verifyPolarSignature(
        body,
        toHeaders(
          await sign(body, "m1", SECRET, Math.floor(Date.now() / 1000) - 3600),
        ),
        SECRET,
      ),
    ).toBe(false);
    expect(
      await verifyPolarSignature(
        body,
        { id: "m1", timestamp: null, signature: null },
        SECRET,
      ),
    ).toBe(false);
  });

  it("adds a web app (or turns an iOS app without sales into one) and connects Polar", async () => {
    owner = await ownerClient();
    expect(
      (
        await call(owner, "/api/v1/devices", {
          body: {
            apnsToken: "7b3".padEnd(64, "0"),
            name: "Polar test",
            prefs: { timezone: "UTC", cancellations: true },
          },
        })
      ).status,
    ).toBeLessThan(300);
    // An iOS app with no store data can become a web app.
    const ios = await call(owner, "/api/v1/apps", {
      body: { name: "Site", bundleId: "com.example.site.web" },
    });
    expect(ios.status).toBe(201);
    expect(
      (await call(owner, `/api/v1/apps/${ios.json.id}/polar`)).status,
    ).toBe(400);
    expect(
      (
        await call(owner, `/api/v1/apps/${ios.json.id}`, {
          method: "PATCH",
          body: { platform: "android" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(owner, `/api/v1/apps/${ios.json.id}`, {
          method: "PATCH",
          body: { platform: "web" },
        })
      ).status,
    ).toBe(200);
    const app = (await call(owner, `/api/v1/apps/${ios.json.id}`)).json;
    expect(app).toMatchObject({ platform: "web", polar: { connected: false } });
    expect(app.revflareNotificationUrl).toMatch(
      /\/polar\/webhooks\/[A-Za-z0-9_-]+$/,
    );
    appId = app.id;
    key = (app.revflareNotificationUrl as string).split("/").pop()!;
    // App Store only features answer 400.
    expect(
      (
        await call(owner, `/api/v1/apps/${appId}/test-notification`, {
          method: "POST",
        })
      ).json.error,
    ).toMatch(/web \(Polar\)/);
    expect(
      (
        await call(owner, `/api/v1/apps/${appId}/integrations/refunds`, {
          method: "PUT",
          body: { enabled: true },
        })
      ).status,
    ).toBe(400);
    // A new web app.
    const web = await call(owner, "/api/v1/apps", {
      body: { platform: "web", name: "Other site" },
    });
    expect(web.status).toBe(201);
    expect(web.json.platform).toBe("web");

    // Webhooks before the secret: Polar retries (503), nothing stored.
    expect(
      (
        await webhook(
          "order.paid",
          order({ id: "ord_early", product: PRODUCT_LIFETIME, net: 999 }),
        )
      ).status,
    ).toBe(503);

    const put = await call(owner, `/api/v1/apps/${appId}/polar`, {
      method: "PUT",
      body: {
        webhookSecret: SECRET,
        products: { [PRODUCT_LIFETIME]: "full_version" },
      },
    });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({
      connected: true,
      hasAccessToken: false,
      sandbox: false,
      products: { [PRODUCT_LIFETIME]: "full_version" },
    });
    expect(put.json.webhookUrl).toBe(app.revflareNotificationUrl);
    expect(
      JSON.stringify(
        await rows("SELECT polar_secret FROM apps WHERE id = ?", appId),
      ),
    ).not.toContain("revflare-polar-test");
  });

  it("refuses bad signatures and unknown URLs", async () => {
    const o = order({ id: "ord_bad", product: PRODUCT_LIFETIME, net: 999 });
    expect(
      (
        await webhook("order.paid", o, {
          secret: `whsec_${btoa("another-secret-entirely")}`,
        })
      ).status,
    ).toBe(401);
    const saved = key;
    key = "nope";
    expect((await webhook("order.paid", o)).status).toBe(404);
    key = saved;
    expect(await tx("ord_bad")).toBeUndefined();
  });

  it("stores a one-time purchase with net price, Polar's fee taken off, linked to the install", async () => {
    const r = await webhook(
      "order.paid",
      order({
        id: "ord_1",
        product: PRODUCT_LIFETIME,
        net: 1999,
        fee: 120,
        created: FRESH,
      }),
      { id: "msg_once" },
    );
    expect(r.status).toBe(200);
    const t = await tx("ord_1");
    expect(t).toMatchObject({
      source: "polar",
      store: "polar",
      product_id: "full_version",
      product_type: "non_consumable",
      kind: "one_time",
      currency: "USD",
      price_milli: 19990,
      country: "DE",
      app_account_token: INSTALL,
    });
    expect(t.gross_usd).toBeCloseTo(19.99, 2);
    expect(t.proceeds_usd).toBeCloseTo(18.79, 2);
    expect(
      await rows(
        "SELECT install_id FROM install_links WHERE app_id = ? AND original_transaction_id = 'ord_1'",
        appId,
      ),
    ).toEqual([{ install_id: INSTALL }]);
    expect(
      (
        await rows(
          "SELECT name FROM products WHERE app_id = ? AND product_id = 'full_version'",
          appId,
        )
      )[0].name,
    ).toBe("Full Version");
    expect(
      pushes.some(
        (p) => p.msg.kind === "sale" && p.msg.data?.transactionId === "ord_1",
      ),
    ).toBe(true);
    // Redelivery: stored once.
    expect(
      (
        await webhook(
          "order.paid",
          order({
            id: "ord_1",
            product: PRODUCT_LIFETIME,
            net: 1999,
            fee: 120,
            created: FRESH,
          }),
          { id: "msg_once" },
        )
      ).json.duplicate,
    ).toBe(true);
    // Unused events and unpaid orders: acknowledged, nothing stored.
    expect(
      (await webhook("checkout.created", { id: "chk_1" })).json.ignored,
    ).toMatch(/not used/);
    expect(
      (
        await webhook("order.updated", {
          ...order({
            id: "ord_pending",
            product: PRODUCT_LIFETIME,
            net: 999,
            status: "pending",
          }),
          paid: false,
        })
      ).json.ignored,
    ).toMatch(/pending/);
    expect(await tx("ord_pending")).toBeUndefined();
  });

  it("applies full and partial refunds", async () => {
    await webhook(
      "order.paid",
      order({ id: "ord_2", product: PRODUCT_LIFETIME, net: 1000 }),
    );
    await webhook(
      "order.refunded",
      order({
        id: "ord_2",
        product: PRODUCT_LIFETIME,
        net: 1000,
        status: "partially_refunded",
        refunded: 250,
        modified: Date.now() - 120_000,
      }),
    );
    expect(await tx("ord_2")).toMatchObject({ refund_milli: 25_000 });
    expect((await tx("ord_2")).refunded_at).toBeGreaterThan(0);
    await webhook(
      "order.refunded",
      order({
        id: "ord_2",
        product: PRODUCT_LIFETIME,
        net: 1000,
        status: "refunded",
        refunded: 1000,
        modified: Date.now() - 60_000,
      }),
    );
    expect(await tx("ord_2")).toMatchObject({ refund_milli: null });
    const ev = (
      await rows<{ amount_usd: number; source: string }>(
        "SELECT amount_usd, source FROM events WHERE app_id = ? AND type = 'order.refunded' ORDER BY signed_at DESC LIMIT 1",
        appId,
      )
    )[0];
    expect(ev.source).toBe("polar");
    expect(ev.amount_usd).toBeCloseTo(10, 2);
    expect(
      pushes.some(
        (p) => p.msg.kind === "refund" && p.msg.data?.transactionId === "ord_2",
      ),
    ).toBe(true);
  });

  it("tracks subscriptions: MRR, renewals, cancellation at period end and revocation", async () => {
    const start = Date.now() - 40 * DAY;
    const s1 = subscription({ id: "sub_1", status: "active", start });
    // subscription.created before the order: nothing to apply yet.
    expect((await webhook("subscription.created", s1)).status).toBe(200);
    await webhook(
      "order.paid",
      order({
        id: "ord_s1",
        product: PRODUCT_MONTHLY,
        net: 999,
        subscription: s1,
        created: start,
      }),
    );
    expect(await tx("ord_s1")).toMatchObject({
      product_type: "auto_renewable",
      original_transaction_id: "sub_1",
      kind: "new",
      period: "P1M",
      product_id: PRODUCT_MONTHLY,
    });
    const renewalStart = start + 30 * DAY;
    const s1b = subscription({
      id: "sub_1",
      status: "active",
      start: renewalStart,
      modified: renewalStart,
    });
    await webhook(
      "order.paid",
      order({
        id: "ord_s2",
        product: PRODUCT_MONTHLY,
        net: 999,
        subscription: s1b,
        reason: "subscription_cycle",
        created: renewalStart,
      }),
    );
    expect(await tx("ord_s2")).toMatchObject({
      kind: "renewal",
      expires_at: renewalStart + 30 * DAY,
    });
    expect(await sub("sub_1")).toMatchObject({
      status: "active",
      auto_renew: 1,
      purchase_token: "sub_1",
    });
    expect((await sub("sub_1")).mrr_usd).toBeCloseTo(9.99, 2);
    // A proration charge is one-time revenue, not a renewal.
    await webhook(
      "order.paid",
      order({
        id: "ord_s3",
        product: PRODUCT_MONTHLY,
        net: 300,
        subscription: s1b,
        reason: "subscription_update",
        created: renewalStart + DAY,
      }),
    );
    expect(await tx("ord_s3")).toMatchObject({
      product_type: "consumable",
      kind: "one_time",
      original_transaction_id: "ord_s3",
    });

    // Cancelled at period end: still active, auto-renew off, a cancellation push.
    const cancelAt = Date.now() - 120_000;
    await webhook(
      "subscription.canceled",
      subscription({
        id: "sub_1",
        status: "active",
        start: renewalStart,
        cancelAtPeriodEnd: true,
        modified: cancelAt,
        reason: "too_expensive",
      }),
    );
    expect(await sub("sub_1")).toMatchObject({
      status: "active",
      auto_renew: 0,
      cancel_reason: "user:too_expensive",
    });
    expect(pushes.some((p) => p.msg.kind === "cancellation")).toBe(true);
    // Revoked now: expired, its last period cut, no MRR.
    const endedAt = Date.now() - 60_000;
    await webhook(
      "subscription.revoked",
      subscription({
        id: "sub_1",
        status: "canceled",
        start: renewalStart,
        endedAt,
        modified: Date.now() - 30_000,
      }),
    );
    expect(await sub("sub_1")).toMatchObject({
      status: "expired",
      auto_renew: 0,
      mrr_usd: 0,
    });
    expect((await tx("ord_s2")).expires_at).toBe(endedAt);
    // An older snapshot never overwrites a newer one.
    await webhook(
      "subscription.updated",
      subscription({
        id: "sub_1",
        status: "active",
        start: renewalStart,
        modified: cancelAt,
      }),
    );
    expect((await sub("sub_1")).status).toBe("expired");
  });

  it("converts other currencies and stores sandbox sales as Sandbox", async () => {
    await call(owner, `/api/v1/apps/${appId}/polar`, {
      method: "PUT",
      body: { sandbox: true },
    });
    await webhook(
      "order.paid",
      order({
        id: "ord_eur",
        product: PRODUCT_LIFETIME,
        net: 1000,
        currency: "eur",
        metadata: {},
      }),
    );
    const t = await tx("ord_eur");
    expect(t).toMatchObject({
      environment: "Sandbox",
      currency: "EUR",
      price_milli: 10_000,
      app_account_token: null,
    });
    expect(t.gross_usd).toBeGreaterThan(9);
    await call(owner, `/api/v1/apps/${appId}/polar`, {
      method: "PUT",
      body: { sandbox: false },
    });
  });

  it("shows Polar revenue in the apps list, overview, revenue chart and feed", async () => {
    const apps = await call(owner, "/api/v1/apps");
    const web = apps.json.items.find((a: any) => a.id === appId);
    expect(web).toMatchObject({ platform: "web", polar: { connected: true } });
    expect(web.revenue28d).toBeGreaterThan(0);
    const chart = await call(
      owner,
      `/api/v1/charts/revenue?apps=${appId}&range=90d`,
    );
    expect(chart.json.total).toBeGreaterThan(0);
    const overview = await call(owner, `/api/v1/overview?apps=${appId}`);
    expect(
      overview.json.topApps.find((a: any) => a.appId === appId)?.platform,
    ).toBe("web");
    const feed = await call(
      owner,
      `/api/v1/transactions?apps=${appId}&environment=all&limit=50`,
    );
    const row = feed.json.items.find((x: any) => x.transactionId === "ord_1");
    expect(row.store).toBe("polar");
  });

  it("creates the webhook endpoint with an access token and imports past orders", async () => {
    const created: any[] = [];
    fetchMock
      .get("https://api.polar.sh")
      .intercept({
        path: (p: string) => p.startsWith("/v1/webhooks/endpoints"),
        method: "GET",
      })
      .reply(() => ({
        statusCode: 200,
        data: JSON.stringify({
          items: [],
          pagination: { total_count: 0, max_page: 1 },
        }),
      }));
    fetchMock
      .get("https://api.polar.sh")
      .intercept({ path: "/v1/webhooks/endpoints", method: "POST" })
      .reply((opts) => {
        created.push(JSON.parse(String(opts.body)));
        return {
          statusCode: 201,
          data: JSON.stringify({ id: "whe_1", secret: SECRET }),
        };
      });
    const put = await call(owner, `/api/v1/apps/${appId}/polar`, {
      method: "PUT",
      body: { webhookSecret: null, accessToken: "polar_oat_example" },
    });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({
      connected: true,
      hasAccessToken: true,
      webhookEndpointId: "whe_1",
    });
    expect(created[0]).toMatchObject({
      url: put.json.webhookUrl,
      format: "raw",
    });
    expect(created[0].events).toContain("order.paid");

    let query = "";
    fetchMock
      .get("https://api.polar.sh")
      .intercept({
        path: (p: string) => p.startsWith("/v1/orders/"),
        method: "GET",
      })
      .reply((opts) => {
        query = String(opts.path);
        return {
          statusCode: 200,
          data: JSON.stringify({
            items: [
              order({
                id: "ord_old",
                product: PRODUCT_LIFETIME,
                net: 1500,
                created: Date.now() - 20 * DAY,
              }),
              order({
                id: "ord_1",
                product: PRODUCT_LIFETIME,
                net: 1999,
                fee: 120,
                created: FRESH,
              }),
            ],
            pagination: { total_count: 2, max_page: 1 },
          }),
        };
      });
    const sync = await call(owner, `/api/v1/apps/${appId}/polar/sync`, {
      method: "POST",
    });
    expect(sync.json).toMatchObject({ orders: 2, stored: 1 });
    expect(query).toContain(`product_id=${PRODUCT_LIFETIME}`);
    expect(await tx("ord_old")).toMatchObject({
      product_id: "full_version",
      source: "polar",
    });
    expect(
      (await call(owner, `/api/v1/apps/${appId}/polar`)).json.lastSync,
    ).toMatchObject({ orders: 2 });
  });
});

function toHeaders(h: Record<string, string>) {
  return {
    id: h["webhook-id"],
    timestamp: h["webhook-timestamp"],
    signature: h["webhook-signature"],
  };
}
