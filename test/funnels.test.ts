import { describe, expect, it } from "vitest";
import { COLUMNS, dataPoint, EVENTS_LAYOUT_VERSION, parseBatch, parseEvent, RATE_LIMITS, resetEventsState, takeTokens } from "../worker/lib/events";
import { computeFunnel, median, parseFunnel, parseReportQuery, parseWindow, reportSteps, type StepData, type StepHit } from "../worker/lib/funnels";
import { analyticsMissing, appScope, filterSql, SqlValueError, sqlInt, sqlString, stepSql, summarySql, testFilterSql } from "../worker/lib/wae";
import { EVENT_NAME_RE, type FunnelStep } from "../shared/types";

const NOW = Date.UTC(2026, 9, 20, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const INSTALL = "6f1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a";
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("event ingest validation", () => {
  const ev = (over: Record<string, unknown> = {}) => ({ id: uuid(1), name: "paywall_view", ts: NOW - MIN, sessionId: uuid(9), props: { placement: "onboarding" }, ...over });

  it("accepts a valid event and normalizes props", () => {
    expect(parseEvent(ev({ props: { placement: "onboarding", step: 2, pro: true, gone: null } }), NOW)).toEqual({
      id: uuid(1),
      name: "paywall_view",
      ts: NOW - MIN,
      sessionId: uuid(9),
      props: { placement: "onboarding", step: "2", pro: "true" },
    });
    expect(parseEvent(ev({ sessionId: undefined, props: undefined }), NOW)).toMatchObject({ sessionId: "", props: {} });
  });

  it("drops invalid events", () => {
    for (const bad of [
      ev({ name: "has space" }),
      ev({ name: "x".repeat(65) }),
      ev({ name: "" }),
      ev({ name: "a'b" }),
      ev({ id: "" }),
      ev({ id: "x".repeat(65) }),
      ev({ ts: "yesterday" }),
      ev({ ts: NOW - 8 * DAY }),
      ev({ ts: NOW + 2 * HOUR }),
      ev({ sessionId: "bad id" }),
      ev({ props: [1] }),
      ev({ props: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])) }),
      ev({ props: { "bad key": "v" } }),
      ev({ props: { k: "x".repeat(101) } }),
      ev({ props: { k: { nested: true } } }),
      "string",
      null,
    ])
      expect(parseEvent(bad, NOW), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    // Edges are kept: 7 days old, 1 hour ahead, 10 props, 100 characters.
    expect(parseEvent(ev({ ts: NOW - 7 * DAY }), NOW)).not.toBeNull();
    expect(parseEvent(ev({ ts: NOW + HOUR }), NOW)).not.toBeNull();
    expect(parseEvent(ev({ props: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "v".repeat(100)])) }), NOW)).not.toBeNull();
  });

  it("validates the envelope, counts dropped events and duplicates", () => {
    expect(parseBatch(null, NOW)).toMatchObject({ status: 400 });
    expect(parseBatch({ installId: "nope", events: [] }, NOW)).toMatchObject({ status: 400 });
    expect(parseBatch({ installId: INSTALL, events: "x" }, NOW)).toMatchObject({ status: 400 });
    expect(parseBatch({ installId: INSTALL, events: Array.from({ length: 201 }, (_, i) => ev({ id: uuid(i) })) }, NOW)).toMatchObject({ status: 413 });
    const b = parseBatch({ installId: INSTALL.toUpperCase(), appVersion: "1.0", appBuild: "7", osVersion: "18.1", locale: "en_US", events: [ev(), ev(), ev({ id: uuid(2), name: "bad name" }), ev({ id: uuid(3) })] }, NOW);
    if ("error" in b) throw new Error(b.error);
    expect(b.installId).toBe(INSTALL);
    expect(b.events.map((e) => e.id)).toEqual([uuid(1), uuid(3)]);
    expect(b.dropped).toBe(2);
  });

  it("writes the documented data point layout", () => {
    const b = parseBatch({ installId: INSTALL, appVersion: "1.2", appBuild: "42", osVersion: "18.1", locale: "en_US", events: [ev({ props: { placement: "onboarding", step: "3", color: "blue" } })] }, NOW);
    if ("error" in b) throw new Error(b.error);
    const p = dataPoint({ id: "app_1", workspaceId: "ws_1" }, b, b.events[0], "TR", NOW);
    expect(p.indexes).toEqual(["app_1"]);
    expect(p.blobs).toEqual(["paywall_view", INSTALL, uuid(9), "1.2", "42", "18.1", "TR", "en_US", uuid(1), "ws_1", '{"placement":"onboarding","step":"3","color":"blue"}', "onboarding", "", "", "3", "", "", "production"]);
    expect(p.doubles).toEqual([NOW - MIN, NOW, 2]);
    expect(EVENTS_LAYOUT_VERSION).toBe(2);
    expect(p.blobs!.length).toBeLessThanOrEqual(20);
  });

  it("writes the build's environment to blob18 (missing or invalid = production)", () => {
    for (const [sent, stored] of [
      ["sandbox", "sandbox"],
      ["xcode", "xcode"],
      ["production", "production"],
      [undefined, "production"],
      ["staging", "production"],
      [7, "production"],
    ] as const) {
      const b = parseBatch({ installId: INSTALL, environment: sent, events: [ev()] }, NOW);
      if ("error" in b) throw new Error(b.error);
      expect(b.environment).toBe(stored);
      expect(dataPoint({ id: "app_1", workspaceId: "ws_1" }, b, b.events[0], "TR", NOW).blobs![17]).toBe(stored);
    }
    expect(COLUMNS.environment).toBe("blob18");
  });

  it("rate limits per install with a retry delay", () => {
    resetEventsState();
    expect(takeTokens("app_rl", INSTALL, RATE_LIMITS.install.capacity, NOW)).toEqual({ ok: true });
    const r = takeTokens("app_rl", INSTALL, 10, NOW);
    expect(r).toEqual({ ok: false, retryAfter: Math.ceil(10 / RATE_LIMITS.install.perSecond) });
    expect(takeTokens("app_rl", uuid(5), 10, NOW)).toEqual({ ok: true });
    expect(takeTokens("app_rl", INSTALL, 10, NOW + 5_000)).toEqual({ ok: true });
  });
});

describe("Analytics Engine SQL building", () => {
  it("only interpolates allow-listed values", () => {
    expect(sqlString("paywall_view", EVENT_NAME_RE)).toBe("'paywall_view'");
    for (const bad of ["x' OR 1=1 --", "a\\'b", "a'", "", "x\ny", 5, null]) expect(() => sqlString(bad, EVENT_NAME_RE)).toThrow(SqlValueError);
    // Even a permissive pattern cannot let quotes or backslashes through.
    expect(() => sqlString("it's", /.*/)).toThrow(SqlValueError);
    expect(() => sqlString('a"b', /.*/)).toThrow(SqlValueError);
    expect(sqlInt(12.9)).toBe("12");
    for (const bad of [NaN, Infinity, "1; DROP", "1"]) expect(() => sqlInt(bad)).toThrow(SqlValueError);
    expect(() => appScope("app' OR '1'='1", 0, 1)).toThrow(SqlValueError);
    expect(appScope("app_1", 1_000_000, 2_000_000)).toBe("index1 = 'app_1' AND timestamp >= toDateTime(1000) AND timestamp < toDateTime(2000) AND (blob18 = 'production' OR double3 < 2)");
  });

  it("filters test data: production and legacy rows by default, test devices out, everything with includeTest", () => {
    const base = "index1 = 'app_1' AND timestamp >= toDateTime(1000) AND timestamp < toDateTime(2000)";
    // Default: production events and events stored before layout 2 (no blob18: '').
    expect(appScope("app_1", 1_000_000, 2_000_000, {})).toBe(`${base} AND (blob18 = 'production' OR double3 < 2)`);
    expect(appScope("app_1", 1_000_000, 2_000_000, { excludedInstalls: [] })).toBe(`${base} AND (blob18 = 'production' OR double3 < 2)`);
    // Test devices: NOT IN list of install ids.
    expect(appScope("app_1", 1_000_000, 2_000_000, { excludedInstalls: [uuid(1), uuid(2)] })).toBe(
      `${base} AND (blob18 = 'production' OR double3 < 2) AND blob2 NOT IN ('${uuid(1)}', '${uuid(2)}')`,
    );
    // includeTest removes both.
    expect(appScope("app_1", 1_000_000, 2_000_000, { includeTest: true, excludedInstalls: [uuid(1)] })).toBe(base);
    expect(testFilterSql({ includeTest: true })).toBe("");
    // Only install ids (UUIDs) are interpolated.
    for (const bad of ["x' OR '1'='1", "not-a-uuid", uuid(1).toUpperCase() + "'"]) expect(() => appScope("app_1", 0, 1, { excludedInstalls: [bad] })).toThrow(SqlValueError);
    // Every query built on appScope carries the filter.
    const step = stepSql("revflare_events", { appId: "app_1", name: "paywall_view", fromMs: NOW - DAY, toMs: NOW, limit: 10, test: { excludedInstalls: [uuid(3)] } });
    expect(step).toContain(`AND (blob18 = 'production' OR double3 < 2) AND blob2 NOT IN ('${uuid(3)}')`);
    expect(stepSql("revflare_events", { appId: "app_1", name: "paywall_view", fromMs: NOW - DAY, toMs: NOW, limit: 10, test: { includeTest: true } })).not.toContain("blob18");
    const s = summarySql("revflare_events", "app_1", NOW - DAY, NOW, { excludedInstalls: [uuid(4)] });
    for (const q of [s.top, s.daily, s.totals]) expect(q).toContain(`AND (blob18 = 'production' OR double3 < 2) AND blob2 NOT IN ('${uuid(4)}')`);
    for (const q of Object.values(summarySql("revflare_events", "app_1", NOW - DAY, NOW, { includeTest: true }))) expect(q).not.toContain("blob18");
  });

  it("filters promoted props by column and others inside the props JSON", () => {
    expect(filterSql({ key: "placement", value: "onboarding" })).toBe("blob12 = 'onboarding'");
    expect(filterSql({ key: "step", value: "1" })).toBe("blob15 = '1'");
    expect(filterSql({ key: "color", value: "blue sky" })).toBe(`position('"color":"blue sky"' IN blob11) > 0`);
    for (const bad of [
      { key: "color", value: "x' OR '1'='1" },
      { key: "color", value: 'a"b' },
      { key: "color", value: "a\\b" },
      { key: "bad key", value: "x" },
      { key: "k')--", value: "x" },
    ])
      expect(() => filterSql(bad), JSON.stringify(bad)).toThrow(SqlValueError);
  });

  it("builds scoped step and summary queries", () => {
    const sql = stepSql("revflare_events", { appId: "app_1", name: "paywall_view", filters: [{ key: "placement", value: "onboarding" }], fromMs: NOW - DAY, toMs: NOW, breakdown: "country", limit: 50_001 });
    expect(sql).toContain("FROM revflare_events WHERE index1 = 'app_1'");
    expect(sql).toContain("blob1 = 'paywall_view'");
    expect(sql).toContain("blob12 = 'onboarding'");
    expect(sql).toContain(`double1 >= ${NOW - DAY} AND double1 < ${NOW}`);
    expect(sql).toContain("argMin(blob7, double1) AS b");
    expect(sql).toMatch(/GROUP BY install ORDER BY first ASC LIMIT 50001$/);
    expect(() => stepSql("revflare_events; DROP", { appId: "app_1", name: "x", fromMs: 0, toMs: 1, limit: 1 })).toThrow(SqlValueError);
    expect(() => stepSql("revflare_events", { appId: "app_1", name: "x' --", fromMs: 0, toMs: 1, limit: 1 })).toThrow(SqlValueError);
    expect(() => stepSql("revflare_events", { appId: "app_1", name: "x", fromMs: 0, toMs: 1, limit: 1, breakdown: "blob1) --" as never })).toThrow(SqlValueError);
    const s = summarySql("revflare_events", "app_1", NOW - DAY, NOW);
    for (const q of [s.top, s.daily, s.totals]) expect(q).toContain("WHERE index1 = 'app_1' AND timestamp >=");
    expect(s.top).toContain("sum(_sample_interval) AS events");
  });
});

describe("funnel definitions", () => {
  const steps = [{ type: "event", name: "onboarding_step", filters: [{ key: "step", value: "1" }] }, { type: "event", name: "paywall_view" }, { type: "revenue", kind: "trial_started" }];

  it("validates and defaults", () => {
    expect(parseFunnel({ name: " Onboarding ", steps })).toEqual({ name: "Onboarding", steps, windowSeconds: 7 * 86_400, ordered: true, alerts: { enabled: true, sensitivity: "normal" } });
    expect(parseFunnel({ name: "x", steps, window: "1h", ordered: false })).toMatchObject({ windowSeconds: 3600, ordered: false });
    expect(parseFunnel({ name: "x", steps: [{ name: "a", filters: { step: 1 } }, { name: "b" }] })).toMatchObject({ steps: [{ type: "event", name: "a", filters: [{ key: "step", value: "1" }] }, { type: "event", name: "b" }] });
    for (const [bad, msg] of [
      [{ steps }, "name"],
      [{ name: "x", steps: steps.slice(0, 1) }, "2 to 10"],
      [{ name: "x", steps: Array.from({ length: 11 }, () => steps[1]) }, "2 to 10"],
      [{ name: "x", steps: [steps[2], steps[1]] }, "Step 1 must be an event"],
      [{ name: "x", steps: [steps[0], { type: "revenue", kind: "refund" }] }, "kind"],
      [{ name: "x", steps: [steps[0], { type: "event", name: "bad name" }] }, "Step 2"],
      [{ name: "x", steps: [{ type: "event", name: "a", filters: [{ key: "k", value: "x' OR 1=1" }] }, steps[1]] }, "filter"],
      [{ name: "x", steps, window: "forever" }, "window"],
      [{ name: "x", steps, window: "30s" }, "window"],
      [{ name: "x", steps, window: "100d" }, "between"],
      [{ name: "x", steps, ordered: "yes" }, "ordered"],
    ] as const) {
      const r = parseFunnel(bad);
      expect("error" in r && r.error, JSON.stringify(bad).slice(0, 80)).toContain(msg);
    }
    expect(parseWindow("30d")).toBe(30 * 86_400);
    expect(parseWindow("2w")).toBe(14 * 86_400);
  });

  it("merges a PATCH over the stored definition", () => {
    const prev = parseFunnel({ name: "x", steps, window: "1d" });
    if ("error" in prev) throw new Error(prev.error);
    expect(parseFunnel({ name: "y" }, prev)).toEqual({ ...prev, name: "y" });
    expect(parseFunnel({ window: "7d" }, prev)).toMatchObject({ windowSeconds: 7 * 86_400 });
  });

  it("parses report ranges", () => {
    expect(parseReportQuery({ range: "7d" }, NOW)).toEqual({ from: "2026-10-14", to: "2026-10-20", breakdown: null });
    expect(parseReportQuery({ from: "2026-10-01", to: "2026-10-30", breakdown: "country" }, NOW)).toEqual({ from: "2026-10-01", to: "2026-10-20", breakdown: "country" });
    expect(parseReportQuery({ breakdown: "blob1" }, NOW)).toHaveProperty("error");
    expect(parseReportQuery({ from: "2026-01-01", to: "2026-10-20" }, NOW)).toHaveProperty("error");
    expect(parseReportQuery({ from: "x" }, NOW)).toHaveProperty("error");
  });
});

describe("funnel computation", () => {
  const data = (rows: Record<string, Partial<StepHit> & { first: number }>): StepData =>
    new Map(Object.entries(rows).map(([k, v]) => [k, { last: v.first, n: 1, ...v }]));
  const T = NOW - 10 * DAY;

  it("counts ordered conversion within the window", async () => {
    const r = await computeFunnel(
      [
        data({ a: { first: T }, b: { first: T }, c: { first: T }, d: { first: T + HOUR } }),
        // a: 1 min later; b: 2 h later (outside a 1 h window); c: before step 1 only; d: 30 min later.
        data({ a: { first: T + MIN }, b: { first: T + 2 * HOUR }, c: { first: T - MIN }, d: { first: T + HOUR + 30 * MIN } }),
        data({ a: { first: T + 2 * MIN }, d: { first: T + HOUR + 20 * MIN } }),
      ],
      { windowMs: HOUR, ordered: true },
    );
    expect(r.steps.map((s) => s.users)).toEqual([4, 2, 1]);
    expect([...r.steps[1].deltas].sort((x, y) => x - y)).toEqual([MIN, 30 * MIN]);
    // d did step 3 before step 2: not converted when ordered.
    expect(r.steps[2].deltas).toEqual([MIN]);
    const steps = reportSteps({ steps: [{ type: "event", name: "a" }, { type: "event", name: "b" }, { type: "revenue", kind: "paid" }] as FunnelStep[] }, r.steps);
    expect(steps).toEqual([
      { index: 0, label: "a", users: 4, conversionFromPrevious: 1, conversionFromFirst: 1, dropOff: 0, medianSecondsFromPrevious: null },
      { index: 1, label: "b", users: 2, conversionFromPrevious: 0.5, conversionFromFirst: 0.5, dropOff: 2, medianSecondsFromPrevious: (MIN + 30 * MIN) / 2 / 1000 },
      { index: 2, label: "Paid", users: 1, conversionFromPrevious: 0.5, conversionFromFirst: 0.25, dropOff: 1, medianSecondsFromPrevious: 60 },
    ]);
  });

  it("unordered funnels accept later steps in any order after the first", async () => {
    const r = await computeFunnel(
      [data({ d: { first: T } }), data({ d: { first: T + 30 * MIN } }), data({ d: { first: T + 10 * MIN } })],
      { windowMs: HOUR, ordered: false },
    );
    expect(r.steps.map((s) => s.users)).toEqual([1, 1, 1]);
    expect(r.steps[2].deltas).toEqual([10 * MIN]);
  });

  it("uses the last occurrence when the first is before the previous step", async () => {
    const r = await computeFunnel(
      [
        data({ a: { first: T }, b: { first: T } }),
        data({ a: { first: T - DAY, last: T + MIN, n: 2 }, b: { first: T - DAY, last: T + 5 * MIN, n: 7 } }),
      ],
      { windowMs: HOUR, ordered: true },
    );
    expect(r.steps[1].users).toBe(2);
    expect(r.inferred).toBe(1);
  });

  it("asks revenue steps only for the installs still in the funnel and splits by breakdown", async () => {
    const asked: string[][] = [];
    const r = await computeFunnel(
      [
        data({ a: { first: T, b: "1.0" }, b: { first: T, b: "1.1" }, c: { first: T, b: "1.1" } }),
        data({ a: { first: T + MIN }, b: { first: T + MIN } }),
        async (installs) => {
          asked.push(installs.sort());
          return data({ b: { first: T + 3 * DAY }, c: { first: T + MIN } });
        },
      ],
      { windowMs: 7 * DAY, ordered: true },
    );
    expect(asked).toEqual([["a", "b"]]);
    expect(r.steps.map((s) => s.users)).toEqual([3, 2, 1]);
    expect(r.groups.get("1.1")!.map((s) => s.users)).toEqual([2, 1, 1]);
    expect(r.groups.get("1.0")!.map((s) => s.users)).toEqual([1, 1, 0]);
  });

  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("analytics configuration", () => {
  it("says what is missing", () => {
    const none = analyticsMissing({} as Env);
    expect(none).toMatchObject({ ingest: false, query: false });
    expect(none.missing.join("\n")).toMatch(/EVENTS.*\n.*CF_ACCOUNT_ID.*\n.*CF_ANALYTICS_TOKEN/s);
    const bad = analyticsMissing({ CF_ACCOUNT_ID: "nope", CF_ANALYTICS_TOKEN: "t" } as Env);
    expect(bad.query).toBe(false);
    const ok = analyticsMissing({ EVENTS: { writeDataPoint() {} }, CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CF_ANALYTICS_TOKEN: "t" } as unknown as Env);
    expect(ok).toEqual({ ingest: true, query: true, missing: [] });
  });
});
