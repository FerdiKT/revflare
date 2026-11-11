import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, ownerClient, type Client } from "./helpers";

const stats = () => env.DATABASE.get(env.DATABASE.idFromName("main")).stats();

async function newApp(owner: Client, bundleId: string) {
  const app = await call(owner, "/api/v1/apps", { body: { name: bundleId, bundleId } });
  expect(app.status).toBe(201);
  return { id: app.json.id as string, sdkKey: app.json.sdkKey as string };
}

const INSTALL = "6f1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a";
/** GET /sdk/v1/config as RevflareKit calls it; `query` ("&storefront=CN") overrides or adds parameters. */
const sdk = (key: string | null, query = "", headers: Record<string, string> = {}) => {
  const q = new URLSearchParams({ installId: INSTALL, appVersion: "2.1", appBuild: "12", osVersion: "18.1", locale: "zh_CN", sdk: "1.5.0" });
  for (const [k, v] of new URLSearchParams(query.replace(/^&/, ""))) q.set(k, v);
  return call(null, `/sdk/v1/config?${q}`, { headers: { ...(key ? { "x-revflare-key": key } : {}), ...headers } });
};

const TEMPLATE = {
  conditions: [{ name: "country", expression: "device.country in ['CN']", tagColor: "BLUE" }],
  parameters: {
    onboarding_version: { defaultValue: { value: "v2" }, conditionalValues: { country: { value: "v1" } }, valueType: "STRING" },
    max_free_accounts: { defaultValue: { value: "1" }, valueType: "NUMBER" },
    onboarding_requires_trial: { defaultValue: { value: "false" }, valueType: "BOOLEAN" },
    lifetime_product_ids: { defaultValue: { value: "com.example.lifetime, com.example.lifetime_discounted" }, valueType: "STRING" },
  },
};

const CONFIG = {
  conditions: [
    { name: "china", color: "red", rules: [{ type: "country", values: ["CN"] }] },
    { name: "new", rules: [{ type: "app_version", op: ">=", value: "2.10" }] },
  ],
  parameters: [
    { key: "onboarding_version", type: "string", defaultValue: "v2", conditionalValues: { china: "v1" } },
    { key: "max_free_accounts", type: "number", defaultValue: 1, conditionalValues: { new: 3 } },
    { key: "show_discounted_paywall", type: "boolean", defaultValue: true },
    { key: "paywall", type: "json", defaultValue: { title: "Go Pro" }, description: "Paywall texts" },
    { key: "legacy", type: "string", useInAppDefault: true },
  ],
};

describe("remote config", { timeout: 60_000 }, () => {
  it("validates and replaces the whole config; scoped by workspace", async () => {
    const owner = await ownerClient();
    const { id } = await newApp(owner, "com.example.rc.crud");
    const base = `/api/v1/apps/${id}/config`;
    const empty = await call(owner, base);
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ conditions: [], parameters: [], updatedAt: null, warnings: [] });

    // Invalid: color, then a reference to a missing condition. Nothing changes.
    expect((await call(owner, base, { method: "PUT", body: CONFIG })).status).toBe(400);
    const fixed = { ...CONFIG, conditions: [{ ...CONFIG.conditions[0], color: "blue" }, CONFIG.conditions[1]] };
    const missing = await call(owner, base, { method: "PUT", body: { ...fixed, conditions: [fixed.conditions[1]] } });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toContain('condition "china" does not exist');
    expect((await call(owner, base)).json.updatedAt).toBeNull();

    const put = await call(owner, base, { method: "PUT", body: fixed });
    expect(put.status).toBe(200);
    expect(put.json.parameters).toHaveLength(5);
    expect(put.json.parameters[4]).toEqual({ key: "legacy", type: "string", useInAppDefault: true, conditionalValues: {} });
    expect(put.json.updatedAt).toBeGreaterThan(0);
    expect(put.json.version).not.toBe(empty.json.version);
    const get = await call(owner, base);
    expect(get.json).toEqual(put.json);
    // The GET output sent back is the same config: same version, no write.
    const again = await call(owner, base, { method: "PUT", body: get.json });
    expect(again.json.version).toBe(get.json.version);
    expect(again.json.updatedAt).toBe(get.json.updatedAt);

    expect((await call(owner, "/api/v1/apps/nope/config")).status).toBe(404);
    expect((await call(owner, "/api/v1/apps/nope/config", { method: "PUT", body: fixed })).status).toBe(404);
    expect((await call(null, base)).status).toBe(401);
  });

  it("serves each device its values with ETag / 304; the version changes only when its values change", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.rc.sdk");
    const base = `/api/v1/apps/${id}/config`;
    expect((await call(owner, base, { method: "PUT", body: { ...CONFIG, conditions: [{ ...CONFIG.conditions[0], color: "blue" }, CONFIG.conditions[1]] } })).status).toBe(200);

    const cn = await sdk(sdkKey, "&storefront=CN");
    expect(cn.status).toBe(200);
    expect(cn.headers.get("cache-control")).toBe("private, max-age=60");
    expect(cn.headers.get("etag")).toBe(`"${cn.json.version}"`);
    expect(cn.json).toEqual({
      version: cn.json.version,
      values: { onboarding_version: "v1", max_free_accounts: 1, show_discounted_paywall: true, paywall: { title: "Go Pro" } },
      conditions: ["china"],
      country: "CN",
    });
    expect(Object.keys(cn.json)).toEqual(["version", "values", "conditions", "country"]);
    const us = await sdk(sdkKey, "&storefront=US");
    expect(us.json.values.onboarding_version).toBe("v2");
    expect(us.json.country).toBe("US");
    expect(us.json.version).not.toBe(cn.json.version);
    expect((await sdk(sdkKey, "&storefront=US&appVersion=2.10")).json.values.max_free_accounts).toBe(3);

    const r304 = await sdk(sdkKey, "&storefront=CN", { "if-none-match": `"${cn.json.version}"` });
    expect(r304.status).toBe(304);
    expect(r304.text).toBe("");
    expect(r304.headers.get("etag")).toBe(`"${cn.json.version}"`);
    expect((await sdk(sdkKey, "&storefront=CN", { "if-none-match": '"stale"' })).status).toBe(200);

    // Changing China's value: the US device keeps its version (304), the Chinese one gets a new one at once.
    const cfg = (await call(owner, base)).json;
    cfg.parameters[0].conditionalValues.china = "v3";
    expect((await call(owner, base, { method: "PUT", body: cfg })).status).toBe(200);
    expect((await sdk(sdkKey, "&storefront=US", { "if-none-match": `"${us.json.version}"` })).status).toBe(304);
    const cn2 = await sdk(sdkKey, "&storefront=CN", { "if-none-match": `"${cn.json.version}"` });
    expect(cn2.status).toBe(200);
    expect(cn2.json.values.onboarding_version).toBe("v3");

    // Evaluate ("preview as") gives the same answer plus where each value came from.
    const ev = await call(owner, `${base}/evaluate`, { body: { storefront: "CN", appVersion: "2.1", installId: INSTALL, locale: "zh_CN", osVersion: "18.1", sdkVersion: "1.5.0" } });
    expect(ev.status).toBe(200);
    expect(ev.json.version).toBe(cn2.json.version);
    expect(ev.json.values).toEqual(cn2.json.values);
    expect(ev.json.parameters.onboarding_version).toEqual({ condition: "china", useInAppDefault: false, value: "v3" });
    expect(ev.json.parameters.legacy).toEqual({ condition: null, useInAppDefault: true });
    const ip = await call(owner, `${base}/evaluate`, { body: { ipCountry: "CN" } });
    expect(ip.json.country).toBe("CN");
    expect(ip.json.values.onboarding_version).toBe("v3");

    // MCP (read-only tools).
    const key = await call(owner, "/api/v1/api-keys", { body: { name: "rc-mcp" } });
    const mcp = (name: string, args: Record<string, unknown>) => call({ token: key.json.token }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    const got = await mcp("get_remote_config", { app: id });
    expect(JSON.parse(got.json.result.content[0].text).parameters).toHaveLength(5);
    const evm = await mcp("evaluate_remote_config", { app: id, storefront: "CN" });
    expect(JSON.parse(evm.json.result.content[0].text).values.onboarding_version).toBe("v3");
  });

  it("answers 400 without a key, 404 for an unknown key, and empty values for an app without config", async () => {
    expect((await sdk(null)).status).toBe(400);
    expect((await sdk("rfp_unknownkey")).status).toBe(404);
    const owner = await ownerClient();
    const { sdkKey } = await newApp(owner, "com.example.rc.empty");
    const r = await sdk(sdkKey, "&storefront=DE");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ values: {}, conditions: [], country: "DE" });
  });

  it("imports a Firebase template (dry run, replace, merge) with warnings", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.rc.firebase");
    const base = `/api/v1/apps/${id}/config`;

    const dry = await call(owner, `${base}/import-firebase?dryRun=true`, { body: TEMPLATE });
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ dryRun: true, merged: false, imported: { parameters: 4, conditions: 1, unsupportedConditions: 0 }, warnings: [] });
    expect(dry.json.parameters.map((p: { key: string; type: string; defaultValue: unknown }) => [p.key, p.type, p.defaultValue])).toEqual([
      ["onboarding_version", "string", "v2"],
      ["max_free_accounts", "number", 1],
      ["onboarding_requires_trial", "boolean", false],
      ["lifetime_product_ids", "string", "com.example.lifetime, com.example.lifetime_discounted"],
    ]);
    expect((await call(owner, base)).json.parameters).toEqual([]);

    const applied = await call(owner, `${base}/import-firebase`, { body: TEMPLATE });
    expect(applied.status).toBe(200);
    expect(applied.json.dryRun).toBe(false);
    expect((await call(owner, base)).json.parameters).toHaveLength(4);
    const cn = await sdk(sdkKey, "&storefront=CN");
    expect(cn.json.values).toEqual({ onboarding_version: "v1", max_free_accounts: 1, onboarding_requires_trial: false, lifetime_product_ids: "com.example.lifetime, com.example.lifetime_discounted" });
    expect(cn.json.conditions).toEqual(["country"]);

    const merged = await call(owner, `${base}/import-firebase?merge=true`, {
      body: {
        conditions: [{ name: "pro", expression: "app.userProperty['plan'] == 'pro'" }],
        parameterGroups: { g: { parameters: { max_free_accounts: { defaultValue: { value: "2" }, valueType: "NUMBER", conditionalValues: { pro: { value: "9" } } }, extra: { defaultValue: { value: "x" } } } } },
      },
    });
    expect(merged.status).toBe(200);
    expect(merged.json.merged).toBe(true);
    expect(merged.json.conditions.map((c: { name: string }) => c.name)).toEqual(["country", "pro"]);
    expect(merged.json.conditions[1]).toMatchObject({ unsupported: true, expression: "app.userProperty['plan'] == 'pro'" });
    expect(merged.json.parameters.map((p: { key: string }) => p.key)).toEqual(["onboarding_version", "max_free_accounts", "onboarding_requires_trial", "lifetime_product_ids", "extra"]);
    expect(merged.json.warnings.some((w: string) => w.includes('Condition "pro"'))).toBe(true);
    expect((await sdk(sdkKey, "&storefront=CN")).json.values.max_free_accounts).toBe(2);

    expect((await call(owner, `${base}/import-firebase`, { body: { parameters: [] } })).status).toBe(400);
  });

  it("does not read the database per SDK request", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.rc.cost");
    await call(owner, `/api/v1/apps/${id}/config`, { method: "PUT", body: { parameters: [{ key: "a", type: "string", defaultValue: "x" }] } });
    let before = await stats();
    expect((await sdk(sdkKey)).status).toBe(200);
    let after = await stats();
    const first = after.rowsRead - before.rowsRead;
    console.log(`sdk config, first call: ${first} rows read`);
    expect(first).toBeLessThanOrEqual(3);
    before = await stats();
    for (let i = 0; i < 20; i++) expect((await sdk(sdkKey, `&storefront=${i % 2 ? "CN" : "US"}`)).status).toBe(200);
    after = await stats();
    expect(after.rowsRead - before.rowsRead).toBe(0);
    expect(after.rowsWritten - before.rowsWritten).toBe(0);
  });
});
