import { describe, expect, it } from "vitest";
import {
  compareVersions,
  compile,
  convertFirebaseCondition,
  convertFirebaseTemplate,
  deviceContext,
  evaluate,
  mergeConfigs,
  parseRemoteConfig,
  percentBucket,
  type StoredRemoteConfig,
} from "../worker/lib/remote-config";

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function cfg(body: unknown): StoredRemoteConfig {
  const r = parseRemoteConfig(body);
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("remote config validation", () => {
  it("accepts a typed config, normalizes rules and coerces string numbers / booleans", () => {
    const c = cfg({
      conditions: [
        { name: "china", color: "BLUE", rules: [{ type: "country", values: ["cn", "CHN", "HK"] }] },
        { name: "new app", rules: [{ type: "app_version", op: ">=", value: "2.1" }, { type: "language", values: ["zh-Hans", "TR"] }] },
        { name: "rollout", rules: [{ type: "percent", to: 20 }] },
      ],
      parameters: {
        onboarding_version: { type: "string", defaultValue: "v2", conditionalValues: { china: "v1" } },
        max_free_accounts: { type: "number", defaultValue: "1" },
        show_discounted_paywall: { type: "boolean", defaultValue: "false", conditionalValues: { rollout: true, china: { useInAppDefault: true } } },
        paywall: { type: "json", defaultValue: { title: "Go Pro" }, description: "Paywall texts" },
        legacy: { type: "string", useInAppDefault: true },
      },
    });
    expect(c.conditions[0]).toEqual({ name: "china", color: "blue", rules: [{ type: "country", values: ["CN", "HK"] }] });
    expect(c.conditions[1].rules[1]).toEqual({ type: "language", values: ["zh_hans", "tr"] });
    expect(c.conditions[2].rules[0]).toEqual({ type: "percent", from: 0, to: 20 });
    expect(c.parameters.map((p) => [p.key, p.defaultValue])).toEqual([
      ["onboarding_version", "v2"],
      ["max_free_accounts", 1],
      ["show_discounted_paywall", false],
      ["paywall", { title: "Go Pro" }],
      ["legacy", undefined],
    ]);
    expect(c.parameters[2].conditionalValues).toEqual({ rollout: true, china: { useInAppDefault: true } });
    expect(c.parameters[4].useInAppDefault).toBe(true);
  });

  it("rejects invalid configs", () => {
    const ok = { conditions: [{ name: "c", rules: [] }], parameters: [{ key: "k", type: "string", defaultValue: "x" }] };
    for (const [bad, msg] of [
      [{ ...ok, parameters: [{ key: "bad key", type: "string", defaultValue: "x" }] }, "not valid"],
      [{ ...ok, parameters: [{ key: "k", type: "number", defaultValue: "abc" }] }, "finite number"],
      [{ ...ok, parameters: [{ key: "k", type: "number", defaultValue: Infinity }] }, "finite number"],
      [{ ...ok, parameters: [{ key: "k", type: "boolean", defaultValue: "maybe" }] }, "true or false"],
      [{ ...ok, parameters: [{ key: "k", type: "string" }] }, "needs a defaultValue"],
      [{ ...ok, parameters: [{ key: "k", type: "date", defaultValue: "x" }] }, "type must be"],
      [{ ...ok, parameters: [{ key: "k", type: "json", defaultValue: { blob: "x".repeat(33 * 1024) } }] }, "32 KB"],
      [{ ...ok, parameters: [{ key: "k", type: "string", defaultValue: "x", conditionalValues: { ghost: "y" } }] }, 'condition "ghost" does not exist'],
      [{ ...ok, parameters: [ok.parameters[0], ok.parameters[0]] }, "appears twice"],
      [{ ...ok, conditions: [{ name: "c" }, { name: "c" }] }, "appears twice"],
      [{ ...ok, conditions: [{ name: "a/b" }] }, "not valid"],
      [{ ...ok, conditions: [{ name: "c", rules: [{ type: "country", values: ["China"] }] }] }, "country code"],
      [{ ...ok, conditions: [{ name: "c", rules: [{ type: "app_version", op: "~", value: "1" }] }] }, "needs op"],
      [{ ...ok, conditions: [{ name: "c", rules: [{ type: "percent", from: 30, to: 10 }] }] }, "percent"],
      [{ ...ok, conditions: [{ name: "c", rules: [{ type: "weather", values: ["sunny"] }] }] }, "unknown rule type"],
      [{ ...ok, conditions: [{ name: "exp_0a1b2c3d4e5f", rules: [{ type: "percent", to: 50 }] }] }, "reserved"],
      [{ ...ok, conditions: [{ name: "c", rules: [{ type: "percent", to: 50, seed: "exp_0a1b2c3d4e5f" }] }] }, "reserved"],
      [{ ...ok, conditions: Array.from({ length: 51 }, (_, i) => ({ name: `c${i}` })) }, "At most 50 conditions"],
      [{ parameters: Array.from({ length: 301 }, (_, i) => ({ key: `k${i}`, type: "string", defaultValue: "" })) }, "At most 300 parameters"],
      [{ parameters: Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, type: "string", defaultValue: "x".repeat(30_000) })) }, "512 KB"],
      ["nope", "Expected a JSON object"],
    ] as [unknown, string][]) {
      const r = parseRemoteConfig(bad);
      expect("error" in r ? r.error : "accepted", JSON.stringify(bad).slice(0, 100)).toContain(msg);
    }
  });
});

describe("remote config evaluation", () => {
  const config = compile(
    cfg({
      conditions: [
        { name: "testers", rules: [{ type: "install_id", values: [uuid(1)] }] },
        { name: "china", rules: [{ type: "country", values: ["CN"] }] },
        { name: "chinese", rules: [{ type: "language", values: ["zh"] }] },
        { name: "new_and_turkish", rules: [{ type: "app_version", op: ">=", value: "2.9" }, { type: "locale", values: ["tr_TR"] }] },
        { name: "vpn", rules: [{ type: "ip_country", values: ["US"] }, { type: "storefront", values: ["CN"] }] },
      ],
      parameters: [
        { key: "onboarding_version", type: "string", defaultValue: "v2", conditionalValues: { china: "v1", testers: "beta" } },
        { key: "greeting", type: "string", defaultValue: "hello", conditionalValues: { chinese: "ni hao", new_and_turkish: "merhaba" } },
        { key: "max_free_accounts", type: "number", defaultValue: 1, conditionalValues: { china: { useInAppDefault: true } } },
        { key: "legacy", type: "boolean", useInAppDefault: true, conditionalValues: { vpn: true } },
      ],
    }),
  );

  it("country comes from the storefront, else the request's country", async () => {
    const sf = await evaluate(config, deviceContext({ storefront: "CN" }, "US"));
    expect(sf.country).toBe("CN");
    expect(sf.values.onboarding_version).toBe("v1");
    expect(sf.conditions).toEqual(["china", "vpn"]);
    expect(sf.values.legacy).toBe(true);
    const cf = await evaluate(config, deviceContext({}, "CN"));
    expect(cf.country).toBe("CN");
    expect(cf.values.onboarding_version).toBe("v1");
    expect(cf.conditions).toEqual(["china"]);
    expect("legacy" in cf.values).toBe(false);
    const alpha3 = await evaluate(config, deviceContext({ storefront: "CHN" }, null));
    expect(alpha3.country).toBe("CN");
    const none = await evaluate(config, deviceContext({ storefront: "XX" }, "T1"));
    expect(none.country).toBeNull();
    expect(none.values).toEqual({ onboarding_version: "v2", greeting: "hello", max_free_accounts: 1 });
  });

  it("first matching condition in priority order wins; useInAppDefault omits the key", async () => {
    const r = await evaluate(config, deviceContext({ installId: uuid(1).toUpperCase(), storefront: "CN" }, null));
    expect(r.values.onboarding_version).toBe("beta");
    expect(r.parameters.onboarding_version).toEqual({ condition: "testers", useInAppDefault: false, value: "beta" });
    expect("max_free_accounts" in r.values).toBe(false);
    expect(r.parameters.max_free_accounts).toEqual({ condition: "china", useInAppDefault: true });
    expect(r.parameters.greeting).toEqual({ condition: null, useInAppDefault: false, value: "hello" });
  });

  it("language, locale and semantic versions (2.10 > 2.9), all rules ANDed", async () => {
    expect((await evaluate(config, deviceContext({ locale: "zh-Hans_CN" }, null))).values.greeting).toBe("ni hao");
    expect((await evaluate(config, deviceContext({ locale: "zh_TW" }, null))).values.greeting).toBe("ni hao");
    expect((await evaluate(config, deviceContext({ locale: "en_US" }, null))).values.greeting).toBe("hello");
    expect((await evaluate(config, deviceContext({ locale: "tr_TR", appVersion: "2.10" }, null))).values.greeting).toBe("merhaba");
    expect((await evaluate(config, deviceContext({ locale: "tr-TR", appVersion: "2.9.0" }, null))).values.greeting).toBe("merhaba");
    expect((await evaluate(config, deviceContext({ locale: "tr_TR", appVersion: "2.8.9" }, null))).values.greeting).toBe("hello");
    expect((await evaluate(config, deviceContext({ locale: "tr_TR" }, null))).values.greeting).toBe("hello");
    expect((await evaluate(config, deviceContext({ locale: "en_US", appVersion: "3.0" }, null))).values.greeting).toBe("hello");
    expect(compareVersions("2.10", "2.9")).toBe(1);
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("10.0", "9.9.9")).toBe(1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
  });

  it("the response version changes only when the device's response changes", async () => {
    const a = await evaluate(config, deviceContext({ storefront: "US" }, null));
    const changed = compile(cfg({ conditions: [{ name: "china", rules: [{ type: "country", values: ["CN"] }] }], parameters: [{ key: "onboarding_version", type: "string", defaultValue: "v2", conditionalValues: { china: "v3" } }, { key: "greeting", type: "string", defaultValue: "hello" }, { key: "max_free_accounts", type: "number", defaultValue: 1 }] }));
    const b = await evaluate(changed, deviceContext({ storefront: "US" }, null));
    expect(b.values).toEqual(a.values);
    expect(b.version).toBe(a.version);
    const c = await evaluate(changed, deviceContext({ storefront: "CN" }, null));
    expect(c.version).not.toBe(a.version);
  });

  it("percent buckets are deterministic, roughly uniform, seeded, and need an install id", async () => {
    expect(await percentBucket(uuid(5), "x")).toBe(await percentBucket(uuid(5).toUpperCase(), "x"));
    const rollout = compile(cfg({ conditions: [{ name: "rollout", rules: [{ type: "percent", from: 0, to: 20 }] }, { name: "half", rules: [{ type: "percent", from: 50, to: 100, seed: "exp1" }] }], parameters: [{ key: "a", type: "boolean", defaultValue: false, conditionalValues: { rollout: true } }, { key: "b", type: "boolean", defaultValue: false, conditionalValues: { half: true } }] }));
    let a = 0;
    let b = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const r = await evaluate(rollout, deviceContext({ installId: uuid(i) }, null));
      if (r.values.a) a++;
      if (r.values.b) b++;
    }
    expect(a / N).toBeGreaterThan(0.17);
    expect(a / N).toBeLessThan(0.23);
    expect(b / N).toBeGreaterThan(0.46);
    expect(b / N).toBeLessThan(0.54);
    const again = await evaluate(rollout, deviceContext({ installId: uuid(7) }, null));
    expect((await evaluate(rollout, deviceContext({ installId: uuid(7) }, null))).values).toEqual(again.values);
    expect((await evaluate(rollout, deviceContext({}, null))).conditions).toEqual([]);
  });

  it("unsupported conditions never match; empty rules always match", async () => {
    const c = compile(cfg({ conditions: [{ name: "x", rules: [], unsupported: true, expression: "app.userProperty['a'] == 'b'" }, { name: "all", rules: [] }], parameters: [{ key: "k", type: "string", defaultValue: "d", conditionalValues: { x: "never", all: "always" } }] }));
    expect((await evaluate(c, deviceContext({}, null))).values).toEqual({ k: "always" });
  });
});

describe("Firebase import", () => {
  const TEMPLATE = {
    conditions: [{ name: "country", expression: "device.country in ['CN']", tagColor: "BLUE" }],
    parameters: {
      onboarding_version: { defaultValue: { value: "v2" }, conditionalValues: { country: { value: "v1" } }, valueType: "STRING" },
      max_free_accounts: { defaultValue: { value: "1" }, valueType: "NUMBER" },
      onboarding_requires_trial: { defaultValue: { value: "false" }, valueType: "BOOLEAN" },
      lifetime_product_ids: { defaultValue: { value: "com.example.lifetime, com.example.lifetime_discounted" }, valueType: "STRING" },
    },
  };

  it("converts the real-world-shaped template", async () => {
    const r = convertFirebaseTemplate(TEMPLATE);
    if ("error" in r) throw new Error(r.error);
    expect(r.warnings).toEqual([]);
    const c = cfg(r.config);
    expect(c).toEqual({
      conditions: [{ name: "country", color: "blue", rules: [{ type: "country", values: ["CN"] }] }],
      parameters: [
        { key: "onboarding_version", type: "string", defaultValue: "v2", conditionalValues: { country: "v1" } },
        { key: "max_free_accounts", type: "number", defaultValue: 1, conditionalValues: {} },
        { key: "onboarding_requires_trial", type: "boolean", defaultValue: false, conditionalValues: {} },
        { key: "lifetime_product_ids", type: "string", defaultValue: "com.example.lifetime, com.example.lifetime_discounted", conditionalValues: {} },
      ],
    });
    const cn = await evaluate(compile(c), deviceContext({ storefront: "CN" }, null));
    expect(cn.values).toEqual({ onboarding_version: "v1", max_free_accounts: 1, onboarding_requires_trial: false, lifetime_product_ids: "com.example.lifetime, com.example.lifetime_discounted" });
    expect(cn.conditions).toEqual(["country"]);
  });

  it("parses the supported condition syntax", () => {
    const conv = (expression: string) => convertFirebaseCondition({ name: "c", expression });
    expect(conv("device.country in ['cn', 'HK'] && device.language in ['zh', 'en-US']").condition.rules).toEqual([
      { type: "country", values: ["CN", "HK"] },
      { type: "language", values: ["zh", "en_us"] },
    ]);
    expect(conv("app.version.>=(['2.1.0'])").condition.rules).toEqual([{ type: "app_version", op: ">=", value: "2.1.0" }]);
    expect(conv("app.build.<(['120'])").condition.rules).toEqual([{ type: "app_build", op: "<", value: "120" }]);
    expect(conv("app.version.exactlyMatches(['3.0'])").condition.rules).toEqual([{ type: "app_version", op: "==", value: "3.0" }]);
    expect(conv("percent <= 20").condition.rules).toEqual([{ type: "percent", from: 0, to: 20 }]);
    expect(conv("percent between 10 and 20").condition.rules).toEqual([{ type: "percent", from: 10, to: 20 }]);
    expect(conv("percent('exp') > 50").condition.rules).toEqual([{ type: "percent", from: 50, to: 100, seed: "exp" }]);
    expect(conv("device.os == 'ios' && (device.country in ['TR'])").condition.rules).toEqual([{ type: "country", values: ["TR"] }]);
    expect(conv("app.id == '1:123:ios:abc' && percent <= 5").condition.rules).toEqual([{ type: "percent", from: 0, to: 5 }]);
    expect(conv("true").condition).toEqual({ name: "c", rules: [] });
    for (const e of ["app.userProperty['plan'] == 'pro'", "device.os == 'android'", "device.country in ['CN'] || device.country in ['HK']", "device.dateTime >= dateTime('2026-01-01T00:00:00')", "app.version.matches(['1.*'])"]) {
      const r = conv(e);
      expect(r.condition.unsupported, e).toBe(true);
      expect(r.condition.expression).toBe(e);
      expect(r.unsupported.length).toBeGreaterThan(0);
    }
  });

  it("flattens parameter groups, warns about unsupported conditions and bad values", () => {
    const r = convertFirebaseTemplate({
      conditions: [
        { name: "country", expression: "device.country in ['CN']" },
        { name: "pro users", expression: "app.userProperty['plan'].exactlyMatches(['pro'])", tagColor: "GREEN" },
      ],
      parameters: { a: { defaultValue: { value: "1" }, valueType: "NUMBER", conditionalValues: { "pro users": { value: "2" }, ghost: { value: "3" } } } },
      parameterGroups: {
        paywall: {
          description: "Paywall",
          parameters: {
            paywall: { defaultValue: { value: '{"title":"Go Pro"}' }, valueType: "JSON", description: "Texts" },
            bad_number: { defaultValue: { value: "lots" }, valueType: "NUMBER" },
            in_app: { defaultValue: { useInAppDefault: true }, conditionalValues: { country: { value: "x" } } },
            rollout: { defaultValue: { rolloutValue: { rolloutId: "r" } }, valueType: "BOOLEAN" },
          },
        },
      },
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.unsupportedConditions).toBe(1);
    expect(r.config.conditions[1]).toMatchObject({ name: "pro users", color: "green", unsupported: true, expression: "app.userProperty['plan'].exactlyMatches(['pro'])" });
    expect(r.config.parameters.map((p) => p.key)).toEqual(["a", "paywall", "bad_number", "in_app", "rollout"]);
    expect(r.config.parameters[1]).toEqual({ key: "paywall", type: "json", description: "Texts", defaultValue: { title: "Go Pro" }, conditionalValues: {} });
    expect(r.config.parameters[2]).toMatchObject({ type: "string", defaultValue: "lots" });
    expect(r.config.parameters[3]).toMatchObject({ useInAppDefault: true, conditionalValues: { country: "x" } });
    expect(r.config.parameters[4]).toMatchObject({ useInAppDefault: true });
    expect(r.warnings.join("\n")).toMatch(/Condition "pro users".*never matches/);
    expect(r.warnings.join("\n")).toContain('unknown condition "ghost"');
    expect(r.warnings.join("\n")).toContain('Parameter "bad_number" (group "paywall"): a value is not a valid number');
    expect(r.warnings.join("\n")).toContain("rolloutValue");
    expect("error" in parseRemoteConfig(r.config)).toBe(false);
  });

  it("renames condition names Revflare does not allow, and their values follow", () => {
    const r = convertFirebaseTemplate({
      conditions: [{ name: "20% rollout", expression: "percent <= 20" }, { name: "20_ rollout", expression: "true" }],
      parameters: { a: { defaultValue: { value: "x" }, conditionalValues: { "20% rollout": { value: "y" }, "20_ rollout": { value: "z" } } } },
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.config.conditions.map((c) => c.name)).toEqual(["20_ rollout", "20_ rollout_2"]);
    expect(r.config.parameters[0].conditionalValues).toEqual({ "20_ rollout": "y", "20_ rollout_2": "z" });
    expect(r.config.conditions[0].rules).toEqual([{ type: "percent", from: 0, to: 20 }]);
    expect(r.warnings[0]).toContain('"20% rollout" renamed "20_ rollout"');
    expect("error" in parseRemoteConfig(r.config)).toBe(false);
  });

  it("merges by parameter key and condition name", () => {
    const base = cfg({ conditions: [{ name: "a" }, { name: "b" }], parameters: [{ key: "x", type: "string", defaultValue: "1" }, { key: "y", type: "string", defaultValue: "2" }] });
    const m = mergeConfigs(base, { conditions: [{ name: "b", rules: [{ type: "country", values: ["CN"] }] }, { name: "c", rules: [] }], parameters: [{ key: "y", type: "number", defaultValue: 3 }, { key: "z", type: "string", defaultValue: "4" }] });
    const c = cfg(m);
    expect(c.conditions.map((x) => [x.name, x.rules.length])).toEqual([["a", 0], ["b", 1], ["c", 0]]);
    expect(c.parameters.map((p) => [p.key, p.defaultValue])).toEqual([["x", "1"], ["y", 3], ["z", "4"]]);
  });
});

describe("acquisition source and environment conditions", () => {
  const body = {
    conditions: [
      { name: "brand campaign", rules: [{ type: "apple_ads_campaign", values: ["1234567890", 42] }] },
      { name: "keyword", rules: [{ type: "apple_ads_keyword", values: ["555"] }, { type: "apple_ads_ad_group", values: ["777"] }] },
      { name: "paid", rules: [{ type: "source", values: ["APPLE_ADS"] }] },
      { name: "not yet known", rules: [{ type: "source", values: ["unknown"] }] },
      { name: "debug", rules: [{ type: "environment", values: ["sandbox", "xcode"] }] },
    ],
    parameters: [
      { key: "paywall", type: "string", defaultValue: "standard", conditionalValues: { "brand campaign": "brand", keyword: "kw", paid: "ads", "not yet known": "neutral" } },
      { key: "debug_menu", type: "boolean", defaultValue: false, conditionalValues: { debug: true } },
    ],
  };

  it("validates rule values (fixed sets, Apple Ads ids as digits) and normalizes them", () => {
    const c = cfg(body);
    expect(c.conditions[0].rules[0]).toEqual({ type: "apple_ads_campaign", values: ["1234567890", "42"] });
    expect(c.conditions[2].rules[0]).toEqual({ type: "source", values: ["apple_ads"] });
    for (const rule of [
      { type: "source", values: ["facebook"] },
      { type: "source", values: [] },
      { type: "environment", values: ["staging"] },
      { type: "apple_ads_campaign", values: ["abc"] },
      { type: "apple_ads_ad_group", values: ["123456789012345678901"] },
      { type: "apple_ads_keyword", values: [true] },
    ]) {
      const r = parseRemoteConfig({ conditions: [{ name: "x", rules: [rule] }], parameters: [] });
      expect("error" in r, JSON.stringify(rule)).toBe(true);
    }
  });

  it("deviceContext keeps valid values only (same validation as the rules)", () => {
    expect(deviceContext({ source: "apple_ads", campaign: "123", adGroup: "456", keyword: "789", environment: "sandbox" }, null)).toMatchObject({
      source: "apple_ads",
      campaign: "123",
      adGroup: "456",
      keyword: "789",
      environment: "sandbox",
    });
    expect(deviceContext({ source: "tiktok", campaign: "12a", adGroup: "1".repeat(21), keyword: "", environment: "dev" }, null)).toMatchObject({
      source: null,
      campaign: null,
      adGroup: null,
      keyword: null,
      environment: "production",
    });
    expect(deviceContext({}, null).environment).toBe("production");
  });

  it("matches by source, Apple Ads ids and environment", async () => {
    const config = compile(cfg(body));
    const ev = (q: Record<string, string>) => evaluate(config, deviceContext(q, null));
    expect((await ev({ source: "apple_ads", campaign: "1234567890" })).values.paywall).toBe("brand");
    expect((await ev({ source: "apple_ads", campaign: "42", adGroup: "777", keyword: "555" })).values.paywall).toBe("brand");
    expect((await ev({ source: "apple_ads", campaign: "9", adGroup: "777", keyword: "555" })).values.paywall).toBe("kw");
    expect((await ev({ source: "apple_ads", campaign: "9", keyword: "555" })).values.paywall).toBe("ads");
    expect((await ev({ source: "organic" })).values.paywall).toBe("standard");
    expect((await ev({ source: "unknown" })).values.paywall).toBe("neutral");
    // A device that sent no source (older SDK) matches no source rule.
    expect((await ev({})).values.paywall).toBe("standard");
    expect((await ev({})).values.debug_menu).toBe(false);
    expect((await ev({ environment: "xcode" })).values.debug_menu).toBe(true);
    expect((await ev({ environment: "production" })).values.debug_menu).toBe(false);
  });

  it("the version changes when the source changes the device's values", async () => {
    const config = compile(cfg(body));
    const first = await evaluate(config, deviceContext({ installId: uuid(1), source: "unknown" }, null));
    const later = await evaluate(config, deviceContext({ installId: uuid(1), source: "apple_ads", campaign: "1234567890" }, null));
    const organic1 = await evaluate(config, deviceContext({ installId: uuid(1), source: "organic" }, null));
    const organic2 = await evaluate(config, deviceContext({ installId: uuid(1), source: "organic", environment: "production" }, null));
    expect(first.version).not.toBe(later.version);
    expect(first.version).not.toBe(organic1.version);
    // Inputs that change nothing keep the version (and the ETag).
    expect(organic1.version).toBe(organic2.version);
  });

  it("experiments inherit acquisition targeting through their condition", async () => {
    const stored = cfg(body);
    const config = compile(stored, [{ id: "exp_src1", keys: ["paywall"], types: { paywall: "string" }, variants: [{ id: "a", weight: 50, values: {} }, { id: "b", weight: 50, values: { paywall: "b" } }], targeting: "paid", traffic: 100 }]);
    const ads = await evaluate(config, deviceContext({ installId: uuid(3), source: "apple_ads" }, null));
    const organic = await evaluate(config, deviceContext({ installId: uuid(3), source: "organic" }, null));
    expect(ads.experiments?.[0]?.id).toBe("exp_src1");
    expect(organic.experiments).toBeUndefined();
  });
});
