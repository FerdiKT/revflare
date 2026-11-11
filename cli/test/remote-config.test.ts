import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeRule, exportRemoteConfig, parseValue } from "../src/commands/remote-config.js";
import { run } from "../src/main.js";
import type { RemoteConfig, RemoteConfigEvaluation, RemoteConfigImport } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch, reply } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.rc")], currency: "USD" };
const T = Date.UTC(2026, 9, 20);
const CONFIG: RemoteConfig = {
  conditions: [
    { name: "china", color: "blue", rules: [{ type: "country", values: ["CN", "HK"] }] },
    { name: "new", rules: [{ type: "app_version", op: ">=", value: "2.1" }, { type: "percent", from: 0, to: 20 }] },
    { name: "pro users", rules: [], unsupported: true, expression: "app.userProperty['plan'] == 'pro'" },
  ],
  parameters: [
    { key: "onboarding_version", type: "string", defaultValue: "v2", conditionalValues: { china: "v1" } },
    { key: "max_free_accounts", type: "number", defaultValue: 1, conditionalValues: { new: { useInAppDefault: true } } },
    { key: "paywall", type: "json", defaultValue: { title: "Go Pro" }, conditionalValues: {} },
  ],
  version: "0123456789ab",
  updatedAt: T,
  warnings: ['Condition "pro users" uses targeting Revflare cannot evaluate: it never matches.'],
};

describe("helpers", () => {
  it("describes rules, parses typed values, exports the PUT shape", () => {
    expect(describeRule({ type: "country", values: ["CN", "HK"] })).toBe("country in CN, HK");
    expect(describeRule({ type: "app_version", op: ">=", value: "2.1" })).toBe("app_version >= 2.1");
    expect(describeRule({ type: "percent", from: 10, to: 20, seed: "exp" })).toBe("percent 10–20 (seed exp)");
    expect(parseValue("number", "2")).toBe(2);
    expect(parseValue("boolean", "TRUE")).toBe(true);
    expect(parseValue("json", '{"a":1}')).toEqual({ a: 1 });
    expect(parseValue("string", "1")).toBe("1");
    expect(() => parseValue("number", "x")).toThrow();
    expect(() => parseValue("boolean", "yes")).toThrow();
    expect(exportRemoteConfig(CONFIG)).toEqual({ conditions: CONFIG.conditions, parameters: CONFIG.parameters });
  });
});

describe("config", () => {
  it("shows parameters and conditions, exports JSON", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/config": CONFIG });
    const env = loggedInEnv();
    expect(await run(["config", "com.example.rc", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/onboarding_version\s+string\s+"v2"\s+china: "v1"/);
    expect(out.stdout).toMatch(/max_free_accounts\s+number\s+1\s+new: \(in-app default\)/);
    expect(out.stdout).toMatch(/2\s+new\s+app_version >= 2\.1 AND percent 0–20/);
    expect(out.stdout).toContain("unsupported, never matches: app.userProperty");
    expect(out.stdout).toContain('warning: Condition "pro users"');
    out.stdout = "";
    expect(await run(["config", "app_1", "export"], { env, fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(exportRemoteConfig(CONFIG));
  });

  it("apply PUTs the file; import-firebase posts with dryRun / merge", async () => {
    const out = capture();
    const IMPORT: RemoteConfigImport = { ...CONFIG, dryRun: true, merged: true, imported: { parameters: 4, conditions: 1, unsupportedConditions: 0 } };
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "PUT /apps/app_1/config": CONFIG, "POST /apps/app_1/config/import-firebase": IMPORT });
    const env = loggedInEnv();
    const dir = mkdtempSync(join(tmpdir(), "revflare-rc-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify(exportRemoteConfig(CONFIG)));
    expect(await run(["config", "app_1", "apply", file, "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("PUT");
    expect(calls.at(-1)!.body).toEqual(exportRemoteConfig(CONFIG));
    expect(out.stdout).toContain("Applied. 3 parameters, 3 conditions");

    const fb = { conditions: [{ name: "country", expression: "device.country in ['CN']" }], parameters: {} };
    const readStdin = async () => JSON.stringify(fb);
    expect(await run(["config", "app_1", "import-firebase", "-", "--dry-run", "--merge", "--no-color"], { env, fetch, readStdin })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("dryRun")).toBe("true");
    expect(calls.at(-1)!.url.searchParams.get("merge")).toBe("true");
    expect(calls.at(-1)!.body).toEqual(fb);
    expect(out.stdout).toContain("Dry run: would merge 4 parameters and 1 condition. Nothing was saved.");
    expect(await run(["config", "app_1", "import-firebase", "-"], { env, fetch, readStdin: async () => "{nope" })).toBe(1);
    expect(out.stderr).toContain("not valid JSON");
  });

  it("eval sends the device and prints where each value came from", async () => {
    const out = capture();
    const EV: RemoteConfigEvaluation = {
      version: "abcdef012345",
      values: { onboarding_version: "v1", paywall: { title: "Go Pro" } },
      conditions: ["china", "new"],
      country: "CN",
      parameters: {
        onboarding_version: { condition: "china", useInAppDefault: false, value: "v1" },
        max_free_accounts: { condition: "new", useInAppDefault: true },
        paywall: { condition: null, useInAppDefault: false, value: { title: "Go Pro" } },
      },
    };
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "POST /apps/app_1/config/evaluate": EV });
    expect(await run(["config", "app_1", "eval", "--country", "CN", "--app-version", "2.1", "--locale", "zh_CN", "--install-id", "x-1", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ storefront: "CN", appVersion: "2.1", locale: "zh_CN", installId: "x-1" });
    expect(out.stdout).toContain("Country CN  Conditions china, new");
    expect(out.stdout).toMatch(/onboarding_version\s+"v1"\s+china/);
    expect(out.stdout).toMatch(/max_free_accounts\s+\(in-app default\)\s+new/);
    expect(out.stdout).toMatch(/paywall\s+\{"title":"Go Pro"\}\s+default/);
  });

  it("set and rm read, modify and PUT the whole config", async () => {
    capture();
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/config": CONFIG, "PUT /apps/app_1/config": CONFIG });
    const env = loggedInEnv();
    const lastPut = () => calls.filter((x) => x.method === "PUT").at(-1)!.body;
    expect(await run(["config", "app_1", "set", "onboarding_version", "v3", "--condition", "china"], { env, fetch })).toBe(0);
    expect(lastPut().parameters[0]).toEqual({ key: "onboarding_version", type: "string", defaultValue: "v2", conditionalValues: { china: "v3" } });
    expect(await run(["config", "app_1", "set", "max_free_accounts", "2"], { env, fetch })).toBe(0);
    expect(lastPut().parameters[1]).toMatchObject({ type: "number", defaultValue: 2 });
    expect(await run(["config", "app_1", "set", "dark_mode", "true", "--type", "boolean", "--description", "Dark UI"], { env, fetch })).toBe(0);
    expect(lastPut().parameters[3]).toEqual({ key: "dark_mode", type: "boolean", defaultValue: true, conditionalValues: {}, description: "Dark UI" });
    expect(await run(["config", "app_1", "set", "paywall", "--in-app-default"], { env, fetch })).toBe(0);
    expect(lastPut().parameters[2]).toEqual({ key: "paywall", type: "json", useInAppDefault: true, conditionalValues: {} });
    expect(await run(["config", "app_1", "rm", "onboarding_version", "--condition", "china"], { env, fetch })).toBe(0);
    expect(lastPut().parameters[0].conditionalValues).toEqual({});
    expect(await run(["config", "app_1", "rm", "paywall"], { env, fetch })).toBe(0);
    expect(lastPut().parameters.map((p: { key: string }) => p.key)).toEqual(["onboarding_version", "max_free_accounts"]);
  });

  it("rejects bad input; server errors pass through", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/config": CONFIG, "PUT /apps/app_1/config": reply(400, { error: 'Parameter "x": expected a finite number' }) });
    const env = loggedInEnv();
    expect(await run(["config", "app_1", "delete"], { env, fetch })).toBe(2);
    expect(await run(["config", "app_1", "set", "max_free_accounts", "lots"], { env, fetch })).toBe(2);
    expect(await run(["config", "app_1", "set", "k", "v", "--type", "date"], { env, fetch })).toBe(2);
    expect(await run(["config", "app_1", "set", "ghost", "v", "--condition", "china"], { env, fetch })).toBe(1);
    expect(await run(["config", "app_1", "set", "onboarding_version", "v", "--condition", "nope"], { env, fetch })).toBe(1);
    expect(await run(["config", "app_1", "rm", "ghost"], { env, fetch })).toBe(1);
    expect(await run(["config", "app_1", "set", "x", "1"], { env, fetch })).toBe(1);
    expect(out.stderr).toContain("expected a finite number");
  });
});
