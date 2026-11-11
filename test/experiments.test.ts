import { describe, expect, it } from "vitest";
import { beta, compareRates, rng, seedOf } from "../worker/lib/experiment-stats";
import { exposureSql, guardrails, parseExperiment, snapshotSql } from "../worker/lib/experiments";
import { assignVariant, compile, evaluate, experimentConflict, parseRemoteConfig, percentBucket, sdkBody, type ActiveExperiment, type StoredRemoteConfig } from "../worker/lib/remote-config";

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function cfg(body: unknown): StoredRemoteConfig {
  const r = parseRemoteConfig(body);
  if ("error" in r) throw new Error(r.error);
  return r;
}

const CONFIG = cfg({
  conditions: [
    { name: "china", rules: [{ type: "country", values: ["CN"] }] },
    { name: "half", rules: [{ type: "percent", from: 0, to: 50 }] },
    { name: "imported", rules: [], unsupported: true, expression: "app.userProperty['x'] == 'y'" },
  ],
  parameters: [
    { key: "paywall_variant", type: "string", defaultValue: "classic", conditionalValues: { china: "cn" } },
    { key: "price_test", type: "number", defaultValue: 1 },
    { key: "legacy", type: "boolean", useInAppDefault: true },
  ],
});

const EXP = {
  name: "Paywall test",
  keys: ["paywall_variant"],
  variants: [
    { name: "Control", weight: 50 },
    { name: "New", weight: 50, values: { paywall_variant: "new" } },
  ],
};

function parsed(body: Record<string, unknown>) {
  const r = parseExperiment(body, CONFIG);
  if ("error" in r) throw new Error(r.error);
  return r;
}

const active = (id: string, body: Record<string, unknown>): ActiveExperiment => {
  const p = parsed(body);
  return { id, keys: p.def.keys, types: p.def.types, variants: p.def.variants, targeting: p.def.targeting, traffic: p.def.traffic };
};

describe("experiment validation", () => {
  it("accepts a valid experiment with defaults (ids, metric, traffic) and typed values", () => {
    const p = parsed({ ...EXP, keys: ["paywall_variant", "price_test"], variants: [{}, { values: { paywall_variant: "new", price_test: "2" } }] });
    expect(p.def.variants.map((v) => [v.id, v.name, v.weight])).toEqual([
      ["a", "Control", 50],
      ["b", "Variant B", 50],
    ]);
    expect(p.def.variants[1].values).toEqual({ paywall_variant: "new", price_test: 2 });
    expect(p.def.types).toEqual({ paywall_variant: "string", price_test: "number" });
    expect(p.def).toMatchObject({ traffic: 100, primaryMetric: "paid", targeting: null });
    const three = parsed({ ...EXP, variants: [{}, { values: { paywall_variant: "x" } }, { values: { paywall_variant: "y" } }] });
    expect(three.def.variants.reduce((s, v) => s + v.weight, 0)).toBeCloseTo(100, 9);
  });

  it("refuses unknown keys, wrong types, bad weights, missing values, unknown or unsupported targeting", () => {
    const err = (body: Record<string, unknown>) => {
      const r = parseExperiment(body, CONFIG);
      return "error" in r ? r.error : null;
    };
    expect(err({ ...EXP, keys: ["nope"] })).toContain('"nope" does not exist');
    expect(err({ ...EXP, keys: ["price_test"], variants: [{}, { values: { price_test: "cheap" } }] })).toContain("expected a finite number");
    expect(err({ ...EXP, variants: [{ weight: 60 }, { weight: 50, values: { paywall_variant: "x" } }] })).toContain("sum to 100");
    expect(err({ ...EXP, variants: [{ weight: 50 }, { weight: 50 }] })).toContain('needs a value for "paywall_variant"');
    expect(err({ ...EXP, variants: [{}, { id: "c", values: { paywall_variant: "x" } }] })).toContain('must have id "b"');
    expect(err({ ...EXP, variants: [{}] })).toContain("2 to 5 variants");
    expect(err({ ...EXP, variants: [{}, { values: { paywall_variant: "x", price_test: 2 } }] })).toContain("not one of the experiment's keys");
    expect(err({ ...EXP, targeting: "nowhere" })).toContain("does not exist");
    expect(err({ ...EXP, targeting: "imported" })).toContain("never matches");
    expect(err({ ...EXP, traffic: 0 })).toContain("traffic");
    expect(err({ ...EXP, primaryMetric: "ltv" })).toContain("primaryMetric");
    expect(err({ ...EXP, name: " " })).toBe("name is required");
  });

  it("blocks config changes that would break an active experiment", () => {
    const x = active("exp_1", { ...EXP, targeting: "china" });
    expect(experimentConflict(CONFIG, [x])).toBeNull();
    expect(experimentConflict({ ...CONFIG, parameters: CONFIG.parameters.slice(1) }, [x])).toContain('"paywall_variant" is used by experiment exp_1');
    expect(experimentConflict({ ...CONFIG, parameters: CONFIG.parameters.map((p) => (p.key === "paywall_variant" ? { ...p, type: "json" as const } : p)) }, [x])).toContain("must stay string");
    expect(experimentConflict({ ...CONFIG, conditions: CONFIG.conditions.slice(1), parameters: CONFIG.parameters.map((p) => ({ ...p, conditionalValues: {} })) }, [x])).toContain('Condition "china"');
  });
});

describe("assignment", () => {
  it("is deterministic and follows the weights and the traffic share", async () => {
    const x = { id: "exp_abc", traffic: 40, variants: [{ id: "a", weight: 25 }, { id: "b", weight: 75 }] };
    const counts: Record<string, number> = { a: 0, b: 0, none: 0 };
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const v = await assignVariant(uuid(i), x);
      counts[v ?? "none"]++;
      if (i < 50) expect(await assignVariant(uuid(i).toUpperCase(), x)).toBe(v);
      // Enrolment is exactly the bucket below the traffic share.
      const b = await percentBucket(uuid(i), "exp_abc");
      expect(v === null).toBe(b >= 40);
    }
    expect(counts.none / N).toBeGreaterThan(0.56);
    expect(counts.none / N).toBeLessThan(0.64);
    const enrolled = counts.a + counts.b;
    expect(counts.a / enrolled).toBeGreaterThan(0.21);
    expect(counts.a / enrolled).toBeLessThan(0.29);
    // Another experiment id buckets independently.
    let same = 0;
    for (let i = 0; i < 400; i++) if ((await percentBucket(uuid(i), "exp_abc")) < 50 === (await percentBucket(uuid(i), "exp_other")) < 50) same++;
    expect(same / 400).toBeGreaterThan(0.4);
    expect(same / 400).toBeLessThan(0.6);
    expect(await assignVariant("", x)).toBeNull();
  });

  it("overrides values for enrolled devices only, honours targeting and reports experiments in the SDK body", async () => {
    const x = active("exp_paywall1", { ...EXP, targeting: "china", keys: ["paywall_variant", "legacy"], variants: [{}, { values: { paywall_variant: "new", legacy: true } }] });
    const compiled = JSON.parse(JSON.stringify(compile(CONFIG, [x])));
    expect(compiled.experiments).toEqual([{ id: "exp_paywall1", keys: ["paywall_variant", "legacy"], cond: 0, traffic: 100, variants: x.variants.map(({ id, weight, values }) => ({ id, weight, values })) }]);
    const plain = await evaluate(compile(CONFIG), { installId: uuid(1), storefront: "CN" });

    let seenA = false;
    let seenB = false;
    for (let i = 0; i < 40; i++) {
      const cn = await evaluate(compiled, { installId: uuid(i), storefront: "CN" });
      const variant = await assignVariant(uuid(i), x);
      expect(cn.experiments).toEqual([{ id: "exp_paywall1", variant, keys: ["paywall_variant", "legacy"] }]);
      if (variant === "a") {
        seenA = true;
        // The control keeps what the device gets anyway (the china value; legacy stays the in-app default).
        expect(cn.values).toEqual({ paywall_variant: "cn", price_test: 1 });
        expect(cn.parameters.paywall_variant).toEqual({ condition: "china", useInAppDefault: false, value: "cn" });
      } else {
        seenB = true;
        expect(cn.values).toEqual({ paywall_variant: "new", price_test: 1, legacy: true });
        expect(cn.parameters.paywall_variant).toEqual({ condition: null, useInAppDefault: false, value: "new", experiment: "exp_paywall1", variant: "b" });
      }
      expect(sdkBody(cn)).toEqual({ version: cn.version, values: cn.values, conditions: ["china", ...cn.conditions.slice(1)], country: "CN", experiments: cn.experiments });
      // Outside the targeting condition: normal values, no experiments key, same version as without experiments.
      const us = await evaluate(compiled, { installId: uuid(i), storefront: "US" });
      expect(us.experiments).toBeUndefined();
      expect(Object.keys(sdkBody(us))).toEqual(["version", "values", "conditions", "country"]);
      expect(us.version).toBe((await evaluate(compile(CONFIG), { installId: uuid(i), storefront: "US" })).version);
    }
    expect(seenA && seenB).toBe(true);
    // No install id: never enrolled.
    expect((await evaluate(compiled, { storefront: "CN" })).experiments).toBeUndefined();
    expect(plain.experiments).toBeUndefined();
  });

  it("targets with percent conditions independently of the experiment's own bucket", async () => {
    const x = active("exp_half", { ...EXP, targeting: "half", traffic: 100 });
    const compiled = compile(CONFIG, [x]);
    let enrolled = 0;
    for (let i = 0; i < 400; i++) {
      const e = await evaluate(compiled, { installId: uuid(i) });
      const inHalf = e.conditions.includes("half");
      expect(!!e.experiments).toBe(inHalf);
      if (inHalf) enrolled++;
    }
    expect(enrolled / 400).toBeGreaterThan(0.4);
    expect(enrolled / 400).toBeLessThan(0.6);
  });
});

describe("statistics", () => {
  it("draws Beta variates with the right mean and is seeded", () => {
    const r = rng(42);
    let s = 0;
    for (let i = 0; i < 20000; i++) s += beta(3, 7, r);
    expect(s / 20000).toBeCloseTo(0.3, 2);
    expect(rng(7)()).toBe(rng(7)());
    expect(seedOf("exp_a")).not.toBe(seedOf("exp_b"));
  });

  it("gives probability to be best and lift intervals", () => {
    const clear = compareRates(
      [
        { n: 1000, x: 100 },
        { n: 1000, x: 150 },
      ],
      { seed: 1 },
    );
    expect(clear.probabilityBest[1]).toBeGreaterThan(0.99);
    expect(clear.probabilityBest[0] + clear.probabilityBest[1]).toBeCloseTo(1, 9);
    expect(clear.lift[0]).toBeNull();
    expect(clear.lift[1]!.expected).toBeGreaterThan(0.4);
    expect(clear.lift[1]!.expected).toBeLessThan(0.6);
    expect(clear.lift[1]!.low).toBeGreaterThan(0.15);
    expect(clear.lift[1]!.high).toBeGreaterThan(clear.lift[1]!.expected);

    const tie = compareRates(
      [
        { n: 500, x: 50 },
        { n: 500, x: 50 },
        { n: 500, x: 50 },
      ],
      { seed: 3 },
    );
    for (const p of tie.probabilityBest) expect(Math.abs(p - 1 / 3)).toBeLessThan(0.03);
    expect(tie.lift[1]!.low).toBeLessThan(0);
    expect(tie.lift[1]!.high).toBeGreaterThan(0);
    // Same data, same seed: same answer.
    expect(compareRates([{ n: 10, x: 1 }, { n: 10, x: 3 }], { seed: 9 })).toEqual(compareRates([{ n: 10, x: 1 }, { n: 10, x: 3 }], { seed: 9 }));
  });

  it("applies the guardrails", () => {
    const ok = [
      { exposed: 150, trials: 20, paid: 6 },
      { exposed: 140, trials: 25, paid: 5 },
    ];
    expect(guardrails(8, ok, "paid")).toEqual([]);
    expect(guardrails(8, ok, "trial_started")).toEqual([]);
    expect(guardrails(3.5, ok, "paid")).toEqual(["Running for 3 of at least 7 days."]);
    expect(guardrails(8, [ok[0], { exposed: 99, trials: 0, paid: 0 }], "paid")).toEqual(["1 variant has fewer than 100 exposed installs.", "6 of at least 10 paid conversions in total."]);
  });
});

describe("Analytics Engine SQL", () => {
  it("filters exposures by the promoted variant column and refuses unsafe ids", () => {
    const sql = exposureSql("revflare_events", "app_1", "exp_ab12", "b", 0, 3_600_000, 50_001);
    expect(sql).toContain("blob1 = 'experiment_exposure'");
    expect(sql).toContain("blob17 = 'exp_ab12:b'");
    expect(sql).toContain("LIMIT 50001");
    expect(snapshotSql("revflare_events", "app_1", "exp_ab12", ["a", "b"], 0, 3_600_000)).toContain("blob17 IN ('exp_ab12:a', 'exp_ab12:b')");
    expect(() => exposureSql("revflare_events", "app_1", "exp_x'; DROP", "b", 0, 1, 1)).toThrow();
  });

  it("always counts production data from other devices than the test ones", () => {
    const test = "00000000-0000-4000-8000-000000000001";
    for (const sql of [exposureSql("revflare_events", "app_1", "exp_ab12", "b", 0, 3_600_000, 10, [test]), snapshotSql("revflare_events", "app_1", "exp_ab12", ["a", "b"], 0, 3_600_000, [test])]) {
      expect(sql).toContain("AND (blob18 = 'production' OR double3 < 2)");
      expect(sql).toContain(`AND blob2 NOT IN ('${test}')`);
    }
    expect(exposureSql("revflare_events", "app_1", "exp_ab12", "b", 0, 3_600_000, 10)).toContain("AND (blob18 = 'production' OR double3 < 2)");
  });
});
