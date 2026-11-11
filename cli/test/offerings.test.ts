import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportConfig } from "../src/commands/offerings.js";
import { run } from "../src/main.js";
import type { OfferingsChange, OfferingsConfig } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch, reply } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.paywall")], currency: "USD" };
const T = Date.UTC(2026, 9, 20);
const CONFIG: OfferingsConfig = {
  currentOfferingId: "default",
  offerings: [
    {
      identifier: "default",
      displayName: "Default",
      metadata: { title: "Go Pro" },
      packages: [
        { identifier: "$annual", productId: "com.example.paywall.annual", metadata: { badge: "Best value" } },
        { identifier: "$monthly", productId: "com.example.paywall.monthly", metadata: {} },
      ],
      isCurrent: true,
      createdAt: T,
      updatedAt: T,
    },
    { identifier: "sale", displayName: "Sale", metadata: {}, packages: [], isCurrent: false, createdAt: T, updatedAt: T },
  ],
  placements: [
    { identifier: "onboarding", offeringId: "sale" },
    { identifier: "settings", offeringId: null },
  ],
  version: "0123456789ab",
  updatedAt: T,
  preview: { version: "0123456789ab", currentOfferingId: "default", offerings: [], placements: {} },
};
const CHANGE: OfferingsChange = { ...CONFIG, warnings: ['Offering "sale", package "$annual": product "com.example.paywall.x" is not one of the app\'s known App Store products.'] };

describe("exportConfig", () => {
  it("keeps only what PUT takes, placements as a map", () => {
    expect(exportConfig(CONFIG)).toEqual({
      currentOfferingId: "default",
      offerings: [
        { identifier: "default", displayName: "Default", metadata: { title: "Go Pro" }, packages: CONFIG.offerings[0].packages },
        { identifier: "sale", displayName: "Sale", metadata: {}, packages: [] },
      ],
      placements: { onboarding: "sale", settings: null },
    });
  });
});

describe("offerings", () => {
  it("lists offerings and placements, shows one, exports JSON", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/offerings": CONFIG });
    const env = loggedInEnv();
    expect(await run(["offerings", "com.example.paywall", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/default\s+Default\s+● current\s+\$annual com\.example\.paywall\.annual, \$monthly/);
    expect(out.stdout).toMatch(/onboarding\s+sale/);
    expect(out.stdout).toMatch(/settings\s+current \(default\)/);
    out.stdout = "";
    expect(await run(["offerings", "app_1", "show", "default", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain('{"title":"Go Pro"}');
    expect(out.stdout).toMatch(/Placements\s+settings/);
    expect(out.stdout).toMatch(/\$annual\s+com\.example\.paywall\.annual\s+\{"badge":"Best value"\}/);
    expect(await run(["offerings", "app_1", "show", "nope"], { env, fetch })).toBe(1);
    out.stdout = "";
    expect(await run(["offerings", "app_1", "export"], { env, fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(exportConfig(CONFIG));
  });

  it("apply sends the file (or stdin) as a PUT and prints warnings", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "PUT /apps/app_1/offerings": CHANGE });
    const env = loggedInEnv();
    const file = join(mkdtempSync(join(tmpdir(), "revflare-offerings-")), "offerings.json");
    const body = exportConfig(CONFIG);
    writeFileSync(file, JSON.stringify(body));
    expect(await run(["offerings", "app_1", "apply", file, "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("PUT");
    expect(calls.at(-1)!.body).toEqual(body);
    expect(out.stdout).toContain("Applied. 2 offerings, current: default, 2 placements");
    expect(out.stdout).toContain("warning: Offering \"sale\"");
    const readStdin = async () => JSON.stringify({ offerings: [] });
    expect(await run(["offerings", "app_1", "apply", "-"], { env, fetch, readStdin })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ offerings: [] });
    expect(await run(["offerings", "app_1", "apply", "-"], { env, fetch, readStdin: async () => "{nope" })).toBe(1);
    expect(out.stderr).toContain("not valid JSON");
  });

  it("current and placements set / rm call their endpoints; errors pass through", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "POST /apps/app_1/offerings/sale/current": { ...CHANGE, currentOfferingId: "sale", warnings: [] },
      "PUT /apps/app_1/placements/onboarding": { ...CHANGE, warnings: [] },
      "DELETE /apps/app_1/placements/settings": { ...CHANGE, warnings: [] },
      "POST /apps/app_1/offerings/ghost/current": reply(404, { error: 'No offering "ghost"' }),
    });
    const env = loggedInEnv();
    expect(await run(["offerings", "app_1", "current", "sale", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain("sale is now the current offering");
    expect(await run(["offerings", "app_1", "placements", "set", "onboarding", "current", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ offeringId: null });
    expect(await run(["offerings", "app_1", "placements", "set", "onboarding", "sale"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ offeringId: "sale" });
    expect(await run(["offerings", "app_1", "placements", "rm", "settings"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(await run(["offerings", "app_1", "current", "ghost"], { env, fetch })).toBe(1);
    expect(out.stderr).toContain('No offering "ghost"');
  });

  it("rejects unknown actions and wrong argument counts", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS });
    const env = loggedInEnv();
    expect(await run(["offerings", "app_1", "delete"], { env, fetch })).toBe(2);
    expect(await run(["offerings", "app_1", "current"], { env, fetch })).toBe(2);
    expect(await run(["offerings", "app_1", "placements", "set", "onboarding"], { env, fetch })).toBe(2);
    expect(await run(["offerings", "app_1", "placements", "move", "x"], { env, fetch })).toBe(2);
    expect(out.stderr).toContain("placements [set");
  });
});
