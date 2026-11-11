import { env, fetchMock } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eventsTestHooks, resetEventsState } from "../../worker/lib/events";
import { resetOffersState } from "../../worker/lib/offers";
import { resetWaeCache } from "../../worker/lib/wae";
import { backgroundSpent } from "../../worker/lib/budget";
import { getDb } from "../../worker/lib/db";
import { addDays as addDaysUtc, dayOf } from "../../worker/lib/money";
import { DAY, call, notification, ownerClient } from "./helpers";
import { FakeGoogle, playOrder, playSubscription, pushBody, serviceAccountJson } from "./google-helpers";

const H = 3_600_000;
const token = (json: object) => `test:${JSON.stringify(json)}`;
const dbExec = (sql: string, params: (string | number)[] = []) => env.DATABASE.get(env.DATABASE.idFromName("main")).exec([{ sql, params, mode: "run" }], false);

// The Workers Free plan allows 5M rows read and 100k rows written a day in the Durable Object database. A sale and a
// polling read must stay cheap whatever the size of the history.
const stats = () => env.DATABASE.get(env.DATABASE.idFromName("main")).stats();

describe("Free plan budget", () => {
  it("keeps a sale and a cached read cheap", async () => {
    const owner = await ownerClient();
    const bundleId = "app.test.budget";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Budget", bundleId } });
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const post = (p: string) => call(null, `/apple/notifications/${key}`, { body: { signedPayload: p } });
    // A year of monthly renewals for 40 customers.
    const t0 = Date.now() - 365 * DAY;
    for (let c = 0; c < 40; c++) {
      for (let m = 0; m < 12; m++) {
        const n = await notification(m ? "DID_RENEW" : "SUBSCRIBED", {
          bundleId,
          transactionId: `${9000 + c}${String(m).padStart(2, "0")}`,
          originalTransactionId: `${9000 + c}00`,
          purchaseDate: t0 + c * DAY + m * 30 * DAY,
          expiresDate: t0 + c * DAY + (m + 1) * 30 * DAY,
          transactionReason: m ? "RENEWAL" : "PURCHASE",
        });
        expect((await post(n.signedPayload)).status).toBe(200);
      }
    }
    await call(owner, `/api/v1/overview`);

    let before = await stats();
    const sale = await notification("SUBSCRIBED", { bundleId, transactionId: "99999", purchaseDate: Date.now() - 60_000, expiresDate: Date.now() + 30 * DAY });
    expect((await post(sale.signedPayload)).status).toBe(200);
    let after = await stats();
    const saleWrites = after.rowsWritten - before.rowsWritten;
    const saleReads = after.rowsRead - before.rowsRead;
    console.log(`one sale: ${saleReads} rows read, ${saleWrites} rows written`);
    expect(saleWrites).toBeLessThan(80);
    expect(saleReads).toBeLessThan(2500);

    before = await stats();
    await call(owner, "/api/v1/overview");
    after = await stats();
    console.log(`overview after a sale (recomputed): ${after.rowsRead - before.rowsRead} rows read`);
    before = await stats();
    await call(owner, "/api/v1/charts/mrr?range=12m");
    after = await stats();
    console.log(`mrr chart 12m: ${after.rowsRead - before.rowsRead} rows read`);
    before = await stats();
    for (let i = 0; i < 5; i++) expect((await call(owner, "/api/v1/overview")).status).toBe(200);
    after = await stats();
    const pollReads = (after.rowsRead - before.rowsRead) / 5;
    console.log(`cached overview: ${pollReads} rows read per call`);
    expect(pollReads).toBeLessThan(20);
  }, 120_000);

  it("keeps the first LTV read bounded per install and serves other groupings from the day cache", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.ltv.budget";
    const app = await call(owner, "/api/v1/apps", { body: { name: "LTV budget", bundleId } });
    const appId = app.json.id as string;
    const sdkKey = app.json.sdkKey as string;
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const sale = async (type: string, transactionId: string, originalTransactionId: string, at: number, renewal: boolean) => {
      const n = await notification(type, { bundleId, transactionId, originalTransactionId, purchaseDate: at, expiresDate: at + 30 * DAY, transactionReason: renewal ? "RENEWAL" : "PURCHASE" });
      expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    };
    // 30 installs, each with a subscription of 6 monthly payments.
    const INSTALLS = 30;
    const t0 = Date.now() - 200 * DAY;
    for (let i = 0; i < INSTALLS; i++) {
      const installId = `f0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const otid = `${8800 + i}00`;
      for (let m = 0; m < 6; m++) await sale(m ? "DID_RENEW" : "SUBSCRIBED", `${8800 + i}0${m}`, otid, t0 + i * DAY + m * 30 * DAY, m > 0);
      expect((await call(null, "/sdk/v1/report", { body: { sdkKey, installId, attributionToken: token({ attribution: i % 2 === 0, campaignId: 900 + (i % 3) }), originalTransactionIds: [otid] } })).status).toBe(200);
      await dbExec("UPDATE attributions SET created_at = ? WHERE app_id = ? AND install_id = ?", [t0 + i * DAY - H, appId, installId]);
    }
    await dbExec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`data_version:${owner.workspaceId}`, String(Date.now())]);
    const ltv = (q: string) => call(owner, `/api/v1/ltv${q}${q.includes("?") ? "&" : "?"}apps=${appId}`);
    await call(owner, `/api/v1/overview?apps=${appId}`); // rollups out of the way

    let before = await stats();
    const first = await ltv("?by=campaign&range=12m");
    let after = await stats();
    expect(first.status).toBe(200);
    expect(first.json.rows.reduce((s: number, r: any) => s + r.installs, 0)).toBe(INSTALLS);
    const firstReads = after.rowsRead - before.rowsRead;
    console.log(`ltv first read: ${firstReads} rows read (${INSTALLS} installs, ${INSTALLS * 6} transactions): ${(firstReads / INSTALLS).toFixed(1)} per install`);
    // Each install here pays (1 attribution, 1 link, 6 transactions, 1 paying customer for the coverage): about 16 rows;
    // installs that never pay cost 1-2.
    expect(firstReads / INSTALLS).toBeLessThan(18);
    expect(after.rowsWritten - before.rowsWritten).toBe(0);

    before = await stats();
    for (let i = 0; i < 5; i++) expect((await ltv("?by=campaign&range=12m")).status).toBe(200);
    after = await stats();
    const cached = (after.rowsRead - before.rowsRead) / 5;
    console.log(`ltv cached read: ${cached} rows read per call`);
    // A re-scan would cost ~16 rows per install (~490 here); the margin absorbs unrelated reads in a full run.
    expect(cached).toBeLessThan(40);

    // A new sale bumps the data version: other groupings, cohort sizes and the summary come from the day's base, no new scan.
    await sale("DID_RENEW", "88000006", "880000", t0 + 180 * DAY, true);
    await call(owner, `/api/v1/overview?apps=${appId}`);
    before = await stats();
    const others = ["?by=keyword&range=12m", "?by=country&cohort=month&range=12m", "?by=source&cohort=day&range=90d", "/summary?by=adgroup&range=180d", "?by=source&summary=1&range=182d"];
    for (const q of others) {
      const r = await ltv(q);
      expect(r.status).toBe(200);
    }
    after = await stats();
    const derived = (after.rowsRead - before.rowsRead) / others.length;
    console.log(`ltv other groupings after a sale: ${derived} rows read per call`);
    expect(derived).toBeLessThan(40);
  }, 120_000);
  it("keeps an experiment's results read bounded per exposed install and serves repeated reads from the row", async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    eventsTestHooks.binding = { writeDataPoint: () => undefined };
    try {
      const owner = await ownerClient();
      const ws = await call(owner, "/api/v1/workspaces", { body: { name: "Experiment budget", currency: "USD" } });
      const client = { ...owner, ws: ws.json.id as string };
      const bundleId = "com.example.exp.budget";
      const app = await call(client, "/api/v1/apps", { body: { name: "Experiment budget", bundleId } });
      const appId = app.json.id as string;
      const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
      await call(client, `/api/v1/apps/${appId}/config`, { method: "PUT", body: { parameters: [{ key: "paywall", type: "string", defaultValue: "a" }] } });
      const exp = (await call(client, `/api/v1/apps/${appId}/experiments`, { body: { name: "Cost", keys: ["paywall"], variants: [{}, { values: { paywall: "b" } }] } })).json;
      await call(client, `/api/v1/apps/${appId}/experiments/${exp.id}/start`, { method: "POST" });
      const start = Date.now() - 8 * DAY;
      await dbExec("UPDATE experiments SET started_at = ? WHERE id = ?", [start, exp.id]);
      // 200 exposed installs per variant; 30 of each pay, then renew once.
      const PER = 200;
      const install = (v: string, i: number) => `${v === "a" ? "a" : "b"}1000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      for (const v of ["a", "b"]) {
        for (let i = 0; i < 30; i++) {
          const otid = `66${v === "a" ? 1 : 2}${String(i).padStart(4, "0")}0`;
          for (let m = 0; m < 2; m++) {
            const at = start + DAY + i * H + m * 30 * DAY;
            const n = await notification(m ? "DID_RENEW" : "SUBSCRIBED", {
              bundleId,
              transactionId: `${otid}${m}`,
              originalTransactionId: otid,
              originalPurchaseDate: start + DAY + i * H,
              purchaseDate: Math.min(at, Date.now() - H),
              expiresDate: at + 30 * DAY,
              transactionReason: m ? "RENEWAL" : "PURCHASE",
              appAccountToken: install(v, i),
            });
            expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
          }
        }
      }
      resetWaeCache();
      fetchMock
        .get("https://api.cloudflare.com")
        .intercept({ path: `/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, method: "POST" })
        .reply((opts) => {
          const v = String(opts.body).includes(`${exp.id}:a'`) ? "a" : "b";
          return { statusCode: 200, data: JSON.stringify({ data: Array.from({ length: PER }, (_, i) => ({ install: install(v, i), first: start + DAY - H, si: 1 })) }) };
        })
        .times(2);
      const spent0 = await backgroundSpent(getDb(env));
      let before = await stats();
      const first = await call(client, `/api/v1/apps/${appId}/experiments/${exp.id}/results`);
      let after = await stats();
      const spent1 = await backgroundSpent(getDb(env));
      fetchMock.assertNoPendingInterceptors();
      expect(first.status, first.text).toBe(200);
      expect(first.json.variants.map((v: { exposed: number; paid: number }) => [v.exposed, v.paid])).toEqual([
        [PER, 30],
        [PER, 30],
      ]);
      const reads = after.rowsRead - before.rowsRead;
      const writes = after.rowsWritten - before.rowsWritten;
      console.log(`experiment results: ${reads} rows read for ${2 * PER} exposed installs (${(reads / (2 * PER)).toFixed(2)} per install), ${writes} written`);
      // An exposed install costs its install_links probe plus its own transactions (2 here, for 15 % of them): a scan of
      // the app's transactions per statement would cost ~20 per install.
      expect(reads / (2 * PER)).toBeLessThan(3);
      // The results row, the background meter (settings bg:<day>).
      expect(writes).toBeLessThanOrEqual(6);
      // Metered against the daily background budget (worker/lib/budget.ts).
      expect(spent1.r - spent0.r).toBeGreaterThanOrEqual(reads * 0.8);
      before = await stats();
      for (let i = 0; i < 5; i++) expect((await call(client, `/api/v1/apps/${appId}/experiments/${exp.id}/results`)).status).toBe(200);
      after = await stats();
      const cached = (after.rowsRead - before.rowsRead) / 5;
      console.log(`experiment results cached: ${cached} rows read per call`);
      // The session / membership check and the experiment row.
      expect(cached).toBeLessThan(10);
      expect(after.rowsWritten - before.rowsWritten).toBe(0);

      // A refresh within the hour is refused before any work.
      before = await stats();
      const refused = await call(client, `/api/v1/apps/${appId}/experiments/${exp.id}/results/refresh`, { method: "POST" });
      after = await stats();
      expect(refused.status).toBe(429);
      expect(after.rowsRead - before.rowsRead).toBeLessThan(10);
      expect(after.rowsWritten - before.rowsWritten).toBe(0);

      // Today's background budget used up: nothing is computed (no query, no write), reads say why, refreshes get 429.
      const bgKey = `bg:${dayOf(Date.now())}`;
      const saved = await getDb(env).prepare("SELECT value FROM settings WHERE key = ?").bind(bgKey).first<{ value: string }>();
      try {
        await dbExec("UPDATE experiments SET results = NULL, results_at = NULL WHERE id = ?", [exp.id]);
        await dbExec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [bgKey, JSON.stringify({ w: 1e9, r: 1e9 })]);
        before = await stats();
        const exhausted = await call(client, `/api/v1/apps/${appId}/experiments/${exp.id}/results`);
        after = await stats();
        expect(exhausted.status).toBe(200);
        expect(exhausted.json.reasons[0]).toContain("budget");
        expect(exhausted.json.exposureSource).toBe("none");
        expect(after.rowsWritten - before.rowsWritten).toBe(0);
        expect((await call(client, `/api/v1/apps/${appId}/experiments/${exp.id}/results/refresh`, { method: "POST" })).status).toBe(429);
      } finally {
        if (saved) await dbExec("UPDATE settings SET value = ? WHERE key = ?", [saved.value, bgKey]);
        else await dbExec("DELETE FROM settings WHERE key = ?", [bgKey]);
      }
      await call(client, `/api/v1/apps/${appId}/experiments/${exp.id}/archive`, { method: "POST" });
      await dbExec("UPDATE experiments SET frozen = 1 WHERE id = ?", [exp.id]);
    } finally {
      eventsTestHooks.binding = null;
    }
  }, 120_000);
  it("keeps a promotional offer signature and a refusal cheap, and samples a flood of refusals", async () => {
    resetOffersState();
    const owner = await ownerClient();
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
    const ws = await call(owner, "/api/v1/workspaces", { body: { name: "Offers budget", currency: "USD" } });
    const client = { ...owner, ws: ws.json.id as string };
    expect((await call(client, "/api/v1/credentials", { body: { kind: "appstore_iap", name: "IAP", keyId: "BUDGETKEY1", issuerId: crypto.randomUUID(), privateKey: pem } })).status).toBe(201);
    const bundleId = "com.example.offers.cost";
    const app = await call(client, "/api/v1/apps", { body: { name: "Offers cost", bundleId } });
    const sdkKey = app.json.sdkKey as string;
    await call(client, `/api/v1/apps/${app.json.id}/offers`, { method: "PUT", body: { offers: [{ productId: `${bundleId}.annual`, offerId: "save50" }] } });
    const sign = (offerId: string) =>
      call(null, "/sdk/v1/offers/sign", { body: { installId: crypto.randomUUID(), productId: `${bundleId}.annual`, offerId }, headers: { "x-revflare-key": sdkKey } });
    // The log is written after the response: wait until the counters settle.
    const settled = async () => {
      let last = await stats();
      for (let i = 0; i < 50; i++) {
        await new Promise((res) => setTimeout(res, 30));
        const next = await stats();
        if (next.rowsWritten === last.rowsWritten && next.rowsRead - last.rowsRead <= 1) return next;
        last = next;
      }
      return last;
    };
    const cost = async (work: () => Promise<void>) => {
      const before = await settled();
      await work();
      const after = await settled();
      return { reads: after.rowsRead - before.rowsRead, writes: after.rowsWritten - before.rowsWritten };
    };
    expect((await sign("save50")).status).toBe(200); // warms the isolate's cache

    const signed = await cost(async () => expect((await sign("save50")).status).toBe(200));
    const refused = await cost(async () => expect((await sign("other")).status).toBe(403));
    console.log(`offer signature: ${signed.reads} rows read, ${signed.writes} written; refusal: ${refused.reads} read, ${refused.writes} written`);
    expect(signed.writes).toBeGreaterThan(0);
    expect(signed.writes).toBeLessThanOrEqual(6);
    expect(signed.reads).toBeLessThan(30);
    expect(refused.writes).toBeLessThanOrEqual(6);
    expect(refused.reads).toBeLessThan(30);

    // 100 more refusals: 19 more logged in full this hour, then 1 in 50 (one row here).
    const flood = await cost(async () => {
      for (let i = 0; i < 100; i++) expect((await sign("other")).status).toBe(403);
    });
    console.log(`100 refusals: ${flood.reads} rows read, ${flood.writes} written`);
    expect(flood.writes).toBeLessThanOrEqual(20 * Math.max(refused.writes, 1));
    const log = await call(client, `/api/v1/apps/${app.json.id}/offers/log?limit=1000`);
    const rows = (log.json.items as any[]).filter((r) => r.status === "not_allowed");
    expect(rows).toHaveLength(21);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(70);
  }, 120_000);

  it("answers a token-less SDK re-report (installId only) without writing", async () => {
    const owner = await ownerClient();
    const app = await call(owner, "/api/v1/apps", { body: { name: "Report budget", bundleId: "com.example.reportbudget" } });
    const sdkKey = app.json.sdkKey as string;
    const install = "f1111111-1111-4111-8111-111111111111";
    const first = await call(null, "/sdk/v1/report", { body: { sdkKey, installId: install, attributionToken: token({ attribution: true, campaignId: 9101, adGroupId: 9201, keywordId: 9301 }) } });
    expect(first.json).toMatchObject({ ok: true, source: "apple_ads", campaignId: "9101" });
    const before = await stats();
    const again = await call(null, "/sdk/v1/report", { body: { sdkKey, installId: install } });
    const after = await stats();
    expect(again.json).toEqual({ ok: true, attribution: "resolved", source: "apple_ads", campaignId: "9101", adGroupId: "9201", keywordId: "9301" });
    console.log(`token-less re-report: ${after.rowsRead - before.rowsRead} rows read, ${after.rowsWritten - before.rowsWritten} written`);
    expect(after.rowsWritten - before.rowsWritten).toBe(0);
    expect(after.rowsRead - before.rowsRead).toBeLessThanOrEqual(4);
    // The environment moves only toward production: steady re-reports of a production install (any build) write nothing.
    for (const environment of ["production", "sandbox", "xcode"]) {
      const b = await stats();
      expect((await call(null, "/sdk/v1/report", { body: { sdkKey, installId: install, environment } })).status).toBe(200);
      expect((await stats()).rowsWritten - b.rowsWritten).toBe(0);
    }
  });

  // Exact key-event reads (funnel report, funnel alerts, experiment exposures, events page) are measured in
  // test/workers/sdk-key-events.test.ts ("exact key-event read cost": about 3 rows read per stored event of the steps
  // in the range; the events page reads the rollup and the names' rows once). They live in the other workers runtime:
  // one more test here overflows this runtime's Durable Object wrapper stack (vitest.workers.config.ts).
  it("stores key events at a fixed write cost and writes nothing for a batch without key events", async () => {
    eventsTestHooks.binding = { writeDataPoint: () => undefined };
    resetEventsState();
    try {
      const owner = await ownerClient();
      const app = await call(owner, "/api/v1/apps", { body: { name: "Key events budget", bundleId: "com.example.keyevents.budget" } });
      const sdkKey = app.json.sdkKey as string;
      const send = (installId: string, names: string[]) =>
        call(null, "/sdk/v1/events", {
          headers: { "x-revflare-key": sdkKey },
          body: { installId, events: names.map((name, i) => ({ id: `${installId.slice(0, 8)}-${i}-${Math.random().toString(36).slice(2, 8)}`, name, ts: Date.now() - 60_000, props: { placement: "home" } })) },
        });
      // The app's first key event (day row, coverage start) out of the way.
      expect((await send("f2222222-2222-4222-8222-222222222220", ["first_open"])).status).toBe(200);

      const N = 20;
      let before = await stats();
      expect((await send("f2222222-2222-4222-8222-222222222221", Array.from({ length: N }, () => "paywall_view"))).status).toBe(200);
      let after = await stats();
      const writes = after.rowsWritten - before.rowsWritten;
      const reads = after.rowsRead - before.rowsRead;
      console.log(`${N} key events: ${writes} rows written (${(writes / N).toFixed(2)} per event), ${reads} rows read`);
      // Per event: the row and its two index entries; per request: the day counter, one rollup row per distinct name
      // (app_event_counts, here 1) and the background budget counter.
      expect(writes).toBeGreaterThanOrEqual(3 * N + 1);
      expect(writes).toBeLessThanOrEqual(3 * N + 6);
      expect(reads).toBeLessThanOrEqual(2 * N + 10);

      // SDK retry of a stored batch costs no writes beyond the budget counter.
      before = await stats();
      const evs = Array.from({ length: 5 }, (_, i) => ({ id: `retry-${i}`, name: "purchase_started", ts: Date.now() - 60_000 }));
      const install = "f2222222-2222-4222-8222-222222222222";
      await call(null, "/sdk/v1/events", { headers: { "x-revflare-key": sdkKey }, body: { installId: install, events: evs } });
      const once = (await stats()).rowsWritten - before.rowsWritten;
      before = await stats();
      await call(null, "/sdk/v1/events", { headers: { "x-revflare-key": sdkKey }, body: { installId: install, events: evs } });
      const retry = (await stats()).rowsWritten - before.rowsWritten;
      console.log(`5 key events: ${once} rows written; the same batch again: ${retry}`);
      expect(once).toBeGreaterThanOrEqual(15);
      // RETURNING gives no inserted row: no day counter, no rollup upsert.
      expect(retry).toBeLessThanOrEqual(1);

      // Not a key event: no database work at all.
      before = await stats();
      expect((await send("f2222222-2222-4222-8222-222222222223", ["app_open", "screen_view", "button_tap"])).status).toBe(200);
      after = await stats();
      expect(after.rowsWritten - before.rowsWritten).toBe(0);
      expect(after.rowsRead - before.rowsRead).toBe(0);
    } finally {
      eventsTestHooks.binding = null;
    }
  });
  it("keeps a Google Play notification no costlier than an App Store one", async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    const google = new FakeGoogle();
    google.install();
    const admin = await ownerClient();
    // One workspace per store, so both sales do the same rollup work.
    const wsA = (await call(admin, "/api/v1/workspaces", { body: { name: "Budget App Store" } })).json.id as string;
    const wsG = (await call(admin, "/api/v1/workspaces", { body: { name: "Budget Google Play" } })).json.id as string;
    const owner = { ...admin, ws: wsA };
    const ownerG = { ...admin, ws: wsG };
    const t0 = Date.now() - 200 * DAY;
    // The same history in both stores: 10 customers with 6 monthly payments each.
    const ios = await call(owner, "/api/v1/apps", { body: { name: "Budget iOS", bundleId: "com.example.budget.cost" } });
    const iosKey = (ios.json.revflareNotificationUrl as string).split("/").pop()!;
    const droid = await call(ownerG, "/api/v1/apps", { body: { platform: "android", name: "Budget Android", packageName: "com.example.budget.cost" } });
    const droidKey = (droid.json.revflareNotificationUrl as string).split("/").pop()!;
    const sa = await serviceAccountJson("budget@example-project.iam.gserviceaccount.com");
    expect((await call(ownerG, `/api/v1/apps/${droid.json.id}/google-play`, { method: "PUT", body: { serviceAccount: sa.json } })).status).toBe(200);
    const apple = async (type: string, id: string, otid: string, at: number, renewal: boolean) => {
      const n = await notification(type, { bundleId: "com.example.budget.cost", transactionId: id, originalTransactionId: otid, purchaseDate: at, expiresDate: at + 30 * DAY, transactionReason: renewal ? "RENEWAL" : "PURCHASE" });
      expect((await call(null, `/apple/notifications/${iosKey}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    };
    const play = async (type: number, base: string, n: number | null, at: number) => {
      const orderId = n === null ? base : `${base}..${n}`;
      google.orders.set(orderId, playOrder(orderId, { start: at, price: 9.99 }));
      google.subs.set(`tok-${base}`, playSubscription({ orderId, expiry: at + 30 * DAY }));
      const p = pushBody("com.example.budget.cost", { subscriptionNotification: { version: "1.0", notificationType: type, purchaseToken: `tok-${base}` } });
      expect((await call(null, `/google/rtdn/${droidKey}`, { body: p.body })).status).toBe(200);
    };
    for (let c = 0; c < 10; c++) {
      for (let m = 0; m < 6; m++) {
        const at = t0 + c * DAY + m * 30 * DAY;
        await apple(m ? "DID_RENEW" : "SUBSCRIBED", `${7700 + c}${m}`, `${7700 + c}0`, at, m > 0);
        await play(m ? 2 : 4, `GPA.7700-0000-0000-${String(10000 + c)}`, m ? m - 1 : null, at);
      }
    }
    await call(owner, "/api/v1/overview");
    await call(ownerG, "/api/v1/overview");
    let before = await stats();
    await apple("SUBSCRIBED", "779999", "779999", Date.now() - 60_000, false);
    let after = await stats();
    const appleCost = { reads: after.rowsRead - before.rowsRead, writes: after.rowsWritten - before.rowsWritten };
    before = await stats();
    await play(4, "GPA.7799-9999-9999-99999", null, Date.now() - 60_000);
    after = await stats();
    const playCost = { reads: after.rowsRead - before.rowsRead, writes: after.rowsWritten - before.rowsWritten };
    console.log(`one App Store sale: ${JSON.stringify(appleCost)}, one Google Play sale: ${JSON.stringify(playCost)}`);
    // Writes (the scarce budget: 100k a day) never exceed an App Store sale's; reads match up to the rollup's, which
    // depend on the shape of each app's history (a few rows either way).
    expect(playCost.writes).toBeLessThanOrEqual(appleCost.writes);
    expect(playCost.reads).toBeLessThanOrEqual(appleCost.reads + 8);
  }, 120_000);

  it("keeps goals over several apps and a year cheap: one read of their days, then today's rows", async () => {
    const admin = await ownerClient();
    const ws = (await call(admin, "/api/v1/workspaces", { body: { name: "Goals budget", currency: "USD" } })).json.id as string;
    const owner = { ...admin, ws };
    const apps: { id: string; key: string; bundleId: string }[] = [];
    for (const i of [1, 2, 3]) {
      const bundleId = `com.example.goals.budget${i}`;
      const r = await call(owner, "/api/v1/apps", { body: { name: `Goals ${i}`, bundleId } });
      apps.push({ id: r.json.id, key: (r.json.revflareNotificationUrl as string).split("/").pop()!, bundleId });
    }
    // 13 months of monthly renewals for 5 customers per app.
    const t0 = Date.now() - 395 * DAY;
    for (const [ai, a] of apps.entries()) {
      for (let c = 0; c < 5; c++) {
        for (let m = 0; m < 13; m++) {
          const n = await notification(m ? "DID_RENEW" : "SUBSCRIBED", {
            bundleId: a.bundleId,
            transactionId: `77${ai}${c}${String(m).padStart(2, "0")}`,
            originalTransactionId: `77${ai}${c}00`,
            purchaseDate: t0 + c * DAY + m * 30 * DAY,
            expiresDate: t0 + c * DAY + (m + 1) * 30 * DAY,
            transactionReason: m ? "RENEWAL" : "PURCHASE",
          });
          expect((await call(null, `/apple/notifications/${a.key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
        }
      }
    }
    await call(owner, "/api/v1/overview"); // rollups out of the way
    const [A, B, C] = apps.map((a) => a.id);
    const today = dayOf(Date.now());
    const goal = async (body: Record<string, unknown>) => expect((await call(owner, "/api/v1/goals", { body })).status).toBe(201);
    await goal({ name: "Year, two apps", metric: "revenue", target: 5000, period: "year", scope: "include", appIds: [A, B] });
    await goal({ name: "MRR but the third", metric: "mrr", target: 500, period: "year", scope: "exclude", appIds: [C] });
    await goal({ name: "365 days, all three", metric: "revenue", target: 9000, period: "custom", startDate: addDaysUtc(today, -364), endDate: today, scope: "include", appIds: [A, B, C] });
    await goal({ name: "Quarter sales", metric: "sales", target: 200, period: "quarter" });

    // The bound: one row per app and day of each app set's range (this period and the previous one, a day before
    // for stock metrics) + the workspace's daily totals for the whole-workspace goal + a few dozen rows of goals, apps and settings.
    const year = new Date().getUTCFullYear();
    const q = Math.floor(new Date().getUTCMonth() / 3);
    const prevQuarterStart = q ? `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01` : `${year - 1}-10-01`;
    const count = async (sql: string, params: (string | number)[]) => ((await getDb(env).prepare(sql).bind(...params).first<{ n: number }>())?.n ?? 0);
    const rangeRows =
      (await count("SELECT COUNT(*) AS n FROM daily_metrics WHERE app_id IN (?, ?) AND day >= ? AND day <= ?", [A, B, `${year - 2}-12-31`, today])) +
      (await count("SELECT COUNT(*) AS n FROM daily_metrics WHERE app_id IN (?, ?, ?) AND day >= ? AND day <= ?", [A, B, C, addDaysUtc(today, -365), today])) +
      (await count("SELECT COUNT(*) AS n FROM workspace_daily WHERE workspace_id = ? AND day >= ? AND day <= ?", [ws, addDaysUtc(prevQuarterStart, -1), today]));

    // Cold: a past day changed, so the cached days are read again.
    await dbExec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`data_past:${ws}`, String(Date.now())]);
    await dbExec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`data_version:${ws}`, String(Date.now())]);
    let before = await stats();
    const cold = await call(owner, "/api/v1/goals");
    let after = await stats();
    expect(cold.status).toBe(200);
    expect(cold.json.items).toHaveLength(4);
    const coldReads = after.rowsRead - before.rowsRead;
    console.log(`goals, cold (4 goals, 3 app sets, a year + the year before): ${coldReads} rows read for ${rangeRows} daily rows in range`);
    expect(coldReads).toBeLessThanOrEqual(rangeRows + 100);

    // A sale today: the recompute reads today's rows only.
    const sale = await notification("SUBSCRIBED", { bundleId: apps[0].bundleId, transactionId: "7799999", purchaseDate: Date.now() - 60_000, expiresDate: Date.now() + 30 * DAY });
    expect((await call(null, `/apple/notifications/${apps[0].key}`, { body: { signedPayload: sale.signedPayload } })).status).toBe(200);
    await call(owner, `/api/v1/charts/revenue?range=7d&apps=${A}`); // the sale's rollup
    before = await stats();
    const warm = await call(owner, "/api/v1/goals");
    after = await stats();
    expect(warm.status).toBe(200);
    const warmReads = after.rowsRead - before.rowsRead;
    console.log(`goals after a sale (recomputed): ${warmReads} rows read`);
    // Today's rows of the 3 app sets, the goals, apps and settings: ~50 here; a re-read of the year would be ~2,000.
    expect(warmReads).toBeLessThan(80);
    // The year goal on the first two apps moved by the sale.
    const y0 = cold.json.items.find((g: any) => g.name === "Year, two apps");
    const y1 = warm.json.items.find((g: any) => g.name === "Year, two apps");
    expect(y1.current).toBeGreaterThan(y0.current);

    before = await stats();
    for (let i = 0; i < 5; i++) expect((await call(owner, "/api/v1/goals")).status).toBe(200);
    after = await stats();
    const cached = (after.rowsRead - before.rowsRead) / 5;
    console.log(`goals, cached: ${cached} rows read per call`);
    expect(cached).toBeLessThan(20);
  }, 120_000);
});
