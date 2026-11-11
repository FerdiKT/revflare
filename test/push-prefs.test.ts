import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, wants, type PushMessage } from "../worker/lib/push";

const msg = (kind: PushMessage["kind"], appId = "app_a"): PushMessage => ({ kind, appId, titleKey: "t", bodyKey: "b", amountUsd: 5 });

describe("push preferences per app", () => {
  it("mutes an app, turns one kind off for one app and lets an app keep a kind that is off globally", () => {
    const prefs = {
      ...DEFAULT_PREFS,
      trials: false,
      appOverrides: { app_a: { muted: true }, app_b: { renewals: false }, app_c: { trials: true } },
    };
    expect(wants(prefs, msg("sale", "app_a"))).toBe(false);
    expect(wants(prefs, msg("refund", "app_a"))).toBe(false);
    expect(wants(prefs, msg("summary", "app_a"))).toBe(true);
    expect(wants(prefs, msg("renewal", "app_b"))).toBe(false);
    expect(wants(prefs, msg("sale", "app_b"))).toBe(true);
    expect(wants(prefs, msg("trial", "app_b"))).toBe(false);
    expect(wants(prefs, msg("trial", "app_c"))).toBe(true);
    expect(wants(prefs, msg("renewal", "app_d"))).toBe(true);
  });
});

describe("newer push texts", () => {
  it("devices with a recent enough pushVersion get the newer body (Apple Ads source); older builds the plain one", async () => {
    const { messageFor, PUSH_VERSION_ADS } = await import("../worker/lib/push");
    const { adsPushLabel } = await import("../worker/lib/ads-names");
    const m: PushMessage = {
      ...msg("sale"),
      bodyKey: "PUSH_BODY_SALE",
      bodyArgs: ["Pro", "US", "$9.99"],
      newer: { pushVersion: PUSH_VERSION_ADS, bodyKey: "PUSH_BODY_SALE_ADS", bodyArgs: ["Pro", "US", "$9.99", "Apple Ads · Brand"] },
    };
    expect(messageFor(m, { ...DEFAULT_PREFS, pushVersion: 2 })).toEqual({ ...msg("sale"), bodyKey: "PUSH_BODY_SALE_ADS", bodyArgs: ["Pro", "US", "$9.99", "Apple Ads · Brand"] });
    expect(messageFor(m, { ...DEFAULT_PREFS, pushVersion: 1 })).toEqual({ ...msg("sale"), bodyKey: "PUSH_BODY_SALE", bodyArgs: ["Pro", "US", "$9.99"] });
    expect(messageFor(m, DEFAULT_PREFS)).not.toHaveProperty("newer");
    const a = { source: "apple_ads" as const, test: false, campaignId: "1", campaignName: "Brand", adGroupId: null, adGroupName: null, keywordId: null, keywordName: null };
    expect(adsPushLabel(a)).toBe("Apple Ads · Brand");
    expect(adsPushLabel({ ...a, adGroupId: "2" })).toBe("Apple Ads · #2");
    expect(adsPushLabel({ ...a, adGroupId: "2", adGroupName: "Exact" })).toBe("Apple Ads · Exact");
    expect(adsPushLabel({ ...a, test: true })).toBeNull();
    expect(adsPushLabel({ ...a, source: "organic" })).toBeNull();
    expect(adsPushLabel(null)).toBeNull();
  });
});
