// Instance administration (`/api/v1/admin/*`): overview, users, workspaces, instance invitations, usage, the update
// check and instance settings (sign-in links by email). Instance admins only, with a web or iOS session: API keys never reach these routes (requireAdmin).
import { Hono } from "hono";
import type { AdminEmailSettings, AdminInvitation, AdminUser, AdminWorkspace, Role, UserStatus } from "../../shared/types";
import { ROLES, requireAdmin, type AppEnv, type Ctx } from "../lib/auth";
import { hashPassword } from "../lib/crypto";
import type { Db } from "../lib/db";
import {
  activeAdminCount,
  adminOverview,
  adminUsage,
  deleteWorkspace,
  endSessionsStatements,
  lastOwnerMessage,
  soleOwnerWorkspaces,
} from "../lib/admin";
import { MAGIC_LINK_SETTING, emailConfigured, sendError, sender, testEmail } from "../lib/email";
import { baseUrl, getSetting, setSetting } from "../lib/settings";
import { MANUAL_CHECK_INTERVAL, checkForUpdatesNow, readStoredUpdate, updateCheckEnabled, updateStatus } from "../lib/updates";
import { newId, now, randomToken, sha256Hex } from "../lib/util";
import { normalizeEmail, normalizeName } from "./auth";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAdmin);
adminRoutes.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
});

const INVITE_TTL_MS = 7 * 86_400_000;
const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as string[]).includes(r);
const readBody = <T>(c: Ctx) => c.req.json<T>().catch(() => ({}) as T);

adminRoutes.get("/overview", async (c) => c.json(await adminOverview(c.env, c.var.db)));

adminRoutes.get("/usage", async (c) => c.json(await adminUsage(c.env, c.var.db)));

// Users ---------------------------------------------------------------------------------------------------------------

interface UserRow {
  id: string;
  name: string;
  email: string;
  is_admin: number;
  status: UserStatus;
  created_at: number;
  last_login_at: number | null;
}

async function listUsers(db: Db, id?: string): Promise<AdminUser[]> {
  const where = id ? "WHERE u.id = ?" : "";
  const binds = id ? [id] : [];
  const [users, members] = await db.batch<any>([
    db.prepare(`SELECT u.id, u.name, u.email, u.is_admin, u.status, u.created_at, u.last_login_at FROM users u ${where} ORDER BY u.created_at`).bind(...binds),
    db
      .prepare(
        `SELECT m.user_id, w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
         ${id ? "WHERE m.user_id = ?" : ""} ORDER BY w.name COLLATE NOCASE`,
      )
      .bind(...binds),
  ]);
  const byUser = new Map<string, AdminUser["workspaces"]>();
  for (const m of members.results as Array<{ user_id: string; id: string; name: string; role: Role }>) {
    const list = byUser.get(m.user_id) ?? [];
    list.push({ id: m.id, name: m.name, role: m.role });
    byUser.set(m.user_id, list);
  }
  return (users.results as UserRow[]).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    isAdmin: !!u.is_admin,
    status: u.status === "disabled" ? "disabled" : "active",
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    workspaces: byUser.get(u.id) ?? [],
  }));
}

/** A readable one-time password: 4 groups of 4 (no 0/O/1/l). */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

adminRoutes.get("/users", async (c) => c.json({ items: await listUsers(c.var.db) }));

/**
 * PATCH /admin/users/:id { name?, isAdmin?, status?, resetPassword? }. Disabling ends the user's web and iOS sessions
 * (their API keys stop working while disabled); a password reset returns a one-time password and ends the sessions too.
 */
adminRoutes.patch("/users/:id", async (c) => {
  const db = c.var.db;
  const [target] = await listUsers(db, c.req.param("id"));
  if (!target) return c.json({ error: "User not found" }, 404);
  const body = await readBody<{ name?: unknown; isAdmin?: unknown; status?: unknown; resetPassword?: unknown }>(c);
  const self = target.id === c.var.user.id;
  const sets: string[] = [];
  const binds: unknown[] = [];
  const wasAdmin = target.isAdmin && target.status === "active";
  let losesAdmin = false;
  let endSessions = false;

  if (body.name !== undefined) {
    const name = normalizeName(body.name);
    if (!name) return c.json({ error: "Name is required" }, 400);
    sets.push("name = ?") && binds.push(name);
  }
  if (body.isAdmin !== undefined) {
    if (typeof body.isAdmin !== "boolean") return c.json({ error: "isAdmin must be true or false" }, 400);
    if (body.isAdmin !== target.isAdmin) {
      losesAdmin ||= !body.isAdmin;
      sets.push("is_admin = ?") && binds.push(body.isAdmin ? 1 : 0);
    }
  }
  if (body.status !== undefined && body.status !== target.status) {
    if (body.status !== "active" && body.status !== "disabled") return c.json({ error: "status must be active or disabled" }, 400);
    if (self) return c.json({ error: "You cannot disable your own account" }, 403);
    if (body.status === "disabled") {
      losesAdmin = true;
      endSessions = true;
      const owned = await soleOwnerWorkspaces(db, target.id);
      if (owned.length) return c.json({ error: lastOwnerMessage(`${target.name} is`, owned) }, 409);
    }
    sets.push("status = ?") && binds.push(body.status);
  }
  let password: string | null = null;
  if (body.resetPassword === true) {
    password = generatePassword();
    endSessions = true;
    sets.push("password_hash = ?") && binds.push(await hashPassword(password));
  }
  if (wasAdmin && losesAdmin && !(await activeAdminCount(db, target.id))) {
    return c.json({ error: "The instance must keep at least one active admin" }, 409);
  }
  if (sets.length) {
    await db.batch([
      db.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...binds, now(), target.id),
      ...(endSessions ? endSessionsStatements(db, target.id) : []),
    ]);
  }
  const [user] = await listUsers(db, target.id);
  return c.json(password ? { ...user, password } : user);
});

/** Deletes a user: memberships, sessions, devices and API keys go; the workspaces' data stays. */
adminRoutes.delete("/users/:id", async (c) => {
  const db = c.var.db;
  const [target] = await listUsers(db, c.req.param("id"));
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.id === c.var.user.id) return c.json({ error: "You cannot delete your own account" }, 403);
  if (target.isAdmin && target.status === "active" && !(await activeAdminCount(db, target.id))) {
    return c.json({ error: "The instance must keep at least one active admin" }, 409);
  }
  const owned = await soleOwnerWorkspaces(db, target.id);
  if (owned.length) return c.json({ error: lastOwnerMessage(`${target.name} is`, owned) }, 409);
  await db.batch([
    ...endSessionsStatements(db, target.id),
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(target.id),
    db.prepare("DELETE FROM workspace_members WHERE user_id = ?").bind(target.id),
    db.prepare("DELETE FROM users WHERE id = ?").bind(target.id),
  ]);
  return c.json({ ok: true });
});

// Workspaces ----------------------------------------------------------------------------------------------------------

async function listWorkspaces(db: Db, id?: string): Promise<AdminWorkspace[]> {
  const [ws, owners] = await db.batch<any>([
    db
      .prepare(
        `SELECT w.id, w.name, w.currency, w.created_at,
           (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
           (SELECT COUNT(*) FROM apps a WHERE a.workspace_id = w.id AND a.archived = 0) AS apps,
           (SELECT COUNT(*) FROM api_keys k WHERE k.workspace_id = w.id) AS api_keys
         FROM workspaces w ${id ? "WHERE w.id = ?" : ""} ORDER BY w.created_at`,
      )
      .bind(...(id ? [id] : [])),
    db
      .prepare(
        `SELECT m.workspace_id, u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.role = 'owner' ${id ? "AND m.workspace_id = ?" : ""} ORDER BY m.created_at`,
      )
      .bind(...(id ? [id] : [])),
  ]);
  const byWs = new Map<string, AdminWorkspace["owners"]>();
  for (const o of owners.results as Array<{ workspace_id: string; id: string; name: string; email: string }>) {
    const list = byWs.get(o.workspace_id) ?? [];
    list.push({ id: o.id, name: o.name, email: o.email });
    byWs.set(o.workspace_id, list);
  }
  return (ws.results as Array<{ id: string; name: string; currency: string; created_at: number; members: number; apps: number; api_keys: number }>).map((w) => ({
    id: w.id,
    name: w.name,
    currency: w.currency,
    createdAt: w.created_at,
    members: w.members,
    owners: byWs.get(w.id) ?? [],
    apps: w.apps,
    apiKeys: w.api_keys,
  }));
}

adminRoutes.get("/workspaces", async (c) => c.json({ items: await listWorkspaces(c.var.db) }));

/** POST /admin/workspaces { name, currency?, ownerEmail? }: the owner is an existing user (default: you). */
adminRoutes.post("/workspaces", async (c) => {
  const db = c.var.db;
  const body = await readBody<{ name?: unknown; currency?: unknown; ownerEmail?: unknown }>(c);
  const name = normalizeName(body.name);
  if (!name) return c.json({ error: "Name is required" }, 400);
  const currency = body.currency === undefined ? "USD" : typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : null;
  if (!currency) return c.json({ error: "Currency must be a 3-letter code (USD, EUR, TRY...)" }, 400);
  let ownerId = c.var.user.id;
  if (body.ownerEmail !== undefined && body.ownerEmail !== null && body.ownerEmail !== "") {
    const email = normalizeEmail(body.ownerEmail);
    if (!email) return c.json({ error: "Invalid ownerEmail" }, 400);
    const owner = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
    if (!owner) return c.json({ error: `No user with the email ${email}. Invite them instead (POST /admin/invitations).` }, 404);
    ownerId = owner.id;
  }
  const id = newId("ws_");
  const t = now();
  await db.batch([
    db.prepare("INSERT INTO workspaces (id, name, currency, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, name, currency, c.var.user.id, t, t),
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, ownerId, t),
  ]);
  return c.json((await listWorkspaces(db, id))[0], 201);
});

/** Deletes a workspace and all of its data (apps, sales, credentials, members, API keys, invitations). */
adminRoutes.delete("/workspaces/:id", async (c) => {
  const db = c.var.db;
  const ws = await db.prepare("SELECT id FROM workspaces WHERE id = ?").bind(c.req.param("id")).first<{ id: string }>();
  if (!ws) return c.json({ error: "Workspace not found" }, 404);
  await deleteWorkspace(db, ws.id);
  return c.json({ ok: true });
});

// Instance invitations -------------------------------------------------------------------------------------------------

interface InvitationRow {
  id: string;
  email: string | null;
  role: Role;
  workspace_id: string | null;
  workspace_name: string | null;
  new_workspace_name: string | null;
  instance_admin: number;
  created_by_name: string | null;
  created_at: number;
  expires_at: number;
}

const toInvitation = (r: InvitationRow): AdminInvitation => ({
  id: r.id,
  email: r.email,
  role: r.role,
  workspaceId: r.workspace_id,
  workspaceName: r.workspace_name,
  newWorkspaceName: r.workspace_id ? null : r.new_workspace_name,
  isAdmin: !!r.instance_admin,
  createdBy: r.created_by_name,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

/** Every pending invitation of the instance (workspace invitations included). */
adminRoutes.get("/invitations", async (c) => {
  const { results } = await c.var.db
    .prepare(
      `SELECT i.id, i.email, i.role, i.workspace_id, w.name AS workspace_name, i.new_workspace_name, i.instance_admin,
         u.name AS created_by_name, i.created_at, i.expires_at FROM invitations i
       LEFT JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.created_by
       WHERE i.accepted_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`,
    )
    .bind(now())
    .all<InvitationRow>();
  return c.json({ items: results.map(toInvitation) });
});

/**
 * POST /admin/invitations { email?, workspaceId?, role?, newWorkspaceName?, isAdmin? }: with `workspaceId` the invitee
 * joins that workspace with `role` (default viewer); without it they get a new workspace of their own (owner).
 */
adminRoutes.post("/invitations", async (c) => {
  const db = c.var.db;
  const body = await readBody<{ email?: unknown; workspaceId?: unknown; role?: unknown; newWorkspaceName?: unknown; isAdmin?: unknown }>(c);
  const email = body.email ? normalizeEmail(body.email) : null;
  if (body.email && !email) return c.json({ error: "Invalid email" }, 400);
  if (body.isAdmin !== undefined && typeof body.isAdmin !== "boolean") return c.json({ error: "isAdmin must be true or false" }, 400);
  let workspaceId: string | null = null;
  let role: Role = "owner";
  let newWorkspaceName: string | null = null;
  if (body.workspaceId) {
    const ws = await db.prepare("SELECT id FROM workspaces WHERE id = ?").bind(String(body.workspaceId)).first<{ id: string }>();
    if (!ws) return c.json({ error: "Workspace not found" }, 404);
    if (body.role !== undefined && !isRole(body.role)) return c.json({ error: `Role must be one of ${ROLES.join(", ")}` }, 400);
    workspaceId = ws.id;
    role = isRole(body.role) ? body.role : "viewer";
    if (email) {
      const member = await db
        .prepare("SELECT 1 AS x FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?")
        .bind(ws.id, email)
        .first();
      if (member) return c.json({ error: `${email} is already a member of this workspace` }, 409);
    }
  } else {
    newWorkspaceName = body.newWorkspaceName === undefined || body.newWorkspaceName === "" ? null : normalizeName(body.newWorkspaceName);
    if (body.newWorkspaceName && !newWorkspaceName) return c.json({ error: "Invalid newWorkspaceName" }, 400);
  }
  const token = randomToken(24);
  const id = newId("inv_");
  const t = now();
  await db
    .prepare(
      `INSERT INTO invitations (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at, new_workspace_name, instance_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, workspaceId, email, role, await sha256Hex(token), c.var.user.id, t, t + INVITE_TTL_MS, newWorkspaceName, body.isAdmin ? 1 : 0)
    .run();
  return c.json({ id, url: `${await baseUrl(c.env, db, c.req.url)}/invite/${token}`, expiresAt: t + INVITE_TTL_MS }, 201);
});

adminRoutes.delete("/invitations/:id", async (c) => {
  const res = await c.var.db.prepare("DELETE FROM invitations WHERE id = ? AND accepted_at IS NULL").bind(c.req.param("id")).run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "Invitation not found" }, 404);
});

// Updates ---------------------------------------------------------------------------------------------------------------

adminRoutes.get("/updates", async (c) => c.json(updateStatus(c.env, await readStoredUpdate(c.var.db))));

/** Checks GitHub now; a check from the last minute is returned as is. */
adminRoutes.post("/updates/check", async (c) => {
  if (!updateCheckEnabled(c.env)) return c.json({ error: 'Update checks are turned off (UPDATE_CHECK="false")' }, 409);
  const stored = await readStoredUpdate(c.var.db);
  if (stored && now() - stored.checkedAt < MANUAL_CHECK_INTERVAL) return c.json(updateStatus(c.env, stored));
  return c.json(updateStatus(c.env, await checkForUpdatesNow(c.env, c.var.db)));
});

// Settings: sign-in links by email ---------------------------------------------------------------------------------------

async function emailSettings(env: Env, db: Db): Promise<AdminEmailSettings> {
  const configured = emailConfigured(env);
  return { configured, from: configured ? env.EMAIL_FROM!.trim() : null, enabled: configured && (await getSetting(db, MAGIC_LINK_SETTING)) === "1" };
}

const NOT_CONFIGURED =
  "Email is not set up: add the send_email binding EMAIL and the EMAIL_FROM variable (a sender on a domain onboarded to Cloudflare Email Sending), then deploy. Sending to any address needs Workers Paid.";

adminRoutes.get("/email", async (c) => c.json(await emailSettings(c.env, c.var.db)));

/** PATCH /admin/email { enabled }: turns sign-in links by email on or off (off ends every outstanding link). */
adminRoutes.patch("/email", async (c) => {
  const db = c.var.db;
  const body = await readBody<{ enabled?: unknown }>(c);
  if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
  if (body.enabled) {
    if (!emailConfigured(c.env)) return c.json({ error: NOT_CONFIGURED }, 400);
    await setSetting(db, MAGIC_LINK_SETTING, "1");
  } else {
    await db.batch([db.prepare("DELETE FROM settings WHERE key = ?").bind(MAGIC_LINK_SETTING), db.prepare("DELETE FROM magic_links")]);
  }
  return c.json(await emailSettings(c.env, db));
});

/** Sends a test email to the signed-in admin, synchronously: Cloudflare's error comes back as a 502. */
adminRoutes.post("/email/test", async (c) => {
  if (!emailConfigured(c.env)) return c.json({ error: NOT_CONFIGURED }, 400);
  const host = new URL(c.req.url).host;
  try {
    await c.env.EMAIL!.send({ from: sender(c.env.EMAIL_FROM!), to: c.var.user.email, ...testEmail(host) });
  } catch (err) {
    return c.json({ error: `Cloudflare could not send the email: ${sendError(err)}` }, 502);
  }
  return c.json({ ok: true, to: c.var.user.email });
});
