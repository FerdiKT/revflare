import { describe, expect, it } from "vitest";
import { AppStoreConnectApi } from "../../worker/apple/connect";
import { aggregateDownloads, aggregateReport, downloadKind } from "../../worker/apple/sales";
import type { FxCache } from "../../worker/lib/money";

// Sales and Trends reports: Apple answers 406 unless Accept is application/a-gzip, and sends gzip-compressed TSV.

async function credential() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return { id: "cred_t", workspaceId: "ws_t", kind: "appstore_connect" as const, name: "t", keyId: "ABCDEFGHIJ", issuerId: "5f0c2a7e-3b9d-4e61-9a84-2d7c1e6b0f53", config: {}, secret: { privateKey } };
}

const gzip = async (text: string) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

describe("dailySalesReport", () => {
  it("asks for application/a-gzip and parses the gzipped TSV", async () => {
    const seen: { url: string; accept: string | null }[] = [];
    const body = await gzip("Provider\tSKU\tUnits\tDeveloper Proceeds\nAPPLE\tapp.one\t3\t4.99\n");
    const api = new AppStoreConnectApi(await credential(), async (input, init) => {
      seen.push({ url: String(input), accept: new Headers(init?.headers).get("accept") });
      return new Response(body, { status: 200, headers: { "content-type": "application/a-gzip" } });
    });
    const rows = await api.dailySalesReport("12345678", "2026-10-15");
    expect(seen).toHaveLength(1);
    expect(seen[0].accept).toBe("application/a-gzip");
    expect(seen[0].url).toContain("/v1/salesReports?");
    expect(seen[0].url).toContain("filter%5BvendorNumber%5D=12345678");
    expect(rows).toEqual([{ Provider: "APPLE", SKU: "app.one", Units: "3", "Developer Proceeds": "4.99" }]);
  });

  it("returns null when Apple has no report for the day", async () => {
    const api = new AppStoreConnectApi(await credential(), async () => new Response("{}", { status: 404 }));
    expect(await api.dailySalesReport("12345678", "2026-10-16")).toBeNull();
  });

  it("does not send an Accept header on JSON requests", async () => {
    let accept: string | null = "unset";
    const api = new AppStoreConnectApi(await credential(), async (_i, init) => {
      accept = new Headers(init?.headers).get("accept");
      return Response.json({ data: [] });
    });
    await api.request("GET", "/v1/apps?limit=1");
    expect(accept).toBeNull();
  });
});

describe("aggregateReport", () => {
  const usd = { toUsd: async (amount: number) => amount } as unknown as FxCache;
  const row = (units: number, price: number, proceeds: number, extra: Record<string, string> = {}) => ({
    SKU: "app_weekly",
    "Country Code": "us",
    "Product Type Identifier": "IAY",
    Units: String(units),
    "Customer Price": String(price),
    "Developer Proceeds": String(proceeds),
    "Customer Currency": "USD",
    "Currency of Proceeds": "USD",
    ...extra,
  });

  it("keeps free trial starts out of paid units and proceeds per unit", async () => {
    const [r] = await aggregateReport(usd, "2026-10-15", [row(10, 4.99, 4.24), row(30, 0, 0, { Subscription: "New" })]);
    expect(r).toMatchObject({ country: "US", units: 10, freeUnits: 30, soldUnits: 10 });
    expect(r.proceedsUsd).toBeCloseTo(42.4);
    expect(r.customerPriceUsd).toBeCloseTo(49.9);
    expect(r.soldProceedsUsd / r.soldUnits).toBeCloseTo(4.24);
  });

  it("subtracts refunds (negative units and price, positive proceeds) from units, gross and proceeds", async () => {
    const [r] = await aggregateReport(usd, "2026-10-15", [row(5, 4.99, 4.24), row(-2, -4.99, 4.24)]);
    expect(r.units).toBe(3);
    expect(r.customerPriceUsd).toBeCloseTo(3 * 4.99);
    expect(r.proceedsUsd).toBeCloseTo(3 * 4.24);
    expect(r.soldUnits).toBe(5);
    expect(r.soldProceedsUsd / r.soldUnits).toBeCloseTo(4.24);
  });

  it("keeps product types and countries apart and skips zero-unit rows", async () => {
    const rows = await aggregateReport(usd, "2026-10-15", [row(1, 4.99, 4.24), row(2, 4.99, 4.24, { "Country Code": "DE" }), row(0, 4.99, 4.24), row(1, 0, 0, { SKU: "app", "Product Type Identifier": "1F" })]);
    expect(rows.map((r) => [r.sku, r.country, r.productType, r.units, r.freeUnits])).toEqual([
      ["app_weekly", "US", "IAY", 1, 0],
      ["app_weekly", "DE", "IAY", 2, 0],
      ["app", "US", "1F", 0, 1],
    ]);
  });
});

describe("aggregateDownloads", () => {
  const usd = { toUsd: async (amount: number) => amount } as unknown as FxCache;
  const app = (type: string, units: number, extra: Record<string, string> = {}) => ({
    SKU: "app",
    Title: "Example",
    "Apple Identifier": "1234567890",
    "Country Code": "us",
    "Product Type Identifier": type,
    Units: String(units),
    "Customer Price": "0",
    "Developer Proceeds": "0",
    "Currency of Proceeds": "USD",
    Device: "iPhone",
    ...extra,
  });

  it("maps product types to first downloads, redownloads and updates; skips in-app purchases", () => {
    expect(["1", "1F", "1T", "F1", "3", "3F", "F3", "7", "7F", "F7", "IAY", "IA1", "FI1", "1-B"].map(downloadKind)).toEqual([
      "first", "first", "first", "first", "redownload", "redownload", "redownload", "update", "update", "update", null, null, null, null,
    ]);
  });

  it("sums app rows per country, device, kind and free / paid", async () => {
    const rows = await aggregateDownloads(usd, "2026-10-15", [
      app("1F", 5),
      app("1F", 2),
      app("1F", 1, { Device: "iPad" }),
      app("1F", 3, { "Customer Price": "2.99", "Developer Proceeds": "2.54" }),
      app("3F", 4, { "Country Code": "DE" }),
      app("7F", 9, { Device: "Desktop" }),
      app("IAY", 6, { "Apple Identifier": "999" }),
      app("1F", 0),
    ]);
    const view = rows.map((r) => [r.country, r.device, r.kind, r.paid, r.units]);
    expect(view).toEqual([
      ["US", "iPhone", "first", false, 7],
      ["US", "iPad", "first", false, 1],
      ["US", "iPhone", "first", true, 3],
      ["DE", "iPhone", "redownload", false, 4],
      ["US", "Mac", "update", false, 9],
    ]);
    expect(rows[2].proceedsUsd).toBeCloseTo(3 * 2.54);
    expect(rows[0]).toMatchObject({ appleId: "1234567890", title: "Example" });
  });
});
