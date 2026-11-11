import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../worker/lib/db";
import { checkForUpdatesNow } from "../../worker/lib/updates";
import { call, ownerClient, sessionCookie, type Client } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

let n = 0;

/** A new user through an invitation link; returns their session, email and password. */
async function invitedUser(admin: Client, body: Record<string, unknown>, path = "/api/v1/admin/invitations") {
  const email = `user${++n}-${Date.now()}@rf.test`;
  const password = "password123";
  const inv = await call(admin, path, { body });
  expect(inv.status).toBeLessThan(300);
  const token = inv.json.url.split("/invite/")[1];
  const acc = await call(null, "/api/v1/auth/invitations/accept", { body: { token, name: `User ${n}`, email, password } });
  expect(acc.status).toBe(200);
  const me = await call({ cookie: sessionCookie(acc.headers) }, "/api/v1/me");
  return { cookie: sessionCookie(acc.headers), email, password, id: me.json.user.id as string, workspaceId: acc.json.workspaceId as string };
}

describe("admin access", () => {
  it("is for instance admins with a session, never for API keys", async () => {
    const owner = await ownerClient();
    expect((await call(owner, "/api/v1/admin/overview")).status).toBe(200);
    const key = await call(owner, "/api/v1/api-keys", { body: { name: "admin-cli" } });
    for (const path of ["/api/v1/admin/overview", "/api/v1/admin/users", "/api/v1/admin/workspaces", "/api/v1/admin/usage", "/api/v1/admin/updates"]) {
      expect((await call({ token: key.json.token }, path)).status).toBe(403);
    }
    expect((await call({ token: key.json.token }, "/api/v1/admin/users/x", { method: "PATCH", body: { isAdmin: true } })).status).toBe(403);
    // A workspace member who is not an instance admin.
    const viewer = await invitedUser(owner, { role: "viewer" }, "/api/v1/invitations");
    expect((await call(viewer, "/api/v1/admin/users")).status).toBe(403);
    expect((await call(viewer, "/api/v1/admin/invitations", { body: {} })).status).toBe(403);
    expect((await call(null, "/api/v1/admin/overview")).status).toBe(401);
  });

  it("serves the overview without scanning transactions", async () => {
    const owner = await ownerClient();
    const r = await call(owner, "/api/v1/admin/overview");
    expect(r.status).toBe(200);
    expect(r.json.counts.users).toBeGreaterThanOrEqual(1);
    expect(r.json.counts.admins).toBeGreaterThanOrEqual(1);
    expect(r.json.counts.workspaces).toBeGreaterThanOrEqual(1);
    expect(r.json).toMatchObject({
      sales: { purchases: expect.any(Number), purchases30d: expect.any(Number), revenue30dUsd: expect.any(Number) },
      jobs: { queued: expect.any(Number), running: expect.any(Number), failed7d: expect.any(Number), recentFailed: expect.any(Array) },
      alerts: { open: expect.any(Number) },
      cron: { stale: expect.any(Boolean) },
      usage: { background: { readBudget: expect.any(Number) }, freePlan: { rowsReadPerDay: 5_000_000 } },
      version: { version: expect.any(String), apiVersion: 1 },
      update: { repo: "FerdiKT/revflare", enabled: true },
    });
    expect(r.json.recentSignups[0]).toMatchObject({ id: expect.any(String), email: expect.any(String) });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await call(null, "/api/v1/version")).json).toMatchObject({ version: expect.any(String), commit: expect.any(String), apiVersion: 1 });
  });
});

describe("admin users", () => {
  it("guards the last admin and the admin's own account", async () => {
    const owner = await ownerClient();
    const users = await call(owner, "/api/v1/admin/users");
    const me = users.json.items.find((u: any) => u.email === owner.email);
    expect(me).toMatchObject({ isAdmin: true, status: "active", workspaces: expect.arrayContaining([expect.objectContaining({ name: "Apps", role: "owner" })]) });
    const self = `/api/v1/admin/users/${me.id}`;
    const demote = await call(owner, self, { method: "PATCH", body: { isAdmin: false } });
    expect(demote.status).toBe(409);
    expect(demote.json.error).toContain("at least one active admin");
    expect((await call(owner, self, { method: "PATCH", body: { status: "disabled" } })).status).toBe(403);
    expect((await call(owner, self, { method: "DELETE" })).status).toBe(403);
    expect((await call(owner, "/api/v1/admin/users/usr_nobody", { method: "PATCH", body: { isAdmin: true } })).status).toBe(404);
    expect((await call(owner, "/api/v1/me")).json.user.isAdmin).toBe(true);
  });

  it("disabling ends web and device sessions and stops API keys until re-enabled", async () => {
    const owner = await ownerClient();
    const user = await invitedUser(owner, { workspaceId: owner.workspaceId, role: "viewer" });
    const device = await call(null, "/api/v1/auth/device", { body: { email: user.email, password: user.password } });
    const key = await call({ ...user, ws: owner.workspaceId }, "/api/v1/api-keys", { body: { name: "cli" } });
    expect((await call({ token: device.json.token }, "/api/v1/me")).status).toBe(200);
    expect((await call({ token: key.json.token }, "/api/v1/me")).status).toBe(200);

    const off = await call(owner, `/api/v1/admin/users/${user.id}`, { method: "PATCH", body: { status: "disabled" } });
    expect(off.status).toBe(200);
    expect(off.json.status).toBe("disabled");
    expect((await call(user, "/api/v1/me")).status).toBe(401);
    expect((await call({ token: device.json.token }, "/api/v1/me")).status).toBe(401);
    expect((await call({ token: key.json.token }, "/api/v1/me")).status).toBe(401);
    expect((await call(null, "/api/v1/auth/login", { body: { email: user.email, password: user.password } })).status).toBe(403);

    const on = await call(owner, `/api/v1/admin/users/${user.id}`, { method: "PATCH", body: { status: "active" } });
    expect(on.json.status).toBe("active");
    // API keys come back; sessions stay ended.
    expect((await call({ token: key.json.token }, "/api/v1/me")).status).toBe(200);
    expect((await call(user, "/api/v1/me")).status).toBe(401);
    expect((await call({ token: device.json.token }, "/api/v1/me")).status).toBe(401);
  });

  it("resets a password: a one-time password, old sessions end", async () => {
    const owner = await ownerClient();
    const user = await invitedUser(owner, { workspaceId: owner.workspaceId, role: "viewer" });
    const r = await call(owner, `/api/v1/admin/users/${user.id}`, { method: "PATCH", body: { resetPassword: true } });
    expect(r.status).toBe(200);
    expect(r.json.password).toMatch(/^[\w]{4}-[\w]{4}-[\w]{4}-[\w]{4}$/);
    expect((await call(user, "/api/v1/me")).status).toBe(401);
    expect((await call(null, "/api/v1/auth/login", { body: { email: user.email, password: user.password } })).status).toBe(401);
    expect((await call(null, "/api/v1/auth/login", { body: { email: user.email, password: r.json.password } })).status).toBe(200);
    // The password is never part of the user list.
    const list = await call(owner, "/api/v1/admin/users");
    expect(JSON.stringify(list.json)).not.toContain(r.json.password);
  });

  it("refuses to disable or delete the only owner of a workspace", async () => {
    const owner = await ownerClient();
    const info = await call(owner, "/api/v1/admin/invitations", { body: { newWorkspaceName: "Solo Studio" } });
    const token = info.json.url.split("/invite/")[1];
    const lookup = await call(null, `/api/v1/auth/invitations/${token}`);
    expect(lookup.json).toMatchObject({ newWorkspace: true, newWorkspaceName: "Solo Studio", isAdmin: false });
    const email = `solo-${Date.now()}@rf.test`;
    const acc = await call(null, "/api/v1/auth/invitations/accept", { body: { token, name: "Solo", email, password: "password123" } });
    expect(acc.status).toBe(200);
    const solo = { cookie: sessionCookie(acc.headers) };
    const me = await call(solo, "/api/v1/me");
    expect(me.json.workspace).toMatchObject({ name: "Solo Studio", role: "owner" });
    // The link works once.
    expect((await call(null, "/api/v1/auth/invitations/accept", { body: { token, name: "X", email: "x2@rf.test", password: "password123" } })).status).toBe(400);

    const del = await call(owner, `/api/v1/admin/users/${me.json.user.id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect(del.json.error).toBe('Solo is the last owner of "Solo Studio". Make someone else owner or delete the workspace first.');
    expect((await call(owner, `/api/v1/admin/users/${me.json.user.id}`, { method: "PATCH", body: { status: "disabled" } })).status).toBe(409);

    // Delete the workspace, then the user.
    expect((await call(owner, `/api/v1/admin/workspaces/${me.json.workspace.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(owner, `/api/v1/admin/users/${me.json.user.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(solo, "/api/v1/me")).status).toBe(401);
    const users = await call(owner, "/api/v1/admin/users");
    expect(users.json.items.some((u: any) => u.email === email)).toBe(false);
  });

  it("invites instance admins, who can then be demoted by another admin", async () => {
    const owner = await ownerClient();
    const admin = await invitedUser(owner, { workspaceId: owner.workspaceId, role: "admin", isAdmin: true });
    const me = await call(admin, "/api/v1/me");
    expect(me.json.user.isAdmin).toBe(true);
    expect((await call(admin, "/api/v1/admin/users")).status).toBe(200);
    const pending = await call(owner, "/api/v1/admin/invitations");
    expect(pending.status).toBe(200);
    const down = await call(owner, `/api/v1/admin/users/${admin.id}`, { method: "PATCH", body: { isAdmin: false } });
    expect(down.json.isAdmin).toBe(false);
    expect((await call(admin, "/api/v1/admin/users")).status).toBe(403);
    expect((await call(owner, `/api/v1/admin/users/${admin.id}`, { method: "DELETE" })).status).toBe(200);
  });
});

describe("admin workspaces and invitations", () => {
  it("lists, creates (with an owner) and deletes workspaces", async () => {
    const owner = await ownerClient();
    const user = await invitedUser(owner, { workspaceId: owner.workspaceId, role: "viewer" });
    const created = await call(owner, "/api/v1/admin/workspaces", { body: { name: "Agency", currency: "EUR", ownerEmail: user.email } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "Agency", currency: "EUR", members: 1, apps: 0, owners: [{ id: user.id, email: user.email }] });
    expect((await call(owner, "/api/v1/admin/workspaces", { body: { name: "X", ownerEmail: "nobody@rf.test" } })).status).toBe(404);
    const list = await call(owner, "/api/v1/admin/workspaces");
    const apps = list.json.items.find((w: any) => w.id === owner.workspaceId);
    expect(apps.owners.map((o: any) => o.email)).toContain(owner.email);
    expect(apps.members).toBeGreaterThanOrEqual(2);
    // Invitations into a workspace: role, and members cannot be invited twice.
    expect((await call(owner, "/api/v1/admin/invitations", { body: { workspaceId: created.json.id, email: user.email } })).status).toBe(409);
    const inv = await call(owner, "/api/v1/admin/invitations", { body: { workspaceId: created.json.id, role: "admin", email: "later@rf.test" } });
    expect(inv.status).toBe(201);
    const pending = await call(owner, "/api/v1/admin/invitations");
    expect(pending.json.items.find((i: any) => i.id === inv.json.id)).toMatchObject({ workspaceName: "Agency", role: "admin", newWorkspaceName: null, isAdmin: false });
    expect((await call(owner, `/api/v1/admin/invitations/${inv.json.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(owner, "/api/v1/admin/invitations", { body: { workspaceId: "ws_nope" } })).status).toBe(404);

    expect((await call(owner, `/api/v1/admin/workspaces/${created.json.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(owner, `/api/v1/admin/workspaces/${created.json.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(owner, "/api/v1/admin/workspaces")).json.items.some((w: any) => w.id === created.json.id)).toBe(false);
  });
});

describe("update check", () => {
  it("stores a 404 (private repository) as a readable status, then a newer release", async () => {
    const owner = await ownerClient();
    fetchMock.get("https://api.github.com").intercept({ path: "/repos/FerdiKT/revflare/releases?per_page=30" }).reply(404, { message: "Not Found" });
    const r = await call(owner, "/api/v1/admin/updates/check", { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "not_found", latest: null, updateAvailable: false, repo: "FerdiKT/revflare", checkedAt: expect.any(Number) });
    expect(r.json.message).toContain("FerdiKT/revflare");
    // A second check within a minute returns the stored result without asking GitHub.
    expect((await call(owner, "/api/v1/admin/updates/check", { method: "POST" })).json.status).toBe("not_found");
    expect((await call(owner, "/api/v1/admin/updates")).json.status).toBe("not_found");

    const releases = [
      { tag_name: "v99.1.0-beta.1", html_url: "https://github.com/FerdiKT/revflare/releases/tag/v99.1.0-beta.1", draft: false, prerelease: true, published_at: "2026-10-01T00:00:00Z" },
      { tag_name: "v99.0.0", html_url: "https://github.com/FerdiKT/revflare/releases/tag/v99.0.0", draft: false, prerelease: false, published_at: "2026-09-01T00:00:00Z" },
      { tag_name: "v100.0.0", html_url: "x", draft: true, prerelease: false, published_at: null },
      { tag_name: "v0.0.1", html_url: "y", draft: false, prerelease: false, published_at: "2025-01-01T00:00:00Z" },
    ];
    const stored = await checkForUpdatesNow(env, getDb(env), async () => new Response(JSON.stringify(releases), { status: 200 }));
    expect(stored).toMatchObject({ status: "ok", latestVersion: "99.0.0" });
    const status = await call(owner, "/api/v1/admin/updates");
    expect(status.json).toMatchObject({ status: "ok", latest: "99.0.0", updateAvailable: true, url: "https://github.com/FerdiKT/revflare/releases/tag/v99.0.0" });
    expect((await call(owner, "/api/v1/admin/overview")).json.update).toMatchObject({ latest: "99.0.0", updateAvailable: true });

    // A network failure keeps the last known release and never throws.
    const failed = await checkForUpdatesNow(env, getDb(env), async () => {
      throw new Error("offline");
    });
    expect(failed).toMatchObject({ status: "error", latestVersion: "99.0.0", message: "Update check failed: offline" });
  });
});
