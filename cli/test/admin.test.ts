import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
import { capture, loggedInEnv, mockFetch, reply } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const at = () => new Date(Date.UTC(2026, 9, 17, 12));
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 17, 12);

const ME = {
  user: { id: "u1", name: "Alex", email: "alex@example.com", isAdmin: true },
  workspace: { id: "ws1", name: "Apps", role: "owner", currency: "USD", permissions: ["read", "manage", "members", "delete"] },
  workspaces: [],
  auth: "device",
  version: "0.1.0",
  apiVersion: 1,
  features: { push: false },
};

/** Env with a profile signed in with a device token (revflare login --email). */
function deviceEnv(): NodeJS.ProcessEnv {
  const env = loggedInEnv();
  const path = env.REVFLARE_CONFIG!;
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  cfg.profiles.default.key = "rfd_devicetoken";
  writeFileSync(path, JSON.stringify(cfg));
  return env;
}

const OVERVIEW = {
  generatedAt: NOW,
  counts: { users: 3, activeUsers: 3, disabledUsers: 0, admins: 1, activeLast30d: 2, workspaces: 2, apps: 5, archivedApps: 1, apiKeys: 4, devices: 2 },
  sales: { purchases: 12_345, purchases30d: 678, revenue30dUsd: 4321.5, firstDay: "2025-01-01" },
  recentSignups: [],
  recentLogins: [],
  jobs: { queued: 1, running: 0, failed7d: 1, recentFailed: [{ id: "job_1", kind: "apple_backfill", workspaceId: "ws1", workspaceName: "Apps", error: "Apple answered 401", at: NOW - 2 * H }] },
  alerts: { open: 2 },
  cron: { lastRunAt: NOW - 3 * 60_000, durationMs: 800, stale: false },
  usage: {
    database: { size: 52_400_000, since: NOW - 5 * H, rowsRead: 1000, rowsWritten: 100 },
    background: { rowsRead: 900, rowsWritten: 10, readBudget: 1_000_000, writeBudget: 20_000 },
    freePlan: { rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000, resetsAt: "00:00 UTC" },
  },
  version: { version: "0.1.0", commit: "abc1234", apiVersion: 1 },
  update: {
    current: "0.1.0",
    commit: "abc1234",
    latest: "0.2.0",
    updateAvailable: true,
    url: "https://github.com/FerdiKT/revflare/releases/tag/v0.2.0",
    publishedAt: null,
    checkedAt: NOW - H,
    status: "ok",
    message: null,
    enabled: true,
    repo: "FerdiKT/revflare",
  },
};

describe("admin commands", () => {
  it("admin overview prints counts, jobs, database and the update status", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /admin/overview": OVERVIEW });
    expect(await run(["admin", "overview", "--no-color"], { env: deviceEnv(), fetch, now: at })).toBe(0);
    expect(calls[0].url.pathname).toBe("/api/v1/admin/overview");
    expect(calls[0].headers.authorization).toBe("Bearer rfd_devicetoken");
    expect(out.stdout).toMatch(/Users\s+3 \(2 active in 30 days, 1 admin\)/);
    expect(out.stdout).toMatch(/Apps\s+5 \(\+1 archived\)/);
    expect(out.stdout).toContain("apple_backfill in Apps: Apple answered 401");
    expect(out.stdout).toContain("52.4 MB");
    expect(out.stdout).toContain("v0.2.0 available: https://github.com/FerdiKT/revflare/releases/tag/v0.2.0");
    out.stdout = "";
    expect(await run(["admin", "overview", "--json"], { env: deviceEnv(), fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(OVERVIEW);
  });

  it("admin users and admin workspaces print tables", async () => {
    const out = capture();
    const users = [
      { id: "usr_1", name: "Alex", email: "alex@example.com", isAdmin: true, status: "active", createdAt: NOW - 100 * 24 * H, lastLoginAt: NOW - 2 * H, workspaces: [{ id: "ws1", name: "Apps", role: "owner" }] },
      { id: "usr_2", name: "Sam", email: "sam@example.com", isAdmin: false, status: "disabled", createdAt: NOW - 10 * 24 * H, lastLoginAt: null, workspaces: [] },
    ];
    const workspaces = [{ id: "ws1", name: "Apps", currency: "USD", createdAt: NOW - 100 * 24 * H, members: 2, owners: [{ id: "usr_1", name: "Alex", email: "alex@example.com" }], apps: 5, apiKeys: 1 }];
    const { fetch } = mockFetch({ "GET /admin/users": { items: users }, "GET /admin/workspaces": { items: workspaces } });
    expect(await run(["admin", "users", "--no-color"], { env: deviceEnv(), fetch, now: at })).toBe(0);
    const lines = out.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^ID\s+NAME\s+EMAIL\s+ADMIN\s+STATUS\s+LAST SIGN-IN\s+WORKSPACES$/);
    expect(lines[1]).toMatch(/usr_1\s+Alex\s+alex@example.com\s+yes\s+active\s+.*Apps \(owner\)/);
    expect(lines[2]).toMatch(/usr_2\s+Sam\s+sam@example.com\s+-\s+disabled\s+never/);
    out.stdout = "";
    expect(await run(["admin", "workspaces", "--no-color"], { env: deviceEnv(), fetch, now: at })).toBe(0);
    expect(out.stdout).toMatch(/ws1\s+Apps\s+USD\s+alex@example.com\s+2\s+5/);
  });

  it("explains how to sign in when an API key gets 403", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /admin/users": reply(403, { error: "Only instance admins can do this" }) });
    expect(await run(["admin", "users"], { env: loggedInEnv(), fetch })).toBe(1);
    expect(out.stderr).toContain("revflare login --email");
    out.stderr = "";
    expect(await run(["admin", "users"], { env: deviceEnv(), fetch })).toBe(1);
    expect(out.stderr).toContain("Only instance admins can do this (instance admins only)");
  });

  it("is listed in the help", async () => {
    const out = capture();
    expect(await run(["--help"], {})).toBe(0);
    expect(out.stdout).toContain("admin overview");
    expect(out.stdout).toContain("admin users");
    expect(out.stdout).toContain("admin workspaces");
  });
});

describe("login --email", () => {
  it("trades email + password for a device token and saves it; logout ends it on the server", async () => {
    const out = capture();
    const path = join(mkdtempSync(join(tmpdir(), "revflare-login-")), "config.json");
    const env = { REVFLARE_CONFIG: path };
    const { fetch, calls } = mockFetch({ "POST /auth/device": { token: "rfd_abc", user: ME.user, workspace: null, server: "https://rf.test" }, "GET /me": ME, "POST /auth/logout": { ok: true } });
    expect(await run(["login", "--url", "https://rf.test", "--email", "alex@example.com"], { env, fetch, readStdin: async () => "s3cret-pass\n" })).toBe(0);
    expect(calls[0].body).toEqual({ email: "alex@example.com", password: "s3cret-pass", deviceName: "revflare CLI" });
    expect(calls[1].headers.authorization).toBe("Bearer rfd_abc");
    expect(JSON.parse(readFileSync(path, "utf8")).profiles.default).toEqual({ url: "https://rf.test", key: "rfd_abc" });
    expect(out.stdout).toContain("device token");
    expect(await run(["logout"], { env, fetch })).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: "POST", headers: { authorization: "Bearer rfd_abc" } });
    expect(calls.at(-1)!.url.pathname).toBe("/api/v1/auth/logout");
  });

  it("reports a wrong password and refuses --key with --email", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "POST /auth/device": reply(401, { error: "Wrong email or password" }) });
    const env = { REVFLARE_CONFIG: join(mkdtempSync(join(tmpdir(), "revflare-login-")), "config.json") };
    expect(await run(["login", "--url", "https://rf.test", "--email", "alex@example.com"], { env, fetch, readStdin: async () => "nope" })).toBe(1);
    expect(out.stderr).toContain("Login failed: Wrong email or password");
    expect(out.stderr).not.toContain("API key");
    expect(await run(["login", "--url", "https://rf.test", "--email", "a@b.c", "--key", "rf_x"], { env, fetch })).toBe(2);
  });
});
