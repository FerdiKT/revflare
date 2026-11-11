import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DAY, ORIGIN, call, notification, ownerClient, type TxOptions } from "./helpers";

// In TEST_MODE an attribution token "test:<json>" resolves to <json> instead of calling Apple.
const token = (json: object) => `test:${JSON.stringify(json)}`;
const dbExec = (sql: string, params: (string | number)[] = []) => env.DATABASE.get(env.DATABASE.idFromName("main")).exec([{ sql, params, mode: "run" }], false);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const H = 3_600_000;

const A = "a1111111-1111-4111-8111-111111111111"; // Apple Ads 501/601/701, US
const B = "b2222222-2222-4222-8222-222222222222"; // Apple Ads 501/602, DE
const C = "c3333333-3333-4333-8333-333333333333"; // organic, reported from FR
const D = "d4444444-4444-4444-8444-444444444444"; // organic, no country, a user from before the install (pre-existing)
const E = "e5555555-5555-4555-8555-555555555555"; // Apple Ads 502, 10 days old

describe("LTV by acquisition source", () => {
  it("values install cohorts per source, campaign, ad group, keyword and country at each horizon", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.ltv";
    const app = await call(owner, "/api/v1/apps", { body: { name: "LTV", bundleId } });
    const appId = app.json.id as string;
    const sdkKey = app.json.sdkKey as string;
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const post = async (type: string, tx: TxOptions, opts: { subtype?: string } = {}) =>
      expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: (await notification(type, tx, opts)).signedPayload } })).status).toBe(200);
    const report = async (body: object, country?: string) => {
      const res = await SELF.fetch(`${ORIGIN}/sdk/v1/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdkKey, ...body }),
        ...(country ? { cf: { country } } : {}),
      } as RequestInit);
      expect(res.status).toBe(200);
    };

    await report({ installId: A, attributionToken: token({ attribution: true, campaignId: 501, adGroupId: 601, keywordId: 701, countryOrRegion: "US" }) }, "GB");
    await report({ installId: B, attributionToken: token({ attribution: true, campaignId: 501, adGroupId: 602, countryOrRegion: "DE" }) });
    await report({ installId: C, attributionToken: token({ attribution: false }) }, "FR");
    await report({ installId: D });
    await report({ installId: E, attributionToken: token({ attribution: true, campaignId: 502, adGroupId: 603 }) });
    const cf = await env.DATABASE.get(env.DATABASE.idFromName("main")).exec(
      [{ sql: "SELECT install_id, country, install_country FROM attributions WHERE app_id = ? ORDER BY install_id", params: [appId], mode: "all" }],
      false,
    ) as unknown as { results: unknown[] }[];
    const countries = (cf[0].results as { install_id: string; country: string | null; install_country: string | null }[]).map((r) => [r.install_id[0], r.country, r.install_country]);
    // Apple's country stays on attributed installs; the request's country is kept apart (miniflare passes `cf`).
    expect(countries).toEqual([
      ["a", "US", "GB"],
      ["b", "DE", null],
      ["c", null, "FR"],
      ["d", null, null],
      ["e", null, null],
    ]);

    // Four installs 200 days ago (same week), one 10 days ago.
    const T = Date.now() - 200 * DAY;
    const TE = Date.now() - 10 * DAY;
    await dbExec("UPDATE attributions SET created_at = ? WHERE app_id = ? AND install_id IN (?, ?, ?, ?)", [T, appId, A, B, C, D]);
    await dbExec("UPDATE attributions SET created_at = ? WHERE app_id = ? AND install_id = ?", [TE, appId, E]);

    // A: $10 a month from install + 1 h, renewals at +31, +62, +93 and +185 days.
    const sub = (id: string, at: number, renewal: boolean, price = 10000) =>
      post(renewal ? "DID_RENEW" : "SUBSCRIBED", { bundleId, transactionId: id, originalTransactionId: "7100", purchaseDate: at, expiresDate: at + 31 * DAY, price, transactionReason: renewal ? "RENEWAL" : "PURCHASE" });
    await sub("7100", T + H, false);
    for (const [i, d] of [31, 62, 93, 185].entries()) await sub(`710${i + 1}`, T + d * DAY + H, true);
    // B: $20 at +2 days, 40 % refunded (prorated); $5 at +10 days, fully refunded.
    const b1: TxOptions = { bundleId, transactionId: "7200", productId: "pack", type: "Consumable", purchaseDate: T + 2 * DAY, price: 20000 };
    const b2: TxOptions = { bundleId, transactionId: "7201", productId: "pack", type: "Consumable", purchaseDate: T + 10 * DAY, price: 5000 };
    await post("ONE_TIME_CHARGE", b1);
    await post("ONE_TIME_CHARGE", b2);
    await post("REFUND", { ...b1, revocationDate: T + 5 * DAY, revocationReason: 0, revocationPercentage: 40000, revocationType: "REFUND_PRORATED" });
    await post("REFUND", { ...b2, revocationDate: T + 12 * DAY, revocationReason: 1, revocationPercentage: 100000, revocationType: "REFUND_FULL" });
    // C: a free trial at install, converts to $30 at +8 days.
    await post("SUBSCRIBED", { bundleId, transactionId: "7300", purchaseDate: T + H / 2, expiresDate: T + 8 * DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL", productId: "yearly" });
    await post("DID_RENEW", { bundleId, transactionId: "7301", originalTransactionId: "7300", purchaseDate: T + 8 * DAY, expiresDate: T + 373 * DAY, price: 30000, productId: "yearly", transactionReason: "RENEWAL" });
    // D: a purchase from 3 days before the install (beyond the 48-hour grace: an earlier install of the same user): D is
    // a pre-existing user, left out of installs and values.
    await post("ONE_TIME_CHARGE", { bundleId, transactionId: "7400", productId: "unlock", type: "Non-Consumable", purchaseDate: T - 3 * DAY, price: 7000 });
    // E: $10 an hour after its install.
    await post("ONE_TIME_CHARGE", { bundleId, transactionId: "7500", productId: "unlock", type: "Non-Consumable", purchaseDate: TE + H, price: 10000 });
    // A paying customer no install reported (coverage).
    await post("ONE_TIME_CHARGE", { bundleId, transactionId: "7600", productId: "unlock", type: "Non-Consumable", purchaseDate: Date.now() - 5 * DAY, price: 10000 });
    await report({ installId: A, originalTransactionIds: ["7100"] });
    await report({ installId: B, originalTransactionIds: ["7200", "7201"] });
    await report({ installId: C, originalTransactionIds: ["7300"] });
    await report({ installId: D, originalTransactionIds: ["7400"] });
    await report({ installId: E, originalTransactionIds: ["7500"] });

    const from = dayOf(T - 7 * DAY);
    const q = (path: string, extra = "") => call(owner, `/api/v1${path}?apps=${appId}&from=${from}&currency=USD${extra}`);
    const r = await q("/ltv", "&by=source");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ currency: "USD", by: "source", cohort: "week", horizons: [0, 7, 30, 90, 180] });
    expect(new Date(`${r.json.from}T00:00:00Z`).getUTCDay()).toBe(1); // weeks start on Monday
    const at = (row: any) => row.horizons.map((h: any) => h.revenuePerInstall);
    const rows = r.json.rows as any[];
    expect(rows).toHaveLength(3);
    const [recent, ...old] = rows; // newest cohort first
    expect(recent).toMatchObject({ group: "apple_ads", installs: 1, payers: 1, revenue: 10 });
    expect(recent.horizons[0]).toMatchObject({ day: 0, immature: false, revenuePerInstall: 10, payers: 1 });
    expect(recent.horizons[2]).toEqual({ day: 30, immature: true, revenuePerInstall: null, proceedsPerInstall: null, payers: null });
    expect(recent.horizons[5]).toMatchObject({ day: null, immature: false, revenuePerInstall: 10 });
    const ads = old.find((x) => x.group === "apple_ads")!;
    const organic = old.find((x) => x.group === "organic")!;
    expect(ads.cohort).toBe(organic.cohort);
    expect(ads).toMatchObject({ installs: 2, payers: 2, trials: 0, revenue: 62, campaignId: null });
    // A: 10 (D0) … 40 (D180), 50 to date; B: 12 kept of the prorated $20 from D7, the refunded $5 never counts.
    expect(at(ads)).toEqual([5, 11, 11, 21, 26, 31]);
    expect(ads.horizons.map((h: any) => h.payers)).toEqual([1, 2, 2, 2, 2, 2]);
    expect(ads.horizons.every((h: any) => !h.immature)).toBe(true);
    const ratio = ads.horizons[0].proceedsPerInstall / ads.horizons[0].revenuePerInstall;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(1);
    expect(ads.horizons[5].proceedsPerInstall).toBeCloseTo(31 * ratio, 2);
    // C pays $30 on day 8; D (pre-existing) is not an install.
    expect(organic).toMatchObject({ installs: 1, payers: 1, trials: 1, revenue: 30 });
    expect(at(organic)).toEqual([0, 0, 30, 30, 30, 30]);
    expect(organic.horizons.map((h: any) => h.payers)).toEqual([0, 0, 1, 1, 1, 1]);

    // Coverage: paying customers A, B (two one-time purchases: two customers), C, D, E and the one no install reported;
    // D's only purchase predates its install (not linked), the unreported one has no install.
    expect(r.json.coverage).toEqual({ installs: 4, attributed: 3, preexisting: 1, payingCustomers: 7, linkedCustomers: 5, share: 0.7143 });

    // Campaign / ad group / keyword: organic installs stay one group.
    const byKeyword = (await q("/ltv", "&by=keyword&cohort=month")).json;
    expect(byKeyword.cohort).toBe("month");
    expect(byKeyword.from.endsWith("-01")).toBe(true);
    const groups = (byKeyword.rows as any[]).map((x) => [x.group, x.campaignId, x.adGroupId, x.keywordId, x.installs]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(groups).toEqual([
      ["501/601/701", "501", "601", "701", 1],
      ["501/602/none", "501", "602", null, 1],
      ["502/603/none", "502", "603", null, 1],
      ["organic", null, null, null, 1],
    ]);
    const byCampaign = (await q("/ltv", "&by=campaign")).json.rows as any[];
    expect(byCampaign.find((x) => x.group === "501")).toMatchObject({ campaignId: "501", adGroupId: null, installs: 2, revenue: 62 });
    // Country: Apple's country, else the country of the install's first report.
    const byCountry = (await q("/ltv", "&by=country")).json.rows as any[];
    expect(byCountry.filter((x) => x.installs && x.cohort === ads.cohort).map((x) => [x.group, x.country, x.revenue]).sort()).toEqual([
      ["DE", "DE", 12],
      ["FR", "FR", 30],
      ["US", "US", 50],
    ]);

    // Summary (Adsflare): pooled over the install days old enough for each horizon.
    const s = await q("/ltv/summary", "&by=campaign");
    expect(s.status).toBe(200);
    const c501 = (s.json.rows as any[]).find((x) => x.group === "501");
    expect(c501).toMatchObject({ installs: 2, payers: 2, conversion: 1, revenue: 62 });
    expect(c501.horizons.find((h: any) => h.day === 30)).toMatchObject({ installs: 2, revenuePerInstall: 11, payers: 2, immature: false });
    const c502 = (s.json.rows as any[]).find((x) => x.group === "502");
    expect(c502.horizons.find((h: any) => h.day === 7)).toMatchObject({ installs: 1, revenuePerInstall: 10, immature: false });
    expect(c502.horizons.find((h: any) => h.day === 30)).toEqual({ day: 30, immature: true, installs: 0, revenuePerInstall: null, proceedsPerInstall: null, payers: null });
    const organicSummary = (s.json.rows as any[]).find((x) => x.group === "organic");
    expect(organicSummary).toMatchObject({ installs: 1, payers: 1, conversion: 1 });
    // summary=1: the same summary rows with the cohorts, for the installs of the cohorts' range (one request).
    const both = (await q("/ltv", "&by=campaign&summary=1")).json;
    expect(both.from <= s.json.from).toBe(true);
    expect((both.summary as any[]).find((x) => x.group === "501")).toEqual(c501);
    expect(byCampaign.length).toBe(both.rows.length);
    expect((await q("/ltv", "&by=campaign")).json.summary).toBeUndefined();
    // No app matches the App Store ids: empty, not every app.
    const none = await call(owner, `/api/v1/ltv/summary?appleAppIds=1&from=${from}`);
    expect(none.json).toMatchObject({ rows: [], coverage: { installs: 0, preexisting: 0, payingCustomers: 0, share: null } });
    // Default range 90 days: only E is in it.
    const recentSummary = await call(owner, `/api/v1/ltv/summary?apps=${appId}`);
    expect((recentSummary.json.rows as any[]).map((x) => x.group)).toEqual(["502"]);

    // Validation.
    expect((await q("/ltv", "&by=placement")).status).toBe(400);
    expect((await q("/ltv", "&cohort=year")).status).toBe(400);
  }, 120_000);

  it("uses the SDK's install time, a 48-hour grace and leaves pre-existing users out", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.ltv.time";
    const app = await call(owner, "/api/v1/apps", { body: { name: "LTV time", bundleId } });
    const appId = app.json.id as string;
    const sdkKey = app.json.sdkKey as string;
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const buy = async (transactionId: string, purchaseDate: number, price: number) =>
      expect(
        (await call(null, `/apple/notifications/${key}`, { body: { signedPayload: (await notification("ONE_TIME_CHARGE", { bundleId, transactionId, productId: "pack", type: "Consumable", purchaseDate, price })).signedPayload } })).status,
      ).toBe(200);
    const report = async (body: object) => expect((await call(null, "/sdk/v1/report", { body: { sdkKey, ...body } })).status).toBe(200);
    const F = "f6666666-6666-4666-8666-666666666666"; // first report 30 h after a purchase (offline first launch, older SDK)
    const G = "a7777777-7777-4777-8777-777777777777"; // RevflareKit 1.5.1: installed 3 days before its first report
    const N = "b8888888-8888-4888-8888-888888888888"; // never paid
    const P = "c9999999-9999-4999-8999-999999999999"; // paid 5 days before its install: pre-existing
    const X = "dabababa-baba-4aba-8aba-bababababab0"; // an install time 40 days before the report is not believed

    const now = Date.now();
    const T2 = now - 40 * DAY;
    const TG = now - 3 * DAY;
    await report({ installId: G, installedAt: TG });
    await report({ installId: X, installedAt: now - 40 * DAY });
    for (const id of [F, N, P]) await report({ installId: id });
    await dbExec("UPDATE attributions SET created_at = ? WHERE app_id = ? AND install_id IN (?, ?, ?)", [T2, appId, F, N, P]);
    // A later report never moves a known install time.
    await report({ installId: G, installedAt: TG - DAY });
    const rows = (await env.DATABASE.get(env.DATABASE.idFromName("main")).exec(
      [{ sql: "SELECT install_id, installed_at FROM attributions WHERE app_id = ? AND install_id IN (?, ?) ORDER BY install_id", params: [appId, G, X], mode: "all" }],
      false,
    )) as unknown as { results: { install_id: string; installed_at: number | null }[] }[];
    expect(rows[0].results.map((r) => [r.install_id, r.installed_at])).toEqual([
      [G, TG],
      [X, null],
    ]);
    await dbExec("DELETE FROM attributions WHERE app_id = ? AND install_id = ?", [appId, X]);

    await buy("8100", T2 - 30 * H, 10000); // F: 30 h before its first report, within the grace
    await buy("8200", TG + H, 20000); // G: 71 h before its first report, 1 h after its install time
    await buy("8400", T2 - 5 * DAY, 7000); // P: before the install, beyond the grace
    await report({ installId: F, originalTransactionIds: ["8100"] });
    await report({ installId: G, originalTransactionIds: ["8200"] });
    await report({ installId: P, originalTransactionIds: ["8400"] });

    const r = await call(owner, `/api/v1/ltv?apps=${appId}&by=source&cohort=day&from=${dayOf(T2 - 6 * DAY)}&currency=USD`);
    expect(r.status).toBe(200);
    const lines = (r.json.rows as any[]).map((x) => [x.cohort, x.group, x.installs, x.payers, x.revenue, x.horizons[0].revenuePerInstall]);
    expect(lines).toEqual([
      [dayOf(TG), "organic", 1, 1, 20, 20],
      [dayOf(T2), "organic", 2, 1, 10, 5],
    ]);
    expect(r.json.coverage).toEqual({ installs: 3, attributed: 0, preexisting: 1, payingCustomers: 3, linkedCustomers: 2, share: 0.6667 });
  }, 120_000);
});
