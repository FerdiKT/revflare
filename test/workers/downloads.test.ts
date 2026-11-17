import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DAY, call, ownerClient } from "./helpers";

// App Store downloads (downloads_daily rows from Sales and Trends; synthetic data) and conversions from Revflare's data.

const day = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const dbExec = (sql: string, params: (string | number | null)[] = []) => env.DATABASE.get(env.DATABASE.idFromName("main")).exec([{ sql, params, mode: "run" }], false);

describe("GET /downloads", () => {
  it("serves days, apps with windows, countries, devices and conversions; preset ranges end at the newest report day", { timeout: 60_000 }, async () => {
    const owner = await ownerClient();
    const app = await call(owner, "/api/v1/apps", { body: { name: "Downloaded", bundleId: "com.example.downloaded", appleAppId: "5550001111" } });
    const appId = app.json.id as string;
    const ws = owner.workspaceId;
    const empty = await call(owner, `/api/v1/downloads?apps=${appId}&range=7d`);
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ firstDay: null, lastDay: null, apps: [] });

    const insert = (d: string, country: string, device: string, kind: string, paid: number, units: number) =>
      dbExec(
        "INSERT INTO downloads_daily (workspace_id, day, apple_id, app_id, title, country, device, kind, paid, units, proceeds_usd) VALUES (?, ?, '5550001111', ?, 'Downloaded', ?, ?, ?, ?, ?, 0)",
        [ws, d, appId, country, device, kind, paid, units],
      );
    // Newest report: 2 days ago. Last 7 report days (2..8 days ago): 10 a day in the US, 2 in DE on iPad, 1 paid.
    for (let i = 2; i <= 8; i++) {
      await insert(day(i), "US", "iPhone", "first", 0, 10);
      await insert(day(i), "DE", "iPad", "first", 0, 2);
      await insert(day(i), "US", "iPhone", "update", 0, 30);
    }
    await insert(day(2), "US", "iPhone", "first", 1, 1);
    await insert(day(3), "US", "iPhone", "redownload", 0, 4);
    // The 7 days before: 5 a day.
    for (let i = 9; i <= 15; i++) await insert(day(i), "US", "iPhone", "first", 0, 5);
    // Revflare's own data: trials and revenue on the newest report day.
    await dbExec("INSERT INTO daily_metrics (app_id, day, workspace_id, gross_usd, proceeds_usd, trials_started) VALUES (?, ?, ?, 17, 14, 8)", [appId, day(2), ws]);
    await dbExec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`data_version:${ws}`, String(Date.now())]);

    const r = await call(owner, `/api/v1/downloads?apps=${appId}&range=7d&currency=USD`);
    expect(r.status).toBe(200);
    const d = r.json;
    expect(d).toMatchObject({ from: day(8), to: day(2), lastDay: day(2), firstDay: day(15) });
    expect(d.totals).toMatchObject({ downloads: 85, paidDownloads: 1, redownloads: 4, updates: 210, trialsStarted: 8, revenue: 17 });
    expect(d.totals.downloadToTrial).toBeCloseTo(8 / 85, 3);
    expect(d.totals.revenuePerDownload).toBeCloseTo(0.2, 2);
    expect(d.previous.downloads).toBe(35);
    expect(d.days).toHaveLength(7);
    expect(d.days[6]).toMatchObject({ day: day(2), downloads: 13, paidDownloads: 1, trialsStarted: 8 });
    expect(d.apps).toHaveLength(1);
    expect(d.apps[0]).toMatchObject({ appId, appleId: "5550001111", name: "Downloaded", downloads: 85, previousDownloads: 35 });
    expect(d.apps[0].windows[0]).toMatchObject({ days: 7, downloads: 85, previous: 35 });
    expect(d.apps[0].windows[0].change).toBeCloseTo(85 / 35 - 1, 3);
    expect(d.windows.map((w: { days: number }) => w.days)).toEqual([7, 28, 90]);
    expect(d.countries.map((c: { country: string; downloads: number }) => [c.country, c.downloads])).toEqual([
      ["US", 71],
      ["DE", 14],
    ]);
    expect(d.devices.map((c: { device: string; downloads: number }) => [c.device, c.downloads])).toEqual([
      ["iPhone", 71],
      ["iPad", 14],
    ]);

    // An explicit end keeps the range as given.
    const fixed = await call(owner, `/api/v1/downloads?apps=${appId}&from=${day(4)}&to=${day(0)}`);
    expect(fixed.json).toMatchObject({ from: day(4), to: day(0) });
    expect(fixed.json.totals.downloads).toBe(3 * 12 + 1);
  });
});
