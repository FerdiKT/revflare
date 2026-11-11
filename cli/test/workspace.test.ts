import { afterEach, describe, expect, it, vi } from "vitest";
import { untilUtcMidnight } from "../src/errors.js";
import { run } from "../src/main.js";
import { BUDGET, QUOTA, capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const at = (h: number, m = 0) => () => new Date(Date.UTC(2026, 9, 16, h, m));

describe("Free plan quota / budget", () => {
  it("formats the time left until 00:00 UTC", () => {
    expect(untilUtcMidnight(at(20, 30)())).toBe("3h 30m");
    expect(untilUtcMidnight(at(0, 0)())).toBe("24h 00m");
    expect(untilUtcMidnight(at(23, 15)())).toBe("45m");
    expect(untilUtcMidnight(new Date(Date.UTC(2026, 9, 16, 23, 59, 59)))).toBe("less than a minute");
  });

  it("every command prints one line and exits 3 on 503 quota and 429 budget", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /overview": QUOTA, "GET /me": QUOTA, "GET /transactions": QUOTA, "POST /imports/apple": BUDGET });
    expect(await run(["overview"], { env: loggedInEnv(), fetch, now: at(20, 30) })).toBe(3);
    expect(out.stderr).toBe("error: Revflare reached today's Cloudflare Free plan database limit: requests fail until 00:00 UTC (in 3h 30m).\n");
    out.stderr = "";
    expect(await run(["import", "apple", "--json"], { env: loggedInEnv(), fetch, now: at(21) })).toBe(3);
    expect(out.stderr.trim().split("\n")).toEqual(["error: Today's database budget for imports and other background work is used up (Cloudflare Free plan): continue after 00:00 UTC (in 3h 00m)."]);
    out.stderr = "";
    expect(await run(["transactions"], { env: loggedInEnv(), fetch, now: at(21) })).toBe(3);
    expect(out.stderr).toContain("(in 3h 00m)");
  });

  it("other errors keep exit code 1; 429 without code is not a budget error", async () => {
    const out = capture();
    const { fetch } = mockFetch({});
    expect(await run(["overview"], { env: loggedInEnv(), fetch })).toBe(1);
    expect(out.stderr).toContain("no route GET /overview");
  });
});

describe("usage", () => {
  const USAGE = {
    database: { size: 52_400_000, since: Date.UTC(2026, 9, 16, 8), rowsRead: 1_234_567, rowsWritten: 8_900 },
    background: { rowsRead: 900_000, rowsWritten: 1_000, readBudget: 1_000_000, writeBudget: 20_000 },
    freePlan: { rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000, resetsAt: "00:00 UTC" },
  };
  it("shows database size, today's background budget and the Free plan limits", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /admin/usage": USAGE });
    expect(await run(["usage", "--no-color"], { env: loggedInEnv(), fetch, now: at(22) })).toBe(0);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/v1/admin/usage"]);
    expect(out.stdout).toContain("52.4 MB");
    expect(out.stdout).toMatch(/Rows read\s+900K \/ 1M \(90%\)/);
    expect(out.stdout).toMatch(/Rows written\s+1,000 \/ 20,000 \(5%\)/);
    expect(out.stdout).toMatch(/Rows read per day\s+5M/);
    expect(out.stdout).toContain("00:00 UTC (in 2h 00m)");
    out.stdout = "";
    expect(await run(["usage", "--json"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(USAGE);
  });
});

describe("invitations", () => {
  it("invite posts the role (and email) and prints the link", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "POST /invitations": { url: "https://rf.test/invite/tok123", expiresAt: Date.UTC(2026, 9, 23) } });
    expect(await run(["invite", "--role", "admin", "--email", "ana@example.com"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[0].body).toEqual({ role: "admin", email: "ana@example.com" });
    expect(out.stdout).toBe("https://rf.test/invite/tok123\n");
    expect(await run(["invite", "--role", "viewer", "--json"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[1].body).toEqual({ role: "viewer" });
    expect(JSON.parse(out.stdout.split("\n").slice(1).join("\n"))).toMatchObject({ role: "viewer", email: null, url: "https://rf.test/invite/tok123" });
    expect(await run(["invite"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(await run(["invite", "--role", "god"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(await run(["invite", "--role", "viewer", "--email", "nope"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(calls.length).toBe(2);
  });

  it("lists pending invitations and revokes them", async () => {
    const out = capture();
    const items = [{ id: "inv_1", email: null, role: "viewer", createdAt: Date.UTC(2026, 9, 15), expiresAt: Date.UTC(2026, 9, 22), createdBy: "Alex" }];
    const { fetch, calls } = mockFetch({ "GET /invitations": { items }, "DELETE /invitations/inv_1": { ok: true }, "DELETE /invitations/inv_2": { ok: true } });
    expect(await run(["invitations", "--no-color"], { env: loggedInEnv(), fetch, now: at(12) })).toBe(0);
    expect(out.stdout).toContain("inv_1");
    expect(out.stdout).toContain("anyone with the link");
    expect(out.stdout).toContain("(in 6d)");
    out.stdout = "";
    expect(await run(["invitations", "revoke", "inv_1", "inv_2"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname)).toEqual(["/api/v1/invitations/inv_1", "/api/v1/invitations/inv_2"]);
    expect(out.stdout).toContain("Revoked inv_1, inv_2");
    expect(await run(["invitations", "revoke"], { env: loggedInEnv(), fetch })).toBe(2);
  });
});

describe("transactions currency", () => {
  it("formats amounts in the response's currency without asking /me", async () => {
    const out = capture();
    const tx = { id: "t1", appId: "a1", appName: "Clock", appIconUrl: null, customerId: "c1", transactionId: "1", originalTransactionId: "1", productId: "pro", productName: "Pro", kind: "new", purchasedAt: Date.UTC(2026, 9, 16), expiresAt: null, price: 9.99, storeCurrency: "GBP", storePrice: 9.99, proceeds: 8.49, country: "GB", environment: "Production", refundedAt: null, offer: null, source: "apple" };
    const { fetch, calls } = mockFetch({ "GET /transactions": { items: [tx], nextCursor: null, currency: "GBP" } });
    expect(await run(["transactions", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/v1/transactions"]);
    expect(out.stdout).toContain("£9.99");
  });
});
