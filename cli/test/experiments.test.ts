import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fmtLift } from "../src/commands/experiments.js";
import { run } from "../src/main.js";
import type { Experiment, ExperimentResults } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.exp")], currency: "USD" };
const T = Date.UTC(2026, 9, 1);
const EXP: Experiment = {
  id: "exp_0123456789ab",
  appId: "app_1",
  name: "Paywall copy",
  hypothesis: "Bold converts better",
  keys: ["paywall_variant"],
  variants: [
    { id: "a", name: "Control", weight: 50, values: {} },
    { id: "b", name: "Bold", weight: 50, values: { paywall_variant: "bold" } },
  ],
  targeting: "china",
  traffic: 80,
  primaryMetric: "paid",
  status: "running",
  startedAt: T,
  stoppedAt: null,
  endsAt: T + 90 * 86_400_000,
  rolledOutVariant: null,
  createdAt: T,
  updatedAt: T,
};
const variant = (v: string, name: string, exposed: number, paid: number, pBest: number, lift: ExperimentResults["variants"][number]["lift"]["paid"]) => ({
  variant: v,
  name,
  weight: 50,
  exposed,
  capped: false,
  firstExposureAt: T,
  lastExposureAt: T + 9 * 86_400_000,
  trials: 10,
  trialRate: 10 / exposed,
  paid,
  paidRate: paid / exposed,
  revenue: paid * 9.99,
  proceeds: paid * 8.49,
  revenuePerInstall: (paid * 9.99) / exposed,
  proceedsPerInstall: (paid * 8.49) / exposed,
  revenuePerInstallInterval: { low: (paid * 9.99) / exposed / 2, high: ((paid * 9.99) / exposed) * 1.5 },
  refunds: { transactions: paid + 1, refunded: 1, installs: 1, gross: (paid + 1) * 9.99, amount: 9.99, countRate: 1 / (paid + 1), amountRate: 1 / (paid + 1) },
  products: [
    { productId: "com.example.annual", kind: "conversion" as const, transactions: paid, refunded: 0, installs: 0, gross: paid * 9.99, amount: 0, countRate: 0, amountRate: 0, revenue: paid * 9.99 },
    { productId: "com.example.weekly", kind: "new" as const, transactions: 1, refunded: 1, installs: 1, gross: 9.99, amount: 9.99, countRate: 1, amountRate: 1, revenue: 0 },
  ],
  probabilityBest: { trial_started: 0.5, paid: pBest, revenue_per_install: pBest },
  lift: { trial_started: null, paid: lift, revenue_per_install: lift },
});
const RESULTS: ExperimentResults = {
  experimentId: EXP.id,
  status: "running",
  primaryMetric: "paid",
  currency: "USD",
  from: T,
  to: T + 10 * 86_400_000,
  daysRunning: 10,
  installsCounted: 240,
  exposureFrom: T,
  exposureTo: T + 9 * 86_400_000,
  variants: [variant("a", "Control", 120, 3, 0.002, null), variant("b", "Bold", 120, 12, 0.998, { expected: 2.5, low: 0.4, high: 6.1 })],
  enoughData: true,
  reasons: [],
  confident: { variant: "b", probability: 0.998 },
  exposureSource: "events",
  approximate: false,
  notes: [],
  daily: [],
  frozen: false,
  generatedAt: T,
};

describe("experiments", () => {
  it("lists, shows and reads results", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/experiments": { items: [EXP] }, [`GET /apps/app_1/experiments/${EXP.id}`]: EXP, [`GET /apps/app_1/experiments/${EXP.id}/results`]: RESULTS });
    const env = loggedInEnv();
    expect(await run(["experiments", "com.example.exp", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/exp_0123456789ab\s+Paywall copy\s+running\s+paywall_variant\s+2\s+paid/);
    out.stdout = "";
    expect(await run(["experiments", "app_1", "show", EXP.id, "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain('traffic 80% of "china"');
    expect(out.stdout).toMatch(/a\s+Control\s+50%\s+paywall_variant=\(current\)/);
    expect(out.stdout).toMatch(/b\s+Bold\s+50%\s+paywall_variant="bold"/);
    out.stdout = "";
    expect(await run(["experiments", "app_1", "results", EXP.id, "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/b Bold\s+120\s+8\.33%\s+10%\s+\$0\.999\s+\$0\.500 to \$1\.499\s+1 \(7\.7%\)\s+99\.8%\s+\+250\.0% \(\+40\.0% to \+610\.0%\)/);
    expect(out.stdout).toContain("240 exposed installs counted · first exposures 2026-10-01 to 2026-10-10 (UTC) · all of them");
    expect(out.stdout).toContain("refunds subtracted");
    expect(out.stdout).toMatch(/b\s+com\.example\.annual\s+trial → paid\s+12\s+0\s+0%\s+\$0\.00\s+0%\s+\$119\.88/);
    expect(out.stdout).toMatch(/b\s+all products\s+-\s+13\s+1\s+7\.7%\s+\$9\.99\s+7\.7%\s+\$119\.88/);
    expect(out.stdout).toContain("Confident: variant b is best with 99.8% probability.");
    out.stdout = "";
    const waiting = { ...RESULTS, enoughData: false, confident: null, reasons: ["Running for 3 of at least 7 days."] };
    const { fetch: f2 } = mockFetch({ "GET /apps": APPS, [`GET /apps/app_1/experiments/${EXP.id}/results`]: waiting });
    expect(await run(["experiments", "app_1", "results", EXP.id, "--no-color"], { env, fetch: f2 })).toBe(0);
    expect(out.stdout).toContain("Not enough data yet: Running for 3 of at least 7 days.");
    expect(out.stdout).not.toContain("99.8%");
  });

  it("creates from a file, starts, stops, rolls out and archives", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "POST /apps/app_1/experiments": { ...EXP, status: "draft", startedAt: null, endsAt: null },
      [`POST /apps/app_1/experiments/${EXP.id}/start`]: EXP,
      [`POST /apps/app_1/experiments/${EXP.id}/stop`]: { ...EXP, status: "stopped" },
      [`POST /apps/app_1/experiments/${EXP.id}/rollout`]: { ...EXP, status: "rolled_out", rolledOutVariant: "b" },
      [`POST /apps/app_1/experiments/${EXP.id}/archive`]: { ...EXP, status: "archived" },
    });
    const env = loggedInEnv();
    const dir = mkdtempSync(join(tmpdir(), "revflare-exp-"));
    const file = join(dir, "exp.json");
    const body = { name: "Paywall copy", keys: ["paywall_variant"], variants: [{}, { values: { paywall_variant: "bold" } }] };
    writeFileSync(file, JSON.stringify(body));
    expect(await run(["experiments", "app_1", "create", "--file", file, "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual(body);
    expect(out.stdout).toContain(`Created draft ${EXP.id}`);
    expect(await run(["experiments", "app_1", "start", EXP.id, "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.url.pathname).toMatch(/\/start$/);
    expect(await run(["experiments", "app_1", "stop", EXP.id, "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain("devices keep their variant");
    expect(await run(["experiments", "app_1", "rollout", EXP.id, "b", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ variant: "b" });
    expect(out.stdout).toContain('Rolled out variant b (Bold): paywall_variant="bold" are now the defaults.');
    expect(await run(["experiments", "app_1", "archive", EXP.id, "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain("Archived: Paywall copy");
    // Usage errors.
    expect(await run(["experiments", "app_1", "create"], { env, fetch })).toBe(2);
    expect(await run(["experiments", "app_1", "rollout", EXP.id], { env, fetch })).toBe(2);
    expect(await run(["experiments", "app_1", "explode"], { env, fetch })).toBe(2);
  });

  it("formats lifts", () => {
    expect(fmtLift(null)).toBe("-");
    expect(fmtLift({ expected: -0.05, low: -0.2, high: 0.1 })).toContain("−5.0%");
  });
});
