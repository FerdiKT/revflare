import { describe, expect, it } from "vitest";
import { call, ownerClient, sessionCookie } from "./helpers";

describe("access", () => {
  it("rejects anonymous requests and a second setup", async () => {
    await ownerClient();
    expect((await call(null, "/api/v1/overview")).status).toBe(401);
    const again = await call(null, "/api/v1/auth/setup", { body: { name: "X", email: "x@rf.test", password: "password123" } });
    expect(again.status).toBe(409);
  });

  it("pairs the iOS app with a QR code, once", async () => {
    const owner = await ownerClient();
    const code = await call(owner, "/api/v1/pairing-codes", { method: "POST", headers: { origin: "https://rf.test" } });
    expect(code.status).toBe(200);
    expect(code.json.url).toContain("revflare://pair?server=");
    const pair = await call(null, "/api/v1/auth/pair", { body: { code: code.json.code, deviceName: "iPhone" } });
    expect(pair.status).toBe(200);
    expect(pair.json.token).toMatch(/^rfd_/);
    expect((await call(null, "/api/v1/auth/pair", { body: { code: code.json.code } })).status).toBe(400);
    const device = { token: pair.json.token };
    const me = await call(device, "/api/v1/me");
    expect(me.json.auth).toBe("device");
    expect(me.json.workspace.id).toBe(owner.workspaceId);
    // Register for push, then update preferences.
    const reg = await call(device, "/api/v1/devices", { body: { apnsToken: "ab".repeat(32), environment: "sandbox", prefs: { minUsd: 5, sound: "default" } } });
    expect(reg.status).toBe(200);
    expect(reg.json.prefs).toMatchObject({ minUsd: 5, sound: "default", sales: true });
    const upd = await call(device, `/api/v1/devices/${reg.json.id}`, { method: "PATCH", body: { prefs: { trials: false, quietStart: "23:00", quietEnd: "08:00" }, activityToken: "cd".repeat(40) } });
    expect(upd.json.prefs).toMatchObject({ trials: false, minUsd: 5, quietStart: "23:00" });
    expect(upd.json.liveActivity).toBe(true);
    // Device sign-in with a password works too.
    const pw = await call(null, "/api/v1/auth/device", { body: { email: owner.email, password: owner.password, deviceName: "iPad" } });
    expect(pw.status).toBe(200);
    expect((await call(null, "/api/v1/auth/device", { body: { email: owner.email, password: "wrong-password" } })).status).toBe(401);
  });

  it("keeps workspaces apart and enforces roles", async () => {
    const owner = await ownerClient();
    const ws2 = await call(owner, "/api/v1/workspaces", { body: { name: "Second", currency: "EUR" } });
    expect(ws2.json.currency).toBe("EUR");
    expect(ws2.status).toBe(200);
    const app = await call({ ...owner, ws: ws2.json.id }, "/api/v1/apps", { body: { name: "Hidden", bundleId: "app.test.hidden" } });
    expect(app.status).toBe(201);
    // Invite a viewer to the second workspace.
    const inv = await call({ ...owner, ws: ws2.json.id }, "/api/v1/invitations", { body: { role: "viewer" } });
    const token = inv.json.url.split("/invite/")[1];
    const acc = await call(null, "/api/v1/auth/invitations/accept", { body: { token, name: "Viewer", email: "viewer@rf.test", password: "password123" } });
    expect(acc.status).toBe(200);
    const viewer = { cookie: sessionCookie(acc.headers), ws: ws2.json.id };
    expect((await call(viewer, "/api/v1/apps")).json.items.map((a: any) => a.name)).toEqual(["Hidden"]);
    expect((await call(viewer, "/api/v1/apps", { body: { name: "X", bundleId: "app.x" } })).status).toBe(403);
    expect((await call(viewer, "/api/v1/credentials")).status).toBe(403);
    // The viewer is not a member of the owner's first workspace.
    expect((await call({ cookie: viewer.cookie, ws: owner.workspaceId }, "/api/v1/apps")).status).toBe(404);
    expect((await call({ ...owner, ws: undefined }, "/api/v1/me")).json.workspace.id).toBe(ws2.json.id);
    // API keys are bound to their workspace.
    const key = await call(viewer, "/api/v1/api-keys", { body: { name: "cli" } });
    expect(key.json.token).toMatch(/^rf_/);
    const byKey = await call({ token: key.json.token, ws: owner.workspaceId }, "/api/v1/apps");
    expect(byKey.json.items.map((a: any) => a.name)).toEqual(["Hidden"]);
    // Cross-site browser mutations are blocked.
    expect((await call(owner, "/api/v1/workspaces", { body: { name: "Evil" }, headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("serves the MCP tools to API keys only", async () => {
    const owner = await ownerClient();
    const key = await call(owner, "/api/v1/api-keys", { body: { name: "mcp" } });
    const list = await call({ token: key.json.token }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(list.json.result.tools.map((t: any) => t.name)).toContain("get_overview");
    const ov = await call({ token: key.json.token }, "/mcp", { body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_overview", arguments: {} } } });
    expect(ov.json.result.isError).toBeUndefined();
    expect(JSON.parse(ov.json.result.content[0].text).currency).toBe("USD");
    expect((await call(owner, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status).toBe(401);
  });
});
