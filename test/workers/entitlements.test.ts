import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getDb } from "../../worker/lib/db";
import { addDuration, parseDuration } from "../../worker/lib/entitlement-config";
import { continuePassRecompute, recomputePassExpiry } from "../../worker/lib/entitlements";
import { DAY, call, notification, ownerClient, sessionCookie, type Client } from "./helpers";

// Server-driven entitlements and non-renewing durations (worker/lib/entitlements.ts): the API (validation, permissions,
// tenancy), the RevflareKit payload inside GET /sdk/v1/offerings (ETag, cache, cost) and the expiry of passes in the
// ledger, also when the duration is set after the sales.

const stats = () => env.DATABASE.get(env.DATABASE.idFromName("main")).stats();
const db = () => getDb(env);
let seq = 0;

async function newApp(owner: Client, bundleId: string) {
  const app = await call(owner, "/api/v1/apps", { body: { name: bundleId, bundleId } });
  expect(app.status).toBe(201);
  const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
  return { id: app.json.id as string, sdkKey: app.json.sdkKey as string, key };
}

async function sell(key: string, bundleId: string, productId: string, purchaseDate: number, type = "Non-Renewing Subscription", extra: Record<string, unknown> = {}) {
  const transactionId = `${Date.now()}${++seq}`;
  const n = await notification(type === "Auto-Renewable Subscription" ? "SUBSCRIBED" : "ONE_TIME_CHARGE", { bundleId, transactionId, productId, type, purchaseDate, price: 2990, ...extra });
  expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
  return transactionId;
}

const expiryOf = async (appId: string, transactionId: string) =>
  (await db().prepare("SELECT expires_at FROM transactions WHERE app_id = ? AND transaction_id = ?").bind(appId, transactionId).first<{ expires_at: number | null }>())?.expires_at;

const sdk = (key: string, headers: Record<string, string> = {}) => call(null, "/sdk/v1/offerings", { headers: { "x-revflare-key": key, ...headers } });

describe("entitlements", { timeout: 120_000 }, () => {
  it("edits entitlements and durations, validates, and serves them to RevflareKit with the offerings", async () => {
    const owner = await ownerClient();
    const b = "com.example.ents";
    const { id, sdkKey, key } = await newApp(owner, b);
    await sell(key, b, `${b}.monthly`, Date.now() - 60_000, "Auto-Renewable Subscription", { expiresDate: Date.now() + 30 * DAY });
    const base = `/api/v1/apps/${id}/entitlements`;

    const empty = await call(owner, base);
    expect(empty.status).toBe(200);
    expect(empty.json).toEqual({ entitlements: [], durations: [], updatedAt: null, preview: {} });
    // Old payload unchanged without entitlements (same keys, older SDKs and ETags unaffected).
    const s0 = await sdk(sdkKey);
    expect(Object.keys(s0.json)).toEqual(["version", "currentOfferingId", "offerings", "placements"]);

    // Validation.
    for (const [method, path, body] of [
      ["PUT", `${base}/bad%20name`, { productIds: ["x"] }],
      ["PUT", `${base}/pro`, { productIds: "nope" }],
      ["PUT", `${base}/pro`, { productIds: ["has space"] }],
      ["PUT", `${base}/pro`, { productIds: Array.from({ length: 101 }, (_, i) => `p${i}`) }],
      ["POST", `${base}/pro/products`, {}],
      ["PUT", base, { entitlements: { "bad id": [] } }],
      ["PUT", base, { durations: { [`${b}.pass`]: { unit: "hour", count: 3 } } }],
      ["PUT", base, { durations: { [`${b}.pass`]: { unit: "day", count: 0 } } }],
      ["PUT", base, { durations: { [`${b}.pass`]: "3x" } }],
      ["PUT", `/api/v1/apps/${id}/durations/${b}.pass`, { unit: "day", count: 1.5 }],
      ["PUT", `/api/v1/apps/${id}/durations/${b}.pass`, { count: 3 }],
    ] as const) {
      const r = await call(owner, path, { method, body });
      expect(r.status, `${method} ${path} ${JSON.stringify(body).slice(0, 60)}: ${r.text}`).toBe(400);
    }
    expect((await call(owner, `${base}/pro`, { method: "DELETE" })).status).toBe(404);
    expect((await call(owner, `${base}/pro/products/x`, { method: "DELETE" })).status).toBe(404);
    expect((await call(owner, `/api/v1/apps/${id}/durations/x`, { method: "DELETE" })).status).toBe(404);

    // Set, add, remove.
    const set = await call(owner, `${base}/pro`, { method: "PUT", body: { productIds: [`${b}.monthly`, `${b}.monthly`] } });
    expect(set.status).toBe(201);
    expect(set.json.entitlements).toEqual([{ identifier: "pro", productIds: [`${b}.monthly`] }]);
    expect(set.json.warnings).toEqual([]);
    const added = await call(owner, `${base}/pro/products`, { body: { productIds: [`${b}.pass_3day`] } });
    expect(added.status).toBe(200);
    expect(added.json.entitlements[0].productIds).toEqual([`${b}.monthly`, `${b}.pass_3day`]);
    expect(added.json.warnings).toEqual([`Product "${b}.pass_3day" is not one of the app's known products.`]);
    expect((await call(owner, `${base}/extra/products`, { body: { productId: `${b}.monthly` } })).status).toBe(201);
    expect((await call(owner, `${base}/extra/products/${b}.monthly`, { method: "DELETE" })).status).toBe(200);
    const removed = await call(owner, `${base}/extra`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(removed.json.entitlements.map((e: { identifier: string }) => e.identifier)).toEqual(["pro"]);

    // Durations: object or short form; a duration on a subscription is refused (it would end paying customers' access).
    const dur = await call(owner, `/api/v1/apps/${id}/durations/${b}.pass_3day`, { method: "PUT", body: { unit: "day", count: 3 } });
    expect(dur.status).toBe(201);
    expect(dur.json.durations).toEqual([{ productId: `${b}.pass_3day`, unit: "day", count: 3 }]);
    expect(dur.json.truncated).toBe(false);
    const sub = await call(owner, base, { method: "PUT", body: { durations: { [`${b}.pass_3day`]: "3d", [`${b}.monthly`]: { unit: "month", count: 1 } } } });
    expect(sub.status).toBe(400);
    expect(sub.json.error).toContain("auto-renewable");
    expect((await call(owner, `/api/v1/apps/${id}/durations/${b}.monthly`, { method: "PUT", body: { duration: "1m" } })).status).toBe(400);
    expect((await call(owner, base)).json.durations).toEqual([{ productId: `${b}.pass_3day`, unit: "day", count: 3 }]);

    // The SDK payload: offerings fields + entitlements + products; ETag changes, the cache forgets at once.
    const now = await call(owner, base);
    expect(now.json.preview).toEqual({ entitlements: { pro: [`${b}.monthly`, `${b}.pass_3day`] }, products: { [`${b}.pass_3day`]: { duration: { unit: "day", count: 3 } } } });
    const s1 = await sdk(sdkKey, { "if-none-match": s0.headers.get("etag")! });
    expect(s1.status).toBe(200);
    expect(s1.json).toMatchObject({ currentOfferingId: null, offerings: [], placements: {}, ...now.json.preview });
    expect(s1.json.version).not.toBe(s0.json.version);
    expect(s1.headers.get("etag")).toBe(`"${s1.json.version}"`);
    expect((await sdk(sdkKey, { "if-none-match": `"${s1.json.version}"` })).status).toBe(304);
    // The offerings view shows the same version and preview.
    const offerings = await call(owner, `/api/v1/apps/${id}/offerings`);
    expect(offerings.json.version).toBe(s1.json.version);
    expect(offerings.json.preview).toEqual(s1.json);
    // Offerings edits keep the entitlements in the payload.
    expect((await call(owner, `/api/v1/apps/${id}/offerings`, { body: { identifier: "default", packages: [{ identifier: "$pass", productId: `${b}.pass_3day` }] } })).status).toBe(201);
    const s2 = await sdk(sdkKey);
    expect(s2.json.entitlements).toEqual({ pro: [`${b}.monthly`, `${b}.pass_3day`] });
    expect(s2.json.offerings[0].packages[0].productId).toBe(`${b}.pass_3day`);
    // And the entitlements view did not move its updatedAt.
    expect((await call(owner, base)).json.updatedAt).toBe(now.json.updatedAt);
  });

  it("enforces permissions and workspaces", async () => {
    const owner = await ownerClient();
    const { id } = await newApp(owner, "com.example.ents.access");
    const base = `/api/v1/apps/${id}/entitlements`;
    expect((await call(owner, `${base}/pro`, { method: "PUT", body: { productIds: ["com.example.ents.access.pro"] } })).status).toBe(201);

    const ws = await call(owner, "/api/v1/workspaces", { body: { name: "Entitlements other", currency: "USD" } });
    const other = { ...owner, ws: ws.json.id as string };
    expect((await call(other, base)).status).toBe(404);
    expect((await call(other, `${base}/pro`, { method: "PUT", body: { productIds: ["x"] } })).status).toBe(404);
    expect((await call(other, `/api/v1/apps/${id}/durations/x`, { method: "PUT", body: { unit: "day", count: 1 } })).status).toBe(404);
    expect((await call(owner, "/api/v1/apps/nope/entitlements")).status).toBe(404);

    const inv = await call(owner, "/api/v1/invitations", { body: { role: "viewer" } });
    const token = inv.json.url.split("/invite/")[1];
    const acc = await call(null, "/api/v1/auth/invitations/accept", { body: { token, name: "Ents viewer", email: `ents-viewer-${owner.workspaceId}@rf.test`, password: "password123" } });
    expect(acc.status, acc.text).toBe(200);
    const viewer = { cookie: sessionCookie(acc.headers), ws: owner.workspaceId };
    expect((await call(viewer, base)).status).toBe(200);
    expect((await call(viewer, base, { method: "PUT", body: { entitlements: {} } })).status).toBe(403);
    expect((await call(viewer, `${base}/pro`, { method: "DELETE" })).status).toBe(403);
    expect((await call(viewer, `${base}/pro/products`, { body: { productId: "x" } })).status).toBe(403);
    expect((await call(viewer, `/api/v1/apps/${id}/durations/x`, { method: "PUT", body: { unit: "day", count: 1 } })).status).toBe(403);
    expect((await call(owner, base)).json.entitlements).toEqual([{ identifier: "pro", productIds: ["com.example.ents.access.pro"] }]);
  });

  it("gives non-renewing transactions an expiry from the duration, also retroactively, without MRR", async () => {
    const owner = await ownerClient();
    const b = "com.example.ents.ledger";
    const { id, key } = await newApp(owner, b);
    const pass = `${b}.pass_3day`;
    const t1 = Date.now() - 10 * DAY;
    const before = await sell(key, b, pass, t1);
    expect(await expiryOf(id, before)).toBeNull();

    // Set later: stored passes are recomputed (and only those of the product).
    const other = await sell(key, b, `${b}.lifetime`, t1, "Non-Consumable");
    const r = await call(owner, `/api/v1/apps/${id}/durations/${pass}`, { method: "PUT", body: { duration: "3d" } });
    expect(r.status).toBe(201);
    expect(r.json.updatedTransactions).toBe(1);
    expect(await expiryOf(id, before)).toBe(t1 + 3 * DAY);
    expect(await expiryOf(id, other)).toBeNull();

    // New sales get it at once (Apple gives no expiry); refunds keep it.
    const t2 = Date.now() - DAY;
    const after = await sell(key, b, pass, t2);
    expect(await expiryOf(id, after)).toBe(t2 + 3 * DAY);
    const n = await notification("REFUND", { bundleId: b, transactionId: after, productId: pass, type: "Non-Renewing Subscription", purchaseDate: t2, price: 2990, revocationDate: Date.now(), revocationReason: 0 });
    expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    expect(await expiryOf(id, after)).toBe(t2 + 3 * DAY);

    // Changing the duration recomputes both; the same duration again writes nothing; removing clears it.
    const week = await call(owner, `/api/v1/apps/${id}/durations/${pass}`, { method: "PUT", body: { unit: "week", count: 1 } });
    expect(week.json.updatedTransactions).toBe(2);
    expect(await expiryOf(id, before)).toBe(t1 + 7 * DAY);
    expect((await call(owner, `/api/v1/apps/${id}/durations/${pass}`, { method: "PUT", body: { unit: "week", count: 1 } })).json.updatedTransactions).toBe(0);
    const gone = await call(owner, `/api/v1/apps/${id}/durations/${pass}`, { method: "DELETE" });
    expect(gone.json.updatedTransactions).toBe(2);
    expect(await expiryOf(id, before)).toBeNull();
    await call(owner, `/api/v1/apps/${id}/durations/${pass}`, { method: "PUT", body: { unit: "day", count: 3 } });

    // The customer history shows the pass's expiry; passes are one-time revenue, never MRR / active subscriptions.
    const customerId = (await db().prepare("SELECT customer_id FROM transactions WHERE app_id = ? AND transaction_id = ?").bind(id, before).first<{ customer_id: string }>())!.customer_id;
    const c = await call(owner, `/api/v1/customers/${customerId}`);
    expect(c.status).toBe(200);
    expect(c.json.transactions[0].expiresAt).toBe(t1 + 3 * DAY);
    expect(c.json.subscriptions).toEqual([]);
    const mrr = await db().prepare("SELECT COALESCE(MAX(mrr_usd), 0) AS m, COALESCE(MAX(active_subscriptions), 0) AS a FROM daily_metrics WHERE app_id = ?").bind(id).first<{ m: number; a: number }>();
    expect(mrr).toEqual({ m: 0, a: 0 });
  });

  it("is readable and editable through MCP", async () => {
    const owner = await ownerClient();
    const { id } = await newApp(owner, "com.example.ents.mcp");
    const key = await call(owner, "/api/v1/api-keys", { body: { name: "mcp-ents" } });
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const r = await call({ token: key.json.token }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
      const text = r.json.result.content[0].text as string;
      return { isError: r.json.result.isError, data: r.json.result.isError ? text : JSON.parse(text) };
    };
    expect((await mcp("set_entitlements", { app: id, action: "set", entitlement: "pro", productIds: ["com.example.ents.mcp.a"] })).data.entitlements).toEqual([{ identifier: "pro", productIds: ["com.example.ents.mcp.a"] }]);
    await mcp("set_entitlements", { app: id, action: "add_products", entitlement: "pro", productIds: ["com.example.ents.mcp.pass"] });
    await mcp("set_entitlements", { app: id, action: "set_duration", productId: "com.example.ents.mcp.pass", unit: "month", count: 1 });
    await mcp("set_entitlements", { app: id, action: "remove_products", entitlement: "pro", productIds: ["com.example.ents.mcp.a"] });
    const got = await mcp("get_entitlements", { app: id });
    expect(got.data).toMatchObject({
      entitlements: [{ identifier: "pro", productIds: ["com.example.ents.mcp.pass"] }],
      durations: [{ productId: "com.example.ents.mcp.pass", unit: "month", count: 1 }],
    });
    expect((await mcp("set_entitlements", { app: id, action: "set_duration", productId: "com.example.ents.mcp.pass", unit: "hour", count: 1 })).isError).toBe(true);
    // set without productIds is an error, never an emptied entitlement.
    const missing = await mcp("set_entitlements", { app: id, action: "set", entitlement: "pro" });
    expect(missing.isError).toBe(true);
    expect(missing.data).toContain("productIds is required");
    expect((await mcp("get_entitlements", { app: id })).data.entitlements).toEqual([{ identifier: "pro", productIds: ["com.example.ents.mcp.pass"] }]);
  });

  it("never gives a duration to a non-consumable (lifetime) product", async () => {
    const owner = await ownerClient();
    const b = "com.example.ents.lifetime";
    const { id, key } = await newApp(owner, b);
    const lifetime = `${b}.lifetime`;
    const t1 = Date.now() - 10 * DAY;
    const sold = await sell(key, b, lifetime, t1, "Non-Consumable");
    // Known as non-consumable (catalog + stored sales): refused, nothing stored, no expiry written.
    for (const [method, path, body] of [
      ["PUT", `/api/v1/apps/${id}/durations/${lifetime}`, { duration: "3d" }],
      ["PUT", `/api/v1/apps/${id}/entitlements`, { durations: { [lifetime]: "1m" } }],
    ] as const) {
      const r = await call(owner, path, { method, body });
      expect(r.status, r.text).toBe(400);
      expect(r.json.error).toContain("non-consumable");
    }
    expect((await call(owner, `/api/v1/apps/${id}/entitlements`)).json.durations).toEqual([]);
    expect(await expiryOf(id, sold)).toBeNull();
    // Known only from a stored transaction (catalog type missing): still refused.
    await db().prepare("UPDATE products SET type = NULL WHERE app_id = ? AND product_id = ?").bind(id, lifetime).run();
    expect((await call(owner, `/api/v1/apps/${id}/durations/${lifetime}`, { method: "PUT", body: { duration: "3d" } })).status).toBe(400);
    // A duration stored before (older server) never reaches non-consumable sales in the ledger.
    await db().prepare("UPDATE products SET type = 'non_consumable' WHERE app_id = ? AND product_id = ?").bind(id, lifetime).run();
    await db()
      .prepare("INSERT INTO offering_configs (app_id, config, sdk_json, version, updated_at, entitlements) VALUES (?, ?, '{}', 'x', ?, ?) ON CONFLICT(app_id) DO UPDATE SET entitlements = excluded.entitlements")
      .bind(id, JSON.stringify({ currentOfferingId: null, offerings: [], placements: [] }), Date.now(), JSON.stringify({ entitlements: {}, durations: { [lifetime]: { unit: "day", count: 3 } } }))
      .run();
    const later = await sell(key, b, lifetime, Date.now() - DAY, "Non-Consumable");
    expect(await expiryOf(id, later)).toBeNull();
    // Removing it is allowed.
    const gone = await call(owner, `/api/v1/apps/${id}/durations/${lifetime}`, { method: "DELETE" });
    expect(gone.status, gone.text).toBe(200);
    expect(await expiryOf(id, sold)).toBeNull();
  });

  it("recomputes day / week in one statement and month / year in bounded batches continued by the cron", async () => {
    const owner = await ownerClient();
    const b = "com.example.ents.batch";
    const { id, key } = await newApp(owner, b);
    const pass = `${b}.pass`;
    const times = [30, 20, 10, 5, 1].map((d) => Date.now() - d * DAY);
    const sold: string[] = [];
    for (const t of times) sold.push(await sell(key, b, pass, t));
    const expiries = async () => Promise.all(sold.map((tx) => expiryOf(id, tx)));

    // Week: one UPDATE for every row (no per-row writes).
    const week = await call(owner, `/api/v1/apps/${id}/durations/${pass}`, { method: "PUT", body: { duration: "2w" } });
    expect(week.json).toMatchObject({ updatedTransactions: 5, truncated: false });
    expect(await expiries()).toEqual(times.map((t) => t + 14 * DAY));

    // Month in batches of 2: 3 steps, each writes only its rows, `next` continues.
    const month = { unit: "month", count: 1 } as const;
    let step = await recomputePassExpiry(db(), id, pass, month, 0, 2);
    expect(step.changed).toBe(2);
    expect(step.next).not.toBeNull();
    step = await recomputePassExpiry(db(), id, pass, month, step.next!, 2);
    expect(step.changed).toBe(2);
    const last = await recomputePassExpiry(db(), id, pass, month, step.next!, 2);
    expect(last).toEqual({ changed: 1, next: null });
    expect(await expiries()).toEqual(times.map((t) => addDuration(t, month)));

    // The cron continues a pending recompute with the product's current duration, then forgets it.
    await call(owner, `/api/v1/apps/${id}/durations/${pass}`, { method: "PUT", body: { duration: "1y" } });
    await db().prepare("UPDATE transactions SET expires_at = NULL WHERE app_id = ? AND product_id = ?").bind(id, pass).run();
    await db()
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .bind(`pass_recompute:${id}:${pass}`, JSON.stringify({ appId: id, productId: pass, after: 0 }))
      .run();
    const cont = await continuePassRecompute(db(), env);
    expect(cont).toMatchObject({ appId: id, productId: pass, changed: 5, done: true });
    expect(await expiries()).toEqual(times.map((t) => addDuration(t, { unit: "year", count: 1 })));
    expect(await continuePassRecompute(db(), env)).toBeNull();

    // Removing: one UPDATE clears them all.
    const gone = await call(owner, `/api/v1/apps/${id}/durations/${pass}`, { method: "DELETE" });
    expect(gone.json).toMatchObject({ updatedTransactions: 5, truncated: false });
    expect(await expiries()).toEqual(times.map(() => null));
  });

  it("serves the SDK payload from the cache", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.ents.cost");
    await call(owner, `/api/v1/apps/${id}/entitlements`, { method: "PUT", body: { entitlements: { pro: ["com.example.ents.cost.pass"] }, durations: { "com.example.ents.cost.pass": "1w" } } });
    let s = await stats();
    expect((await sdk(sdkKey)).status).toBe(200);
    let a = await stats();
    expect(a.rowsRead - s.rowsRead).toBeLessThanOrEqual(3);
    s = await stats();
    for (let i = 0; i < 20; i++) expect((await sdk(sdkKey)).json.products).toEqual({ "com.example.ents.cost.pass": { duration: { unit: "week", count: 1 } } });
    a = await stats();
    expect(a.rowsRead - s.rowsRead).toBe(0);
    expect(a.rowsWritten - s.rowsWritten).toBe(0);
  });
});

describe("durations (unit)", () => {
  it("parses and adds durations on the UTC calendar, clamping months", () => {
    expect(parseDuration("3d")).toEqual({ unit: "day", count: 3 });
    expect(parseDuration("2 weeks")).toEqual({ unit: "week", count: 2 });
    expect(parseDuration({ unit: "Months", count: 6 })).toEqual({ unit: "month", count: 6 });
    expect(parseDuration("1y")).toEqual({ unit: "year", count: 1 });
    expect("error" in parseDuration("0d")).toBe(true);
    expect("error" in parseDuration({ unit: "day", count: 1001 })).toBe(true);
    const t = Date.UTC(2026, 0, 31, 10, 30);
    expect(addDuration(t, { unit: "day", count: 3 })).toBe(t + 3 * DAY);
    expect(addDuration(t, { unit: "week", count: 2 })).toBe(t + 14 * DAY);
    expect(addDuration(t, { unit: "month", count: 1 })).toBe(Date.UTC(2026, 1, 28, 10, 30));
    expect(addDuration(Date.UTC(2028, 0, 31), { unit: "month", count: 1 })).toBe(Date.UTC(2028, 1, 29));
    expect(addDuration(t, { unit: "month", count: 13 })).toBe(Date.UTC(2027, 1, 28, 10, 30));
    expect(addDuration(Date.UTC(2028, 1, 29), { unit: "year", count: 1 })).toBe(Date.UTC(2029, 1, 28));
  });
});
