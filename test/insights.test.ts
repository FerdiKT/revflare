import { describe, expect, it } from "vitest";
import { assembleDigest, changeLabel, dayLabel, digestEmail, digestEventsOf, digestPushLine } from "../worker/lib/digest";
import { parseFunnel, parseFunnelAlerts } from "../worker/lib/funnels";
import { DEFAULT_PREFS, wants, type PushMessage } from "../worker/lib/push";
import {
  binomialCdf,
  DROP_THRESHOLD,
  eventSilence,
  logGamma,
  mostSensitive,
  normalCdf,
  pickRelease,
  pickRoundRobin,
  twoProportionTest,
  worstAnomaly,
  worstRegression,
} from "../worker/lib/stats";
import { digestSql } from "../worker/lib/wae";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 20, 12);

describe("distributions", () => {
  it("log gamma and the binomial CDF match known values", () => {
    expect(logGamma(1)).toBeCloseTo(0, 10);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(logGamma(101)).toBeCloseTo(363.73937555556347, 8);
    // P(X ≤ 2), X ~ Bin(10, 0.5) = 56 / 1024.
    expect(binomialCdf(2, 10, 0.5)).toBeCloseTo(56 / 1024, 12);
    expect(binomialCdf(10, 10, 0.3)).toBe(1);
    expect(binomialCdf(-1, 10, 0.3)).toBe(0);
    // Large n stays finite: 1000 trials at 20 %, 150 successes is far in the lower tail (z ≈ -3.95).
    const p = binomialCdf(150, 1000, 0.2);
    expect(p).toBeGreaterThan(1e-5);
    expect(p).toBeLessThan(1e-4);
  });

  it("normal CDF and the one-sided two-proportion test", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 5);
    expect(normalCdf(2.326348)).toBeCloseTo(0.99, 5);
    const t = twoProportionTest(60, 300, 100, 300);
    expect(t.z).toBeCloseTo(-3.6927, 3);
    expect(t.p).toBeLessThan(0.001);
    expect(twoProportionTest(100, 300, 60, 300).p).toBeGreaterThan(0.99);
    expect(twoProportionTest(0, 0, 1, 2).p).toBe(1);
  });
});

describe("funnel anomaly rule", () => {
  // Baseline (14 days): 28000 → 14000 → 7000 (50 %, 50 %); the same weekday (2 days): 4000 → 2000 → 1000.
  const base = [28000, 14000, 7000];
  const wday = [4000, 2000, 1000];
  it("raises on a significant drop above the sensitivity threshold and reports the worst step", () => {
    // Step 2 conversion 30 % vs 50 % (40 % drop), step 3 40 % vs 50 % (20 % drop, n = 60: not significant).
    const r = worstAnomaly([200, 60, 24], base, wday, "normal");
    expect(r).toMatchObject({ step: 1, converted: 60, entered: 200, rate: 0.3, baseRate: 0.5, weekday: { rate: 0.5, converted: 2000, entered: 4000 } });
    expect(r!.drop).toBeCloseTo(0.4, 10);
    expect(r!.p).toBeLessThan(0.01);
  });

  it("needs 100 entrants, 30 at the step before and a large enough drop", () => {
    expect(worstAnomaly([99, 20, 10], base, wday, "high")).toBeNull();
    // 160 → 25: step 3 has 25 at the step before (< 30): skipped; step 2 is 15.6 % vs 50 %.
    expect(worstAnomaly([160, 25, 0], base, wday, "normal")).toMatchObject({ step: 1 });
    // 17.5 % drop: high (15 %) alerts with enough data, normal (20 %) does not.
    const big = [10_000, 4125, 2063];
    const bigBase = [56_000, 28_000, 14_000];
    const bigDay = [20_000, 10_000, 5_000];
    expect(worstAnomaly(big, bigBase, bigDay, "normal")).toBeNull();
    expect(worstAnomaly(big, bigBase, bigDay, "high")).toMatchObject({ step: 1 });
    // 25 % drop: normal yes, low (30 %) no.
    expect(worstAnomaly([2000, 750, 375], base, wday, "normal")).not.toBeNull();
    expect(worstAnomaly([2000, 750, 375], base, wday, "low")).toBeNull();
    expect(DROP_THRESHOLD).toEqual({ high: 0.15, normal: 0.2, low: 0.3 });
    // A big relative drop on little data is not significant.
    expect(worstAnomaly([100, 40, 15], base, wday, "normal")).toBeNull();
    // Spikes never alert.
    expect(worstAnomaly([200, 180, 170], base, wday, "high")).toBeNull();
  });

  it("tests against the baseline as a sample (two-proportion), and needs a large enough baseline", () => {
    // 60 of 200 against 50 of 100: the old one-sample test (p0 = 50 % taken as exact) would alert; the baseline is too
    // small anyway (needs max(300, 5 × 200) installs at the step before).
    expect(binomialCdf(60, 200, 0.5)).toBeLessThan(0.01);
    expect(worstAnomaly([200, 60], [100, 50], [100, 50], "normal")).toBeNull();
    expect(worstAnomaly([200, 60], [999, 500], [400, 200], "normal")).toBeNull();
    expect(worstAnomaly([200, 60], [1000, 500], [400, 200], "normal")).toMatchObject({ step: 1 });
    // Weekday baseline smaller than yesterday: skipped.
    expect(worstAnomaly([200, 60], [1000, 500], [199, 100], "normal")).toBeNull();
    // A two-proportion p that a one-sample test would understate: 100 of 400 vs 120 of 300 pooled → p ≈ 3e-5, still alerts.
    expect(worstAnomaly([400, 100], [2000, 800], [400, 160], "normal")).toMatchObject({ step: 1 });
  });

  it("a recurring weekend dip does not alert, a real drop on the same weekday does", () => {
    // 12 weekdays at 50 %, the 2 Sundays of the window at 35 %; yesterday was a Sunday.
    const pooled = [14_000, 12 * 500 + 2 * 350];
    const sundays = [2000, 700];
    // Sunday at 35 %: 27 % below the 14-day rate (significant), but not below other Sundays.
    expect(worstAnomaly([1000, 350], pooled, sundays, "normal")).toBeNull();
    expect(worstAnomaly([1000, 350], pooled, [2000, 1000], "normal")).toMatchObject({ step: 1 });
    // Sunday at 20 %: below both.
    const r = worstAnomaly([1000, 200], pooled, sundays, "normal");
    expect(r).toMatchObject({ step: 1, converted: 200, entered: 1000, weekday: { rate: 0.35, converted: 700, entered: 2000 } });
    expect(r!.weekday!.drop).toBeCloseTo(1 - 0.2 / 0.35, 10);
    // Below other Sundays but not below the 14-day rate by the threshold (a weekday-only dip is not enough either).
    expect(worstAnomaly([1000, 420], [14_000, 6000], [2000, 1200], "normal")).toBeNull();
  });
});

describe("release pick", () => {
  const at = NOW;
  const dataFrom = Date.UTC(2026, 9, 5);
  const opts = { at, dataFrom, convertMs: DAY };
  const many = (n: number, version: string | null, from: number) => Array.from({ length: n }, (_, i) => ({ first: from + i * 60_000, version }));

  it("skips a newer beta build with few installs and tests the real rollout", () => {
    const entries = [
      ...many(500, "2.0.2", dataFrom + HOUR),
      ...many(250, "2.0.2", at - 3 * DAY),
      ...many(300, "2.0.5", at - 4 * DAY),
      // A TestFlight build first seen yesterday: 3 testers.
      ...many(3, "2.1.0-beta", at - 2 * DAY),
      ...many(50, null, at - 3 * DAY),
    ];
    const r = pickRelease(entries, opts);
    expect(r).toMatchObject({ version: "2.0.5", previous: "2.0.2", start: at - 4 * DAY, winStart: at - 4 * DAY, winEnd: at - DAY });
  });

  it("skips with a reason, and says when no version is new", () => {
    expect(pickRelease(many(500, "2.0.2", dataFrom + HOUR), opts)).toEqual({ skipped: "regression: no version first seen in the last 14 days", noNewVersion: true });
    const few = pickRelease([...many(500, "2.0.2", dataFrom + HOUR), ...many(150, "2.0.5", at - 4 * DAY)], opts);
    expect(few).toMatchObject({ noNewVersion: false });
    expect("skipped" in few && few.skipped).toContain("2.0.5 150");
    const noPrev = pickRelease([...many(10, "2.0.2", dataFrom + HOUR), ...many(300, "2.0.5", at - 4 * DAY)], opts);
    expect("skipped" in noPrev && noPrev.skipped).toContain("needs 200 each");
  });
});

describe("release regression rule", () => {
  it("compares versions per step with the two-proportion test", () => {
    const prev = [1000, 500, 200];
    const r = worstRegression([400, 120, 48], prev, "normal");
    expect(r).toMatchObject({ step: 1, converted: 120, entered: 400, rate: 0.3, baseRate: 0.5 });
    expect(r!.p).toBeLessThan(0.01);
    expect(worstRegression([199, 50, 20], prev, "high")).toBeNull();
    expect(worstRegression([400, 120, 48], [199, 100, 40], "high")).toBeNull();
    // Same rates: nothing.
    expect(worstRegression([400, 200, 80], prev, "high")).toBeNull();
  });
});

describe("round-robin pick", () => {
  it("starts after the cursor and wraps around", () => {
    const ids = ["fn_d", "fn_a", "fn_c", "fn_b", "fn_e"];
    expect(pickRoundRobin(ids, null, 2)).toEqual(["fn_a", "fn_b"]);
    expect(pickRoundRobin(ids, "fn_b", 2)).toEqual(["fn_c", "fn_d"]);
    expect(pickRoundRobin(ids, "fn_d", 3)).toEqual(["fn_e", "fn_a", "fn_b"]);
    expect(pickRoundRobin(ids, "fn_z", 2)).toEqual(["fn_a", "fn_b"]);
    expect(pickRoundRobin(ids, "fn_bb", 10)).toEqual(["fn_c", "fn_d", "fn_e", "fn_a", "fn_b"]);
    expect(pickRoundRobin([], "fn_a", 3)).toEqual([]);
  });
});

describe("event silence", () => {
  /** A state with `hours` active hours on each of the `days` days before NOW. */
  const history = (days: number, hours: number) => ({
    last: NOW - HOUR,
    days: Object.fromEntries(Array.from({ length: days }, (_, i) => [new Date(NOW - (i + 1) * DAY).toISOString().slice(0, 10), hours])),
  });

  it("needs events on most of the last 7 days", () => {
    expect(eventSilence(history(3, 24), NOW - 20 * HOUR, NOW, "normal").status).toBe("no_baseline");
    expect(eventSilence(history(4, 24), NOW - 20 * HOUR, NOW, "normal").status).toBe("silent");
    expect(eventSilence(history(7, 24), null, NOW, "normal").status).toBe("no_baseline");
  });

  it("thresholds by sensitivity, scaled up for sparse apps (at most 48 hours)", () => {
    const busy = history(7, 24);
    expect(eventSilence(busy, NOW - 4 * HOUR, NOW, "high")).toMatchObject({ status: "silent", thresholdHours: 3 });
    expect(eventSilence(busy, NOW - 4 * HOUR, NOW, "normal")).toMatchObject({ status: "ok", thresholdHours: 6 });
    expect(eventSilence(busy, NOW - 13 * HOUR, NOW, "low")).toMatchObject({ status: "silent", thresholdHours: 12 });
    // 4 active hours a day: usual gap 6 h → threshold 12 h even on high.
    expect(eventSilence(history(7, 4), NOW - 10 * HOUR, NOW, "high")).toMatchObject({ status: "ok", thresholdHours: 12 });
    expect(eventSilence(history(4, 1), NOW - 47 * HOUR, NOW, "normal")).toMatchObject({ thresholdHours: 48, status: "ok" });
    expect(mostSensitive(["low", "high"])).toBe("high");
    expect(mostSensitive([])).toBe("normal");
  });

  it("counts an active hour when the note moved and forgets days older than 8", () => {
    const old = new Date(NOW - 10 * DAY).toISOString().slice(0, 10);
    const r = eventSilence({ last: NOW - 2 * HOUR, days: { [old]: 3 } }, NOW - 30 * 60_000, NOW, "normal");
    expect(r.changed).toBe(true);
    expect(r.state).toEqual({ last: NOW - 30 * 60_000, days: { "2026-10-20": 1 } });
    const same = eventSilence(r.state, NOW - 30 * 60_000, NOW + HOUR, "normal");
    expect(same.changed).toBe(false);
    expect(same.state.days["2026-10-20"]).toBe(1);
  });
});

describe("funnel alert settings", () => {
  it("validates enabled / sensitivity only, merges over the previous settings", () => {
    expect(parseFunnelAlerts(undefined)).toEqual({ enabled: true, sensitivity: "normal" });
    expect(parseFunnelAlerts({ sensitivity: "high" }, { enabled: false, sensitivity: "low" })).toEqual({ enabled: false, sensitivity: "high" });
    expect(parseFunnelAlerts({ enabled: false })).toEqual({ enabled: false, sensitivity: "normal" });
    expect(parseFunnelAlerts({ sensitivity: "extreme" })).toHaveProperty("error");
    expect(parseFunnelAlerts({ enabled: "yes" })).toHaveProperty("error");
    expect(parseFunnelAlerts({ threshold: 0.1 })).toHaveProperty("error");
    expect(parseFunnelAlerts([])).toHaveProperty("error");
    const f = parseFunnel({ name: "x", steps: [{ name: "a" }, { name: "b" }], alerts: { sensitivity: "low" } });
    expect(f).toMatchObject({ alerts: { enabled: true, sensitivity: "low" } });
  });

  it("the funnel push kind follows funnelAlerts, per app too", () => {
    const msg = (appId: string): PushMessage => ({ kind: "funnel", appId, titleKey: "t", bodyKey: "b" });
    const prefs = { ...DEFAULT_PREFS, pushVersion: 1, appOverrides: { app_a: { muted: true }, app_b: { funnelAlerts: false }, app_c: { funnelAlerts: true } } };
    expect(DEFAULT_PREFS.funnelAlerts).toBe(true);
    expect(wants(prefs, msg("app_a"))).toBe(false);
    expect(wants(prefs, msg("app_b"))).toBe(false);
    expect(wants(prefs, msg("app_d"))).toBe(true);
    expect(wants({ ...prefs, funnelAlerts: false }, msg("app_d"))).toBe(false);
    expect(wants({ ...prefs, funnelAlerts: false }, msg("app_c"))).toBe(true);
    // Funnel alerts are independent of the revenue alerts toggle.
    expect(wants({ ...prefs, alerts: false }, msg("app_d"))).toBe(true);
    // Builds without the funnel alert texts (pushVersion 0, the default) get none: they would show raw loc-keys.
    expect(wants({ ...prefs, pushVersion: 0 }, msg("app_d"))).toBe(false);
    expect(wants(DEFAULT_PREFS, { kind: "alert", titleKey: "t", bodyKey: "b" })).toBe(true);
  });
});

describe("daily digest", () => {
  const day = "2026-10-19";
  const prev = (d: number) => new Date(Date.parse(`${day}T00:00:00Z`) - d * DAY).toISOString();
  const rows = [
    { app: "app_a", day: `${day} 00:00:00`, name: "first_open", events: "1200" },
    { app: "app_a", day: `${day} 00:00:00`, name: "paywall_view", events: 300 },
    ...Array.from({ length: 7 }, (_, i) => ({ app: "app_a", day: prev(i + 1), name: "first_open", events: 1000 })),
    { app: "app_b", day: `${day} 00:00:00`, name: "first_open", events: 10 },
  ];

  it("assembles per-app metrics, totals and top movers", () => {
    const d = assembleDigest({
      workspaceId: "ws_1",
      day,
      apps: [
        { id: "app_a", name: "Party Games" },
        { id: "app_b", name: "Habit Garden" },
        { id: "app_c", name: "Empty" },
      ],
      ledger: [
        { app_id: "app_a", rev: 300, proceeds: 210, new_subs: 12, trials: 46, conversions: 9, prev_rev: 7 * 200 },
        { app_id: "app_b", rev: 5, proceeds: 4, new_subs: 1, trials: 0, conversions: 0, prev_rev: 0 },
      ],
      events: digestEventsOf(rows),
      eventApps: ["app_a", "app_b"],
      at: NOW,
    });
    expect(d.apps.map((a) => a.appId)).toEqual(["app_a", "app_b"]);
    expect(d.apps[0]).toMatchObject({ revenueUsd: 300, proceedsUsd: 210, newSubscriptions: 12, trialsStarted: 46, trialConversions: 9, avgRevenueUsd: 200, installs: 1200, avgInstalls: 1000, paywallViews: 300 });
    expect(d.totals).toMatchObject({ revenueUsd: 305, trialsStarted: 46, installs: 1210, paywallViews: 300 });
    expect(d.movers).toEqual([
      { appId: "app_a", name: "Party Games", metric: "revenue", value: 300, average: 200, change: 0.5 },
      { appId: "app_a", name: "Party Games", metric: "installs", value: 1200, average: 1000, change: expect.closeTo(0.2, 10) },
    ]);
    expect(d.events).toBe(true);
    expect(digestPushLine([d], day)).toEqual({ installs: "1.2K", change: " (+21%)", trials: "46", label: "" });
    expect(changeLabel(80, 100)).toBe("−20%");
    const mail = digestEmail(day, [{ workspaceName: "Apps <&>", currency: "EUR", rate: 0.5, digest: d }], "https://rf.example");
    expect(mail.subject).toBe(`Revflare daily digest · ${day}`);
    expect(mail.text).toContain("Party Games: €150.00 revenue");
    expect(mail.text).toContain("installs 1210");
    expect(mail.html).toContain("Apps &lt;&amp;&gt;");
    expect(mail.html).toContain("Paywall views");
  });

  it("without analytics: no event metrics and no push line", () => {
    const d = assembleDigest({ workspaceId: "ws_1", day, apps: [{ id: "app_a", name: "A" }], ledger: [{ app_id: "app_a", rev: 10, proceeds: 7, new_subs: 1, trials: 2, conversions: 0, prev_rev: 70 }], events: null, eventApps: [], at: NOW });
    expect(d.events).toBe(false);
    expect(d.totals.installs).toBeNull();
    expect(d.apps[0].installs).toBeNull();
    expect(digestPushLine([d], day)).toBeNull();
    expect(digestEmail(day, [{ workspaceName: "W", currency: "USD", rate: 1, digest: d }], "https://rf.example").html).not.toContain("Paywall views");
  });

  it("the push line falls back to the latest digest with event metrics, labelled with its day", () => {
    const ledgerOnly = assembleDigest({ workspaceId: "ws_1", day, apps: [{ id: "app_a", name: "A" }], ledger: [{ app_id: "app_a", rev: 10, proceeds: 7, new_subs: 1, trials: 2, conversions: 0, prev_rev: 70 }], events: null, eventApps: [], at: NOW, eventsPending: true });
    expect(ledgerOnly).toMatchObject({ events: false, eventsPending: true });
    const older = assembleDigest({ workspaceId: "ws_1", day: "2026-10-18", apps: [{ id: "app_a", name: "A" }], ledger: [], events: digestEventsOf(rows.map((r) => ({ ...r, day: r.day.replace(day, "2026-10-18") }))), eventApps: ["app_a"], at: NOW });
    expect(digestPushLine([ledgerOnly, null, older], day)).toMatchObject({ trials: "0", label: "Oct 18: " });
    expect(digestPushLine([null, null], day)).toBeNull();
    expect(dayLabel("2026-10-18", "tr")).toBe("18 Eki: ");
  });

  it("one Analytics Engine query covers a workspace's apps, values allowlisted", () => {
    const sql = digestSql("revflare_events", ["app_a", "app_b"], NOW - 8 * DAY, NOW);
    expect(sql).toContain("index1 IN ('app_a', 'app_b')");
    expect(sql).toContain("blob1 IN ('first_open', 'paywall_view')");
    expect(() => digestSql("revflare_events", ["a' OR 1=1"], 0, 1)).toThrow();
    expect(() => digestSql("revflare_events", [], 0, 1)).toThrow();
    // Production data only (legacy events without blob18 included), the apps' test devices left out.
    expect(sql).toContain("AND (blob18 = 'production' OR double3 < 2)");
    expect(sql).not.toContain("NOT IN");
    const test = "00000000-0000-4000-8000-000000000001";
    expect(digestSql("revflare_events", ["app_a"], NOW - 8 * DAY, NOW, [test])).toContain(`AND blob2 NOT IN ('${test}')`);
  });
});
