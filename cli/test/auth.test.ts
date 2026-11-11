import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
import { capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const ME = {
  user: { id: "u1", name: "Alex", email: "hi@example.com", isAdmin: true },
  workspace: { id: "ws1", name: "Apps", role: "owner", currency: "EUR", permissions: ["read", "manage"] },
  workspaces: [],
  auth: "api_key",
  version: "0.1.0",
  apiVersion: 1,
  features: { push: true },
};

describe("login / whoami / mcp", () => {
  it("login checks the key, saves a 0600 profile; whoami and mcp use it", async () => {
    const out = capture();
    const path = join(mkdtempSync(join(tmpdir(), "revflare-login-")), "config.json");
    const env = { REVFLARE_CONFIG: path };
    const { fetch, calls } = mockFetch({ "GET /me": ME });
    expect(await run(["login", "--url", "rf.example.com/api", "--key", "rf_secret"], { env, fetch, readStdin: async () => null })).toBe(0);
    expect(calls[0].url.toString()).toBe("https://rf.example.com/api/v1/me");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ current: "default", profiles: { default: { url: "https://rf.example.com", key: "rf_secret" } } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(out.stdout).toContain("Workspace: Apps (owner, EUR)");

    out.stdout = "";
    expect(await run(["whoami", "--json"], { env, fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ url: "https://rf.example.com", key: "rf_secr…", workspace: { currency: "EUR" } });

    out.stdout = "";
    expect(await run(["mcp"], { env })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ mcpServers: { revflare: { type: "http", url: "https://rf.example.com/mcp", headers: { Authorization: "Bearer rf_secret" } } } });
  });

  it("env vars override the profile; a rejected key fails the login", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /me": ME });
    expect(await run(["whoami"], { env: { ...loggedInEnv(), REVFLARE_URL: "https://other.test", REVFLARE_API_KEY: "rf_env" }, fetch })).toBe(0);
    expect(calls[0].url.host).toBe("other.test");
    expect(calls[0].headers.authorization).toBe("Bearer rf_env");
    const bad = mockFetch({});
    expect(await run(["login", "--url", "https://x.test", "--key", "rf_bad"], { env: { REVFLARE_CONFIG: "/nonexistent/c.json" }, fetch: bad.fetch, readStdin: async () => null })).toBe(1);
    expect(out.stderr).toContain("Login failed");
  });
});
