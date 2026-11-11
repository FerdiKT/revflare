import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateAttribution, parseNamesFile } from "../src/commands/attribution.js";
import { run } from "../src/main.js";
import type { AttributedRevenue } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const row = (date: string, campaignId: string, adGroupId: string | null, keywordId: string | null, revenue: number, installs: number, extra: Partial<AttributedRevenue["rows"][number]> = {}) => ({
  date,
  appId: "app_1",
  appleAppId: "111",
  campaignId,
  adGroupId,
  keywordId,
  revenue,
  proceeds: revenue * 0.85,
  transactions: revenue ? 1 : 0,
  trials: 0,
  installs,
  payers: revenue ? 1 : 0,
  ...extra,
});

const DATA: AttributedRevenue = {
  currency: "USD",
  from: "2026-09-19",
  to: "2026-10-16",
  coverage: { installs: 200, attributed: 50, testInstalls: 8 },
  rows: [
    row("2026-10-01", "10", "20", "30", 9.99, 10, { campaignName: "Brand Search", adGroupName: "Exact", keywordName: "photo editor" }),
    row("2026-10-02", "10", "20", "31", 4.99, 5),
    row("2026-10-02", "10", "21", null, 0, 5, { trials: 2 }),
    row("2026-10-03", "11", "22", "32", 29.99, 30),
  ],
};

const APPS = { items: [app("app_1", "Photo Lab", "com.example.mini", { sdkKey: "rfp_old" })], currency: "USD" };

describe("aggregateAttribution", () => {
  it("sums by campaign, ad group and keyword, biggest revenue first", () => {
    const byCampaign = aggregateAttribution(DATA.rows, "campaign");
    expect(byCampaign.groups.map((g) => [g.campaignId, g.revenue, g.installs])).toEqual([
      ["11", 29.99, 30],
      ["10", 14.98, 20],
    ]);
    expect(byCampaign.groups[1]).not.toHaveProperty("adGroupId");
    expect(byCampaign.totals).toMatchObject({ revenue: 44.97, installs: 50, payers: 3, trials: 2, transactions: 3, revenuePerInstall: 0.9 });
    const byGroup = aggregateAttribution(DATA.rows, "adgroup");
    expect(byGroup.groups.map((g) => `${g.campaignId}/${g.adGroupId}`)).toEqual(["11/22", "10/20", "10/21"]);
    expect(byGroup.groups[2]).toMatchObject({ revenue: 0, installs: 5, revenuePerInstall: 0 });
    const byKeyword = aggregateAttribution(DATA.rows, "keyword");
    expect(byKeyword.groups.map((g) => `${g.campaignId}/${g.adGroupId}/${g.keywordId}`)).toEqual(["11/22/32", "10/20/30", "10/20/31", "10/21/null"]);
    expect(aggregateAttribution([], "campaign")).toEqual({ groups: [], totals: { revenue: 0, proceeds: 0, transactions: 0, trials: 0, installs: 0, payers: 0, revenuePerInstall: null } });
  });
});

describe("attribution", () => {
  it("queries the range and apps and prints a table with totals and coverage", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "GET /revenue/attributed": DATA });
    expect(await run(["attribution", "--range", "90d", "--app", "com.example.mini", "--by", "keyword", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    const q = calls.find((c) => c.url.pathname.endsWith("/revenue/attributed"))!.url.searchParams;
    expect(q.get("range")).toBe("90d");
    expect(q.get("apps")).toBe("app_1");
    expect(out.stdout).toMatch(/CAMPAIGN\s+AD GROUP\s+KEYWORD\s+REVENUE/);
    expect(out.stdout).toMatch(/11\s+22\s+32\s+\$29\.99/);
    expect(out.stdout).toMatch(/Brand Search \(10\)\s+Exact \(20\)\s+photo editor \(30\)\s+\$9\.99/);
    expect(out.stdout).toMatch(/10\s+21\s+\(none\)/);
    expect(out.stdout).toContain("50 of 200 reporting installs came from Apple Ads (25%) (8 test installs hidden)");
    expect(out.stdout).toContain("revflare attribution names import");
    expect(q.get("includeTest")).toBeNull();
  });

  it("--json prints aggregated groups; --raw the API rows; default range 28d", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /revenue/attributed": DATA });
    expect(await run(["attribution", "--json"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[0].url.searchParams.get("range")).toBe("28d");
    const j = JSON.parse(out.stdout);
    expect(j).toMatchObject({ by: "campaign", currency: "USD", coverage: { installs: 200, attributed: 50, testInstalls: 8, share: 0.25 }, totals: { revenue: 44.97 } });
    expect(j.groups).toHaveLength(2);
    out.stdout = "";
    expect(await run(["attribution", "--json", "--raw", "--by", "adgroup"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(DATA);
  });

  it("explains the setup when no install reported, and rejects a bad --by", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /revenue/attributed": { ...DATA, rows: [], coverage: { installs: 0, attributed: 0 } } });
    expect(await run(["attribution"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toContain("Revflare.configure(sdkKey:server:)");
    expect(await run(["attribution", "--by", "ad"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(out.stderr).toContain("use campaign, adgroup or keyword");
  });
});

describe("attribution names and test data", () => {
  it("--include-test asks for test data and flags test rows", async () => {
    const out = capture();
    const data: AttributedRevenue = {
      ...DATA,
      includeTest: true,
      rows: [...DATA.rows.map((r) => ({ ...r, test: false })), row("2026-10-04", "1234567890", "1234567890", "12323222", 4.99, 3, { test: true })],
    };
    const { fetch, calls } = mockFetch({ "GET /revenue/attributed": data });
    expect(await run(["attribution", "--include-test", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[0].url.searchParams.get("includeTest")).toBe("true");
    expect(out.stdout).toContain("test data included");
    expect(out.stdout).toMatch(/1234567890 \[test\]\s+\$4\.99/);
    expect(out.stdout).toContain("(8 test installs included)");
    out.stdout = "";
    expect(await run(["attribution", "--include-test", "--json"], { env: loggedInEnv(), fetch })).toBe(0);
    const j = JSON.parse(out.stdout);
    expect(j.includeTest).toBe(true);
    expect(j.groups.find((g: any) => g.campaignId === "1234567890")).toMatchObject({ test: true, revenue: 4.99 });
    expect(j.groups.find((g: any) => g.campaignId === "10")).toMatchObject({ campaignName: "Brand Search" });
  });

  it("parses CSV, TSV and JSON name files", () => {
    expect(parseNamesFile('kind,id,name\ncampaign,1,"Brand, US"\nad group,2,Exact\nkeywords,3,photo editor, free\n')).toEqual([
      { kind: "campaign", id: "1", name: "Brand, US" },
      { kind: "adgroup", id: "2", name: "Exact" },
      { kind: "keyword", id: "3", name: "photo editor, free" },
    ]);
    expect(parseNamesFile("campaign\t1\tBrand\nadgroup\t2\t")).toEqual([
      { kind: "campaign", id: "1", name: "Brand" },
      { kind: "adgroup", id: "2", name: "" },
    ]);
    expect(parseNamesFile('{"names":[{"kind":"keyword","id":9,"name":"x"}]}')).toEqual([{ kind: "keyword", id: "9", name: "x" }]);
    expect(() => parseNamesFile("creative,1,x")).toThrow(/Line 1/);
    expect(() => parseNamesFile("campaign,abc,x")).toThrow(/Line 1/);
  });

  it("names lists; names import sends batches of 1000 and reports the counts", async () => {
    const out = capture();
    const puts: any[] = [];
    const { fetch } = mockFetch({
      "GET /attribution/names": { names: [{ kind: "campaign", id: "10", name: "Brand Search" }] },
      "PUT /attribution/names": (call: any) => {
        puts.push(call.body);
        return { updated: call.body.names.length - 1, deleted: 1 };
      },
    });
    expect(await run(["attribution", "names", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toMatch(/campaign\s+10\s+Brand Search/);
    const dir = mkdtempSync(join(tmpdir(), "rf-names-"));
    const file = join(dir, "names.csv");
    writeFileSync(file, ["kind,id,name", ...Array.from({ length: 1500 }, (_, i) => `keyword,${1000 + i},kw ${i}`)].join("\n"));
    out.stdout = "";
    expect(await run(["attribution", "names", "import", file, "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(puts.map((b) => b.names.length)).toEqual([1000, 500]);
    expect(out.stdout).toContain("1,500 names read: 1,498 saved, 2 removed, 0 unchanged");
    out.stdout = "";
    expect(await run(["attribution", "names", "import", "-", "--json"], { env: loggedInEnv(), fetch, readStdin: async () => "campaign,5,Five\n" })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ names: 1, updated: 0, deleted: 1 });
    expect(await run(["attribution", "names", "import"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(await run(["attribution", "bogus"], { env: loggedInEnv(), fetch })).toBe(2);
  });
});

describe("sdk keys", () => {
  const routes = {
    "GET /apps": APPS,
    "GET /apps/app_1": { ...APPS.items[0], products: [] },
    "POST /apps/app_1/sdk-key": { sdkKey: "rfp_new" },
  };

  it("app --sdk-key and sdk-key print the key", async () => {
    const out = capture();
    const { fetch } = mockFetch(routes);
    expect(await run(["app", "com.example.mini", "--sdk-key"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toBe("rfp_old\n");
    out.stdout = "";
    expect(await run(["sdk-key", "Photo Lab"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toBe("rfp_old\n");
    out.stdout = "";
    expect(await run(["app", "com.example.mini", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toMatch(/SDK key\s+rfp_old/);
  });

  it("--rotate needs --yes, then posts and prints the new key", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch(routes);
    expect(await run(["sdk-key", "app_1", "--rotate"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(out.stderr).toContain("--yes");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(await run(["sdk-key", "app_1", "--rotate", "--yes"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url.pathname)).toEqual(["/api/v1/apps/app_1/sdk-key"]);
    expect(out.stdout).toBe("rfp_new\n");
    expect(out.stderr).toContain("rfp_old no longer works");
    out.stdout = "";
    expect(await run(["sdk-key", "app_1", "--rotate", "--yes", "--json"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ appId: "app_1", sdkKey: "rfp_new", previous: "rfp_old", rotated: true });
  });
});
