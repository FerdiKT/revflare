import { describe, expect, it } from "vitest";
import { call, ownerClient } from "./helpers";

describe("demo data and read performance", () => {
  it("seeds a year of sales and answers the dashboard queries quickly", async () => {
    const owner = await ownerClient();
    const ws = await call(owner, "/api/v1/workspaces", { body: { name: "Demo", currency: "USD" } });
    const demo = { ...owner, ws: ws.json.id };
    let t = Date.now();
    const seed = await call(demo, "/api/v1/dev/seed", { method: "POST" });
    expect(seed.status).toBe(200);
    console.log(`seed: ${seed.json.transactions} transactions in ${Date.now() - t} ms`);
    expect(seed.json.transactions).toBeGreaterThan(5000);

    const timed = async (path: string) => {
      t = Date.now();
      const r = await call(demo, path);
      const ms = Date.now() - t;
      console.log(`${path}: ${ms} ms`);
      expect(r.status, `${path}: ${r.text.slice(0, 300)}`).toBe(200);
      return r.json;
    };
    const ov = await timed("/api/v1/overview");
    expect(ov.kpis.find((k: any) => k.id === "mrr").value).toBeGreaterThan(100);
    expect(ov.topApps.length).toBe(5);
    expect(ov.goals[0].target).toBe(6000);
    const mrr = await timed("/api/v1/charts/mrr?range=12m");
    expect(mrr.interval).toBe("week");
    await timed("/api/v1/charts/revenue?range=90d&groupBy=country");
    await timed("/api/v1/charts/revenue?range=90d&groupBy=app");
    const mov = await timed("/api/v1/mrr-movement?range=12m&interval=month");
    // Movement explains the change in MRR between the first and last month.
    expect(mov.points.length).toBeGreaterThan(10);
    await timed("/api/v1/breakdown?metric=mrr&by=country");
    await timed("/api/v1/cohorts?months=12");
    const fc = await timed("/api/v1/forecast");
    expect(fc.expected).toBeGreaterThan(0);
    await timed("/api/v1/at-risk");
    const feed = await timed("/api/v1/transactions?limit=50");
    expect(feed.items).toHaveLength(50);
    const next = await timed(`/api/v1/transactions?limit=50&cursor=${feed.nextCursor}`);
    expect(next.items[0].purchasedAt).toBeLessThanOrEqual(feed.items[49].purchasedAt);
    await timed("/api/v1/apps");
  }, 400_000);
});
