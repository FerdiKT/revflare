import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyOp, EMPTY_CONFIG, parseConfig, sdkPayload } from "../../worker/lib/offerings";
import { DAY, call, notification, ownerClient, type Client } from "./helpers";

const stats = () => env.DATABASE.get(env.DATABASE.idFromName("main")).stats();

let txSeq = 0;

async function newApp(owner: Client, bundleId: string) {
  const app = await call(owner, "/api/v1/apps", { body: { name: bundleId, bundleId } });
  expect(app.status).toBe(201);
  const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
  // Two known products, from sales.
  for (const p of ["monthly", "annual"]) {
    const transactionId = `${Date.now()}${++txSeq}`;
    const n = await notification("SUBSCRIBED", { bundleId, transactionId, productId: `${bundleId}.${p}`, purchaseDate: Date.now() - 60_000, expiresDate: Date.now() + 30 * DAY });
    expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
  }
  return { id: app.json.id as string, sdkKey: app.json.sdkKey as string };
}

const sdk = (key: string | null, headers: Record<string, string> = {}) => call(null, "/sdk/v1/offerings?appVersion=1.0", { headers: { ...(key ? { "x-revflare-key": key } : {}), ...headers } });

describe("offerings", { timeout: 60_000 }, () => {
  it("validates, creates, edits, keeps one current offering and serves the SDK payload", async () => {
    const owner = await ownerClient();
    const b = "com.example.offerings";
    const { id, sdkKey } = await newApp(owner, b);
    const base = `/api/v1/apps/${id}/offerings`;

    // Empty config.
    const empty = await call(owner, base);
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ currentOfferingId: null, offerings: [], placements: [], updatedAt: null });
    const s0 = await sdk(sdkKey);
    expect(s0.status).toBe(200);
    expect(s0.json).toEqual({ version: empty.json.version, currentOfferingId: null, offerings: [], placements: {} });

    // Validation errors.
    for (const bad of [
      { identifier: "has space" },
      { identifier: "x".repeat(65) },
      { identifier: ".." },
      { identifier: "ok", packages: [{ identifier: "$annual" }] },
      { identifier: "ok", packages: [{ identifier: "bad id", productId: `${b}.annual` }] },
      { identifier: "ok", packages: [{ identifier: "$annual", productId: `${b}.annual` }, { identifier: "$annual", productId: `${b}.monthly` }] },
      { identifier: "ok", metadata: [1, 2] },
      { identifier: "ok", metadata: { blob: "x".repeat(9000) } },
      { identifier: "ok", packages: Array.from({ length: 21 }, (_, i) => ({ identifier: `p${i}`, productId: `${b}.annual` })) },
    ]) {
      const r = await call(owner, base, { body: bad });
      expect(r.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
      expect(r.json.error).toBeTruthy();
    }

    // Create: the first offering becomes current; unknown products only warn.
    const created = await call(owner, base, {
      body: {
        identifier: "default",
        displayName: "Default",
        metadata: { title: "Go Pro" },
        packages: [
          { identifier: "$annual", productId: `${b}.annual`, metadata: { badge: "Best value" } },
          { identifier: "$monthly", productId: `${b}.monthly` },
        ],
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.currentOfferingId).toBe("default");
    expect(created.json.warnings).toEqual([]);
    expect(created.json.offerings[0]).toMatchObject({ identifier: "default", isCurrent: true, packages: [{ identifier: "$annual", metadata: { badge: "Best value" } }, { identifier: "$monthly", metadata: {} }] });
    expect(created.json.version).not.toBe(empty.json.version);
    expect((await call(owner, base, { body: { identifier: "default" } })).status).toBe(409);

    const sale = await call(owner, base, { body: { identifier: "sale", packages: [{ identifier: "$annual", productId: `${b}.annual_sale` }] } });
    expect(sale.status).toBe(201);
    expect(sale.json.currentOfferingId).toBe("default");
    expect(sale.json.warnings).toEqual([`Offering "sale", package "$annual": product "${b}.annual_sale" is not one of the app's known App Store products.`]);

    // Exactly one current offering.
    const cur = await call(owner, `${base}/sale/current`, { method: "POST" });
    expect(cur.status).toBe(200);
    expect(cur.json.currentOfferingId).toBe("sale");
    expect(cur.json.offerings.filter((o: { isCurrent: boolean }) => o.isCurrent).map((o: { identifier: string }) => o.identifier)).toEqual(["sale"]);
    expect((await call(owner, `${base}/nope/current`, { method: "POST" })).status).toBe(404);
    const patched = await call(owner, `${base}/default`, { method: "PATCH", body: { displayName: "Regular", isCurrent: true } });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ currentOfferingId: "default", offerings: [{ identifier: "default", displayName: "Regular", isCurrent: true }, { identifier: "sale", isCurrent: false }] });
    expect((await call(owner, `${base}/default`, { method: "PATCH", body: { packages: [{ identifier: "$x" }] } })).status).toBe(400);
    expect((await call(owner, `${base}/missing`, { method: "PATCH", body: {} })).status).toBe(404);

    // Placements: an offering or the current one; deleting an offering in use needs force.
    expect((await call(owner, `/api/v1/apps/${id}/placements/onboarding`, { method: "PUT", body: { offeringId: "sale" } })).status).toBe(201);
    expect((await call(owner, `/api/v1/apps/${id}/placements/settings`, { method: "PUT", body: { offeringId: null } })).status).toBe(201);
    expect((await call(owner, `/api/v1/apps/${id}/placements/settings`, { method: "PUT", body: { offeringId: "ghost" } })).status).toBe(404);
    expect((await call(owner, `/api/v1/apps/${id}/placements/bad%20id`, { method: "PUT", body: { offeringId: null } })).status).toBe(400);
    const blocked = await call(owner, `${base}/sale`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain('"onboarding"');

    // The SDK payload, exactly as the contract.
    const before = await call(owner, base);
    const s1 = await sdk(sdkKey);
    expect(s1.status).toBe(200);
    expect(s1.headers.get("etag")).toBe(`"${before.json.version}"`);
    expect(s1.headers.get("cache-control")).toBe("max-age=60");
    expect(s1.json).toEqual({
      version: before.json.version,
      currentOfferingId: "default",
      offerings: [
        {
          identifier: "default",
          displayName: "Regular",
          metadata: { title: "Go Pro" },
          packages: [
            { identifier: "$annual", productId: `${b}.annual`, metadata: { badge: "Best value" } },
            { identifier: "$monthly", productId: `${b}.monthly`, metadata: {} },
          ],
        },
        { identifier: "sale", displayName: "sale", metadata: {}, packages: [{ identifier: "$annual", productId: `${b}.annual_sale`, metadata: {} }] },
      ],
      placements: { onboarding: "sale", settings: null },
    });
    expect(before.json.preview).toEqual(s1.json);
    expect(Object.keys(s1.json)).toEqual(["version", "currentOfferingId", "offerings", "placements"]);
    const s304 = await sdk(sdkKey, { "if-none-match": `"${before.json.version}"` });
    expect(s304.status).toBe(304);
    expect(s304.text).toBe("");
    expect(s304.headers.get("etag")).toBe(`"${before.json.version}"`);
    expect((await sdk(sdkKey, { "if-none-match": '"stale"' })).status).toBe(200);

    // Forced delete: placements fall back to the current offering, the version changes and the SDK sees it at once.
    const forced = await call(owner, `${base}/sale?force=true`, { method: "DELETE" });
    expect(forced.status).toBe(200);
    expect(forced.json.placements).toEqual([
      { identifier: "onboarding", offeringId: null },
      { identifier: "settings", offeringId: null },
    ]);
    expect(forced.json.version).not.toBe(before.json.version);
    const s2 = await sdk(sdkKey, { "if-none-match": `"${before.json.version}"` });
    expect(s2.status).toBe(200);
    expect(s2.json.version).toBe(forced.json.version);
    expect(s2.json.placements).toEqual({ onboarding: null, settings: null });

    // Deleting the current offering leaves none current; placements can be removed.
    expect((await call(owner, `/api/v1/apps/${id}/placements/settings`, { method: "DELETE" })).status).toBe(200);
    expect((await call(owner, `/api/v1/apps/${id}/placements/settings`, { method: "DELETE" })).status).toBe(404);
    const gone = await call(owner, `${base}/default`, { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(gone.json).toMatchObject({ currentOfferingId: null, offerings: [], placements: [{ identifier: "onboarding", offeringId: null }] });
  });

  it("replaces the whole config with PUT (atomically, validated) and round-trips the GET output", async () => {
    const owner = await ownerClient();
    const b = "com.example.offerings.put";
    const { id, sdkKey } = await newApp(owner, b);
    const base = `/api/v1/apps/${id}/offerings`;
    const config = {
      currentOfferingId: "b",
      offerings: [
        { identifier: "a", displayName: "A", packages: [{ identifier: "$monthly", productId: `${b}.monthly` }] },
        { identifier: "b", displayName: "B", metadata: { theme: "dark" }, packages: [{ identifier: "$annual", productId: `${b}.annual` }, { identifier: "$lifetime", productId: `${b}.lifetime` }] },
      ],
      placements: { paywall: "a", home: null },
    };
    const put = await call(owner, base, { method: "PUT", body: config });
    expect(put.status).toBe(200);
    expect(put.json.currentOfferingId).toBe("b");
    expect(put.json.placements).toEqual([
      { identifier: "paywall", offeringId: "a" },
      { identifier: "home", offeringId: null },
    ]);
    expect(put.json.warnings).toHaveLength(1);
    expect(put.json.warnings[0]).toContain(`${b}.lifetime`);

    // Invalid configs change nothing.
    for (const bad of [
      { ...config, currentOfferingId: "zzz" },
      { ...config, placements: { paywall: "zzz" } },
      { ...config, offerings: [...config.offerings, config.offerings[0]] },
      { ...config, offerings: Array.from({ length: 51 }, (_, i) => ({ identifier: `o${i}` })) },
      { ...config, placements: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`p${i}`, null])) },
      { offerings: "nope" },
    ]) {
      expect((await call(owner, base, { method: "PUT", body: bad })).status).toBe(400);
    }
    const get = await call(owner, base);
    expect(get.json.version).toBe(put.json.version);

    // The GET output sent back is the same config (same version, timestamps kept).
    const again = await call(owner, base, { method: "PUT", body: get.json });
    expect(again.status).toBe(200);
    expect(again.json.version).toBe(get.json.version);
    expect(again.json.offerings.map((o: { updatedAt: number }) => o.updatedAt)).toEqual(get.json.offerings.map((o: { updatedAt: number }) => o.updatedAt));
    expect((await sdk(sdkKey)).json.version).toBe(get.json.version);

    // Scoped by workspace and permission: unknown app → 404.
    expect((await call(owner, "/api/v1/apps/nope/offerings")).status).toBe(404);
    expect((await call(owner, "/api/v1/apps/nope/offerings", { method: "PUT", body: config })).status).toBe(404);
  });

  it("answers 400 without a key and 404 for an unknown key", async () => {
    expect((await sdk(null)).status).toBe(400);
    expect((await sdk("rfp_unknownkey")).status).toBe(404);
  });

  it("does not read the database per SDK request", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.offerings.cost");
    await call(owner, `/api/v1/apps/${id}/offerings`, { body: { identifier: "default", packages: [{ identifier: "$annual", productId: "com.example.offerings.cost.annual" }] } });
    let before = await stats();
    expect((await sdk(sdkKey)).status).toBe(200);
    let after = await stats();
    const first = after.rowsRead - before.rowsRead;
    console.log(`sdk offerings, first call: ${first} rows read`);
    expect(first).toBeLessThanOrEqual(3);
    before = await stats();
    for (let i = 0; i < 20; i++) expect((await sdk(sdkKey)).status).toBe(200);
    after = await stats();
    expect(after.rowsRead - before.rowsRead).toBe(0);
    expect(after.rowsWritten - before.rowsWritten).toBe(0);
  });
});

describe("offerings config (unit)", () => {
  it("renames update the current offering and placements, and the version is stable", () => {
    const at = 1_000;
    const c = parseConfig({ currentOfferingId: "a", offerings: [{ identifier: "a" }], placements: [{ identifier: "p", offeringId: "a" }] }, EMPTY_CONFIG, at);
    if ("error" in c) throw new Error(c.error);
    const r = applyOp(c, { kind: "update", identifier: "a", body: { identifier: "b" } }, at);
    if ("error" in r) throw new Error(r.error);
    expect(r.config.currentOfferingId).toBe("b");
    expect(r.config.placements).toEqual([{ identifier: "p", offeringId: "b" }]);
    expect(sdkPayload(c).version).toBe(sdkPayload(c).version);
    expect(sdkPayload(c).version).not.toBe(sdkPayload(r.config).version);
    expect(sdkPayload(c).version).toMatch(/^[0-9a-f]{12}$/);
  });
});
