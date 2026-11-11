import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Permission, Role } from "../../shared/types";
import { getDb, type Db } from "./db";
import { newId, now, randomToken, sha256Hex } from "./util";

export const SESSION_COOKIE = "rf_session";
const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Device sessions (iOS app) slide: each use within the last half extends them. */
const DEVICE_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** What each workspace role may do. */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ["read", "manage", "members", "delete"],
  admin: ["read", "manage", "members"],
  viewer: ["read"],
};

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

export interface CurrentWorkspace {
  id: string;
  name: string;
  currency: string;
  role: Role;
  permissions: Permission[];
}

export type AuthKind = "session" | "device" | "api_key";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    auth: AuthKind;
    user: CurrentUser;
    workspace: CurrentWorkspace | null;
    workspaceError?: string;
    /** sessions.id (hash) for session and device requests. */
    sessionId?: string;
    apiKeyId?: string;
    csp?: string;
  };
};

export type Ctx = Context<AppEnv>;

interface UserRow {
  id: string;
  name: string;
  email: string;
  is_admin: number;
}

const toUser = (r: UserRow): CurrentUser => ({ id: r.id, name: r.name, email: r.email, isAdmin: !!r.is_admin });

/** Creates a web session and sets the cookie. */
export async function createWebSession(c: Ctx, userId: string, workspaceId: string | null = null) {
  const token = randomToken(32);
  const t = now();
  await c.var.db
    .prepare("INSERT INTO sessions (id, user_id, kind, workspace_id, created_at, expires_at, last_used_at) VALUES (?, ?, 'web', ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, workspaceId, t, t + WEB_SESSION_TTL_MS, t)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(WEB_SESSION_TTL_MS / 1000),
  });
}

/** Creates a device session (iOS app) and returns its bearer token (`rfd_...`). */
export async function createDeviceSession(db: Db, userId: string, workspaceId: string | null, name: string | null) {
  const token = `rfd_${randomToken(32)}`;
  const t = now();
  const id = await sha256Hex(token);
  await db
    .prepare("INSERT INTO sessions (id, user_id, kind, workspace_id, name, created_at, expires_at, last_used_at) VALUES (?, ?, 'device', ?, ?, ?, ?, ?)")
    .bind(id, userId, workspaceId, name, t, t + DEVICE_SESSION_TTL_MS, t)
    .run();
  return { token, sessionId: id };
}

export async function destroySession(c: Ctx) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.var.db.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function createApiKey(db: Db, name: string, userId: string, workspaceId: string) {
  const token = `rf_${randomToken(24)}`;
  const id = newId("key_");
  await db
    .prepare("INSERT INTO api_keys (id, workspace_id, user_id, name, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, workspaceId, userId, name, token.slice(0, 7), await sha256Hex(token), now())
    .run();
  return { id, token };
}

interface Principal {
  kind: AuthKind;
  user: CurrentUser;
  sessionId?: string;
  apiKeyId?: string;
  /** API keys: their workspace. Sessions: the last workspace used. */
  workspaceId: string | null;
}

/** Who is calling: API key / device token (Authorization: Bearer) or the session cookie. One query. */
export async function principal(c: Ctx): Promise<Principal | null> {
  const db = c.var.db;
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer?.startsWith("rf_")) {
    const row = await db
      .prepare(
        `SELECT u.id, u.name, u.email, u.is_admin, k.id AS key_id, k.workspace_id, k.last_used_at FROM api_keys k
         JOIN users u ON u.id = k.user_id WHERE k.hash = ? AND u.status = 'active'`,
      )
      .bind(await sha256Hex(bearer))
      .first<UserRow & { key_id: string; workspace_id: string; last_used_at: number | null }>();
    if (!row) return null;
    if (!row.last_used_at || row.last_used_at < now() - 60_000) {
      await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now(), row.key_id).run();
    }
    return { kind: "api_key", user: toUser(row), apiKeyId: row.key_id, workspaceId: row.workspace_id };
  }
  const token = bearer?.startsWith("rfd_") ? bearer : bearer ? null : getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const kind = bearer ? "device" : "web";
  const id = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT u.id, u.name, u.email, u.is_admin, s.workspace_id, s.expires_at, s.last_used_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.kind = ? AND s.expires_at > ? AND u.status = 'active'`,
    )
    .bind(id, kind, now())
    .first<UserRow & { workspace_id: string | null; expires_at: number; last_used_at: number | null }>();
  if (!row) return null;
  const t = now();
  if (!row.last_used_at || row.last_used_at < t - 10 * 60_000) {
    // Device sessions slide forward; web sessions only record use.
    const expires = kind === "device" ? t + DEVICE_SESSION_TTL_MS : row.expires_at;
    await db.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?").bind(t, expires, id).run();
  }
  return { kind: kind === "web" ? "session" : "device", user: toUser(row), sessionId: id, workspaceId: row.workspace_id };
}

interface WorkspaceRow {
  id: string;
  name: string;
  currency: string;
  role: Role | null;
}

function toWorkspace(row: WorkspaceRow | null, isAdmin: boolean): CurrentWorkspace | null {
  if (!row) return null;
  const role: Role | null = row.role ?? (isAdmin ? "owner" : null);
  if (!role || !ROLE_PERMISSIONS[role]) return null;
  return { id: row.id, name: row.name, currency: row.currency, role, permissions: ROLE_PERMISSIONS[role] };
}

/** The user's access to one workspace (membership; instance admins act as owner everywhere), or null. */
export async function workspaceAccess(db: Db, user: CurrentUser, workspaceId: string): Promise<CurrentWorkspace | null> {
  const row = await db
    .prepare(
      `SELECT w.id, w.name, w.currency, m.role FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ? WHERE w.id = ?`,
    )
    .bind(user.id, workspaceId)
    .first<WorkspaceRow>();
  return toWorkspace(row, user.isAdmin);
}

/** The user's first workspace (oldest membership; for admins without one, the oldest workspace). */
export async function firstWorkspace(db: Db, user: CurrentUser): Promise<CurrentWorkspace | null> {
  const row = await db
    .prepare(
      `SELECT w.id, w.name, w.currency, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? ORDER BY m.created_at, w.created_at LIMIT 1`,
    )
    .bind(user.id)
    .first<WorkspaceRow>();
  if (row) return toWorkspace(row, user.isAdmin);
  if (!user.isAdmin) return null;
  return toWorkspace(
    await db.prepare("SELECT id, name, currency, NULL AS role FROM workspaces ORDER BY created_at LIMIT 1").first<WorkspaceRow>(),
    true,
  );
}

/**
 * True for a state-changing request sent by a browser from another origin. Browsers always send `Origin` on
 * cross-origin POST/PUT/PATCH/DELETE; API clients (CLI, iOS app, curl) send none.
 */
export function isCrossSiteMutation(c: Ctx): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return false;
  const origin = c.req.header("origin");
  if (origin) return origin !== new URL(c.req.url).origin;
  return c.req.header("sec-fetch-site") === "cross-site";
}

export const sameOriginMutations: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isCrossSiteMutation(c)) return c.json({ error: "Cross-origin request blocked" }, 403);
  return next();
};

/** Sets c.var.db for every request. */
export const withDb: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("db", getDb(c.env));
  return next();
};

/**
 * Authenticates (API key, device token or session cookie) and picks the workspace: API keys are bound to theirs;
 * sessions use `X-Workspace-Id`, else the last workspace used, else the user's first one.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const p = await principal(c);
  if (!p) return c.json({ error: "Unauthorized" }, 401);
  c.set("auth", p.kind);
  c.set("user", p.user);
  if (p.sessionId) c.set("sessionId", p.sessionId);
  if (p.apiKeyId) c.set("apiKeyId", p.apiKeyId);
  const db = c.var.db;
  let ws: CurrentWorkspace | null = null;
  if (p.kind === "api_key") {
    ws = p.workspaceId ? await workspaceAccess(db, p.user, p.workspaceId) : null;
    if (!ws) return c.json({ error: "This API key no longer has access to its workspace" }, 401);
  } else {
    const requested = c.req.header("x-workspace-id");
    if (requested) {
      ws = await workspaceAccess(db, p.user, requested);
      if (!ws) c.set("workspaceError", "Workspace not found");
      else if (requested !== p.workspaceId && p.sessionId) {
        await db.prepare("UPDATE sessions SET workspace_id = ? WHERE id = ?").bind(requested, p.sessionId).run();
      }
    } else {
      if (p.workspaceId) ws = await workspaceAccess(db, p.user, p.workspaceId);
      ws ??= await firstWorkspace(db, p.user);
    }
  }
  c.set("workspace", ws);
  return next();
};

/** 403 unless the current workspace grants `permission` (404 when the requested workspace is not accessible). */
export function requirePermission(permission: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ws = c.var.workspace;
    if (!ws) {
      return c.var.workspaceError ? c.json({ error: c.var.workspaceError }, 404) : c.json({ error: "You are not a member of any workspace" }, 403);
    }
    if (!ws.permissions.includes(permission)) return c.json({ error: `Your role (${ws.role}) cannot do this` }, 403);
    return next();
  };
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user?.isAdmin || c.var.auth === "api_key") return c.json({ error: "Only instance admins can do this" }, 403);
  return next();
};

/** Id of the current workspace. Only call behind `requirePermission`. */
export function wsId(c: Ctx): string {
  const ws = c.var.workspace;
  if (!ws) throw new Error("No workspace");
  return ws.id;
}

/** Client address for throttles (an IPv6 /64 counts as one address). */
export function throttleIp(ip: string | undefined | null): string {
  if (!ip) return "local";
  if (!ip.includes(":")) return ip;
  return ip.toLowerCase().split(":").slice(0, 4).join(":") + "::/64";
}

/**
 * Counts one hit for each key in fixed windows (settings rows `{ n, until }`, removed by the nightly cleanup) and
 * returns the counts, in the order of `keys`. One batch.
 */
export async function countHits(db: Db, keys: string[], windowMs: number): Promise<number[]> {
  const t = now();
  const bump = (key: string) =>
    db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, json_object('n', 1, 'until', ?)) ON CONFLICT(key) DO UPDATE SET value =
           CASE WHEN json_extract(value, '$.until') > ? THEN json_set(value, '$.n', json_extract(value, '$.n') + 1) ELSE excluded.value END
         RETURNING json_extract(value, '$.n') AS n`,
      )
      .bind(key, t + windowMs, t);
  const results = await db.batch<{ n: number }>(keys.map(bump));
  return results.map((r) => r.results[0]?.n ?? 0);
}
