import { afterEach, describe, expect, it, vi } from "vitest";
import { quickLabel } from "../src/commands/transactions.js";
import { fmtDuration, setColor } from "../src/format.js";
import { run } from "../src/main.js";
import type { Customer, Transaction } from "../src/types.js";
import { capture, loggedInEnv, mockFetch, type Call } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const T0 = Date.UTC(2026, 9, 30, 10, 38);

const tx = (over: Partial<Transaction>): Transaction => ({
  id: "tx_1",
  appId: "app_1",
  appName: "Photo Lab",
  appIconUrl: null,
  customerId: "cus_1",
  transactionId: "1000",
  originalTransactionId: "1000",
  productId: "com.example.yearly",
  productName: "Yearly",
  kind: "new",
  purchasedAt: T0,
  expiresAt: T0 + 365 * 86_400_000,
  price: 19.99,
  storeCurrency: "USD",
  storePrice: 19.99,
  proceeds: 16.99,
  country: "TR",
  environment: "Production",
  refundedAt: null,
  offer: null,
  source: "apple",
  ...over,
});

describe("quick buyers and cancellers", () => {
  it("formats durations and quick labels at 4:59 vs 5:01", () => {
    setColor(false);
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(134_000)).toBe("2m 14s");
    expect(fmtDuration(3 * 3_600_000 + 5 * 60_000)).toBe("3h 5m");
    expect(quickLabel(tx({ sinceInstallMs: 299_000, quick: true }))).toBe("⚡ bought 4m 59s after install");
    expect(quickLabel(tx({ sinceInstallMs: 301_000 }))).toBe("");
    expect(quickLabel(tx({ kind: "cancellation", sincePurchaseMs: 299_000, purchaseKind: "trial", quick: true }))).toBe("⚡ 4m 59s after trial start");
    expect(quickLabel(tx({ kind: "cancellation", sincePurchaseMs: 301_000, purchaseKind: "new" }))).toBe("5m 1s after purchase");
  });

  it("revflare transactions --quick / --cancellations pass the filters and show the timing", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /transactions": (c: Call) =>
        c.url.searchParams.get("cancellations") === "true"
          ? { items: [tx({ id: "ev_1", kind: "cancellation", price: 0, proceeds: 0, sincePurchaseMs: 134_000, purchaseKind: "new", quick: true })], nextCursor: null, currency: "USD" }
          : { items: [tx({ sinceInstallMs: 134_000, quick: true })], nextCursor: "abc", currency: "USD" },
    });
    expect(await run(["transactions", "--quick", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[0].url.searchParams.get("quick")).toBe("true");
    expect(calls[0].url.searchParams.get("cancellations")).toBeNull();
    expect(out.stdout).toContain("⚡ bought 2m 14s after install");
    expect(out.stdout).toContain("--cursor abc --quick");
    expect(await run(["transactions", "--cancellations", "--quick", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[1].url.searchParams.get("cancellations")).toBe("true");
    expect(out.stdout).toContain("cancellation");
    expect(out.stdout).toContain("⚡ 2m 14s after purchase");
  });

  it("revflare customer shows first / last seen with the time, install and quick flags", async () => {
    const out = capture();
    const cu: Customer = {
      id: "cus_1",
      appId: "app_1",
      appName: "Photo Lab",
      country: "TR",
      firstSeenAt: T0 - 134_000,
      firstSeenSource: "install",
      firstPaidAt: T0,
      lastSeenAt: T0 + 180_000,
      lastSeenSource: "notification",
      installedAt: T0 - 134_000,
      installedAtSource: "device",
      timing: { firstPurchaseAt: T0, firstPurchaseKind: "new", installToPurchaseMs: 134_000, purchaseToCancelMs: 180_000, cancelledAt: T0 + 180_000, purchaseToRefundMs: null, refundedAt: null, quickPurchase: true, quickCancel: true },
      totalSpent: 19.99,
      totalProceeds: 16.99,
      appAccountToken: null,
      rcAppUserId: null,
      subscriptions: [],
      transactions: [tx({ sinceInstallMs: 134_000 })],
    };
    const { fetch } = mockFetch({ "GET /customers/cus_1": cu });
    expect(await run(["customer", "cus_1", "--currency", "USD", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    const local = (ms: number) => {
      const d = new Date(ms);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    expect(out.stdout).toMatch(new RegExp(`First seen\\s+${local(T0 - 134_000)} .*· app install`));
    expect(out.stdout).toMatch(new RegExp(`Last seen\\s+${local(T0 + 180_000)} .*· store notification`));
    expect(out.stdout).toMatch(/Installed\s+\d{4}-\d\d-\d\d \d\d:\d\d/);
    expect(out.stdout).toMatch(/Install→buy\s+⚡ 2m 14s/);
    expect(out.stdout).toMatch(/Buy→cancel\s+⚡ 3m/);
    expect(out.stdout).toContain("bought within 5 min of install, cancelled within 5 min of buying");
  });
});
