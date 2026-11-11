import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
import type { EntitlementsChange, EntitlementsConfig } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch, reply } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Party", "com.example.party")], currency: "USD" };
const CONFIG: EntitlementsConfig = {
  entitlements: [{ identifier: "pro", productIds: ["com.example.party.monthly", "com.example.party.pass_3day"] }],
  durations: [{ productId: "com.example.party.pass_3day", unit: "day", count: 3 }],
  updatedAt: Date.UTC(2026, 9, 20),
  preview: { entitlements: { pro: ["com.example.party.monthly", "com.example.party.pass_3day"] }, products: { "com.example.party.pass_3day": { duration: { unit: "day", count: 3 } } } },
};
const CHANGE: EntitlementsChange = { ...CONFIG, warnings: ['Product "com.example.party.pass_3day" is not one of the app\'s known products.'], updatedTransactions: 2, truncated: false };

describe("entitlements", () => {
  it("lists entitlements and durations", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/entitlements": CONFIG });
    const env = loggedInEnv();
    expect(await run(["entitlements", "com.example.party", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/pro\s+com\.example\.party\.monthly, com\.example\.party\.pass_3day/);
    expect(out.stdout).toMatch(/com\.example\.party\.pass_3day\s+3 days/);
    out.stdout = "";
    expect(await run(["entitlements", "app_1", "list", "--json"], { env, fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(CONFIG);
  });

  it("set / add-product / remove-product / rm / duration call their endpoints", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "PUT /apps/app_1/entitlements/pro": CHANGE,
      "POST /apps/app_1/entitlements/pro/products": CHANGE,
      "DELETE /apps/app_1/entitlements/pro/products/com.example.party.a": CHANGE,
      "DELETE /apps/app_1/entitlements/pro/products/com.example.party.b": CHANGE,
      "DELETE /apps/app_1/entitlements/pro": { ...CHANGE, entitlements: [], warnings: [], updatedTransactions: 0 },
      "PUT /apps/app_1/durations/com.example.party.pass_3day": CHANGE,
      "DELETE /apps/app_1/durations/com.example.party.pass_3day": { ...CHANGE, durations: [] },
      "DELETE /apps/app_1/entitlements/ghost": reply(404, { error: 'No entitlement "ghost"' }),
    });
    const env = loggedInEnv();
    expect(await run(["entitlements", "app_1", "set", "pro", "com.example.party.monthly", "com.example.party.pass_3day", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!).toMatchObject({ method: "PUT", body: { productIds: ["com.example.party.monthly", "com.example.party.pass_3day"] } });
    expect(out.stdout).toContain("warning: Product");
    expect(await run(["entitlements", "app_1", "add-product", "pro", "com.example.party.pass_3day"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!).toMatchObject({ method: "POST", body: { productIds: ["com.example.party.pass_3day"] } });
    expect(await run(["entitlements", "app_1", "remove-product", "pro", "com.example.party.a", "com.example.party.b"], { env, fetch })).toBe(0);
    expect(calls.slice(-2).map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "DELETE /api/v1/apps/app_1/entitlements/pro/products/com.example.party.a",
      "DELETE /api/v1/apps/app_1/entitlements/pro/products/com.example.party.b",
    ]);
    expect(await run(["entitlements", "app_1", "rm", "pro"], { env, fetch })).toBe(0);
    out.stdout = "";
    expect(await run(["entitlements", "app_1", "duration", "com.example.party.pass_3day", "3d", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!).toMatchObject({ method: "PUT", body: { duration: "3d" } });
    expect(out.stdout).toContain("com.example.party.pass_3day: 3 days");
    expect(out.stdout).toContain("Expiry recomputed on 2 stored transactions.");
    expect(await run(["entitlements", "app_1", "duration", "com.example.party.pass_3day", "none"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(await run(["entitlements", "app_1", "rm", "ghost"], { env, fetch })).toBe(1);
    expect(out.stderr).toContain('No entitlement "ghost"');
  });

  it("rejects unknown actions and missing arguments", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS });
    const env = loggedInEnv();
    expect(await run(["entitlements", "app_1", "grant"], { env, fetch })).toBe(2);
    expect(await run(["entitlements", "app_1", "set"], { env, fetch })).toBe(2);
    expect(await run(["entitlements", "app_1", "add-product", "pro"], { env, fetch })).toBe(2);
    expect(await run(["entitlements", "app_1", "duration", "x"], { env, fetch })).toBe(2);
    expect(await run(["entitlements", "app_1", "rm"], { env, fetch })).toBe(2);
    expect(out.stderr).toContain("rm <entitlement>");
  });
});
