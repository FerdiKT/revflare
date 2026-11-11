// The signed-in user: profile, workspaces, members, invitations, API keys, iOS devices and pairing codes.
import { Hono } from "hono";
import type { ApiKey, Device, Me, Member, PairingCode, Role, WorkspaceSummary } from "../../shared/types";
import { API_VERSION, VERSION } from "../../shared/version";
import { ROLES, createApiKey, requireAdmin, requirePermission, wsId, type AppEnv } from "../lib/auth";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { deleteWorkspace } from "../lib/admin";
import { bumpDataVersion } from "../lib/metrics";
import { APP_PUSH_KINDS, DEFAULT_PREFS, apnsConfigured, parsePrefs, pushToDevice, type AppPushOverride } from "../lib/push";
import { emailConfigured } from "../lib/email";
import { baseUrl } from "../lib/settings";
import { newId, now, randomToken, sha256Hex } from "../lib/util";
import { normalizeEmail, normalizeName, passwordError } from "./auth";

export const accountRoutes = new Hono<AppEnv>();

async function workspacesOf(c: { var: AppEnv["Variables"] }): Promise<WorkspaceSummary[]> {
  const db = c.var.db;
  const user = c.var.user;
  if (c.var.auth === "api_key") {
    const ws = c.var.workspace;
    return ws ? [{ id: ws.id, name: ws.name, role: ws.role, currency: ws.currency }] : [];
  }
  const { results } = user.isAdmin
    ? await db
        .prepare(
          "SELECT w.id, w.name, w.currency, COALESCE(m.role, 'owner') AS role FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ? ORDER BY w.created_at",
        )
        .bind(user.id)
        .all<WorkspaceSummary>()
    : await db
        .prepare("SELECT w.id, w.name, w.currency, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at")
        .bind(user.id)
        .all<WorkspaceSummary>();
  return results;
}

accountRoutes.get("/me", async (c) => {
  const ws = c.var.workspace;
  const prefs = await c.var.db.prepare("SELECT daily_digest_email FROM users WHERE id = ?").bind(c.var.user.id).first<{ daily_digest_email: number }>();
  const body: Me = {
    user: { ...c.var.user, dailyDigestEmail: !!prefs?.daily_digest_email },
    workspace: ws ? { id: ws.id, name: ws.name, role: ws.role, currency: ws.currency, permissions: ws.permissions } : null,
    workspaces: await workspacesOf(c),
    auth: c.var.auth,
    version: VERSION,
    apiVersion: API_VERSION,
    features: { push: apnsConfigured(c.env), email: emailConfigured(c.env) },
  };
  return c.json(body);
});

/** { name?, dailyDigestEmail? } (at least one). */
accountRoutes.patch("/me", async (c) => {
  const body = await c.req.json<{ name?: unknown; dailyDigestEmail?: unknown }>().catch(() => ({}) as { name?: unknown; dailyDigestEmail?: unknown });
  if (body.name === undefined && body.dailyDigestEmail === undefined) return c.json({ error: "Name is required" }, 400);
  const name = body.name === undefined ? undefined : normalizeName(body.name);
  if (name === null) return c.json({ error: "Name is required" }, 400);
  if (body.dailyDigestEmail !== undefined && typeof body.dailyDigestEmail !== "boolean") return c.json({ error: "dailyDigestEmail must be true or false" }, 400);
  if (c.var.auth === "api_key" && body.dailyDigestEmail !== undefined) return c.json({ error: "Not with an API key" }, 403);
  const digest = body.dailyDigestEmail === undefined ? null : body.dailyDigestEmail ? 1 : 0;
  await c.var.db
    .prepare("UPDATE users SET name = COALESCE(?, name), daily_digest_email = COALESCE(?, daily_digest_email), updated_at = ? WHERE id = ?")
    .bind(name ?? null, digest, now(), c.var.user.id)
    .run();
  return c.json({ ok: true });
});

accountRoutes.post("/me/password", async (c) => {
  if (c.var.auth === "api_key") return c.json({ error: "Not with an API key" }, 403);
  const body = await c.req.json<{ current?: unknown; password?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const row = await c.var.db.prepare("SELECT password_hash FROM users WHERE id = ?").bind(c.var.user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(String(body.current ?? ""), row.password_hash))) return c.json({ error: "The current password is wrong" }, 400);
  const err = passwordError(body.password);
  if (err) return c.json({ error: err }, 400);
  await c.var.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(String(body.password)), now(), c.var.user.id).run();
  return c.json({ ok: true });
});

// Workspaces --------------------------------------------------------------------------------------------------------

accountRoutes.get("/workspaces", async (c) => c.json({ items: await workspacesOf(c) }));

accountRoutes.post("/workspaces", requireAdmin, async (c) => {
  const body = await c.req.json<{ name?: unknown; currency?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const name = normalizeName(body.name);
  if (!name) return c.json({ error: "Name is required" }, 400);
  const currency = typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : "USD";
  const id = newId("ws_");
  const t = now();
  await c.var.db.batch([
    c.var.db.prepare("INSERT INTO workspaces (id, name, currency, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, name, currency, c.var.user.id, t, t),
    c.var.db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, c.var.user.id, t),
  ]);
  return c.json({ id, name, currency, role: "owner" });
});

accountRoutes.patch("/workspace", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ name?: unknown; currency?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const name = body.name === undefined ? undefined : normalizeName(body.name);
  if (name === null) return c.json({ error: "Name is required" }, 400);
  const currency = body.currency === undefined ? undefined : typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : null;
  if (currency === null) return c.json({ error: "Currency must be a 3-letter code (USD, EUR, TRY...)" }, 400);
  await c.var.db
    .prepare("UPDATE workspaces SET name = COALESCE(?, name), currency = COALESCE(?, currency), updated_at = ? WHERE id = ?")
    .bind(name ?? null, currency ?? null, now(), wsId(c))
    .run();
  await bumpDataVersion(c.var.db, wsId(c));
  return c.json({ ok: true });
});

accountRoutes.delete("/workspace", requirePermission("delete"), async (c) => {
  await deleteWorkspace(c.var.db, wsId(c));
  return c.json({ ok: true });
});

// Members and invitations -------------------------------------------------------------------------------------------

accountRoutes.get("/members", requirePermission("read"), async (c) => {
  const { results } = await c.var.db
    .prepare("SELECT u.id AS userId, u.name, u.email, m.role, m.created_at AS createdAt FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at")
    .bind(wsId(c))
    .all<Member>();
  return c.json({ items: results });
});

const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as string[]).includes(r);

accountRoutes.post("/invitations", requirePermission("members"), async (c) => {
  const body = await c.req.json<{ email?: unknown; role?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const role = isRole(body.role) ? body.role : "viewer";
  if (role === "owner" && c.var.workspace!.role !== "owner") return c.json({ error: "Only owners can invite owners" }, 403);
  const email = body.email ? normalizeEmail(body.email) : null;
  if (body.email && !email) return c.json({ error: "Invalid email" }, 400);
  const token = randomToken(24);
  const t = now();
  await c.var.db
    .prepare("INSERT INTO invitations (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(newId("inv_"), wsId(c), email, role, await sha256Hex(token), c.var.user.id, t, t + 7 * 86_400_000)
    .run();
  return c.json({ url: `${await baseUrl(c.env, c.var.db, c.req.url)}/invite/${token}`, expiresAt: t + 7 * 86_400_000 });
});

accountRoutes.get("/invitations", requirePermission("members"), async (c) => {
  const { results } = await c.var.db
    .prepare(
      `SELECT i.id, i.email, i.role, i.created_at AS createdAt, i.expires_at AS expiresAt, u.name AS createdBy FROM invitations i
       LEFT JOIN users u ON u.id = i.created_by WHERE i.workspace_id = ? AND i.accepted_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`,
    )
    .bind(wsId(c), now())
    .all<{ id: string; email: string | null; role: Role; createdAt: number; expiresAt: number; createdBy: string | null }>();
  return c.json({ items: results });
});

accountRoutes.delete("/invitations/:id", requirePermission("members"), async (c) => {
  await c.var.db.prepare("DELETE FROM invitations WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL").bind(c.req.param("id"), wsId(c)).run();
  return c.json({ ok: true });
});

accountRoutes.patch("/members/:userId", requirePermission("members"), async (c) => {
  const body = await c.req.json<{ role?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (!isRole(body.role)) return c.json({ error: `Role must be one of ${ROLES.join(", ")}` }, 400);
  if (body.role === "owner" && c.var.workspace!.role !== "owner") return c.json({ error: "Only owners can make owners" }, 403);
  const res = await c.var.db.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?").bind(body.role, wsId(c), c.req.param("userId")).run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

accountRoutes.delete("/members/:userId", requirePermission("members"), async (c) => {
  const db = c.var.db;
  const owners = await db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND user_id != ?").bind(wsId(c), c.req.param("userId")).first<{ n: number }>();
  if (!owners?.n) return c.json({ error: "A workspace needs at least one owner" }, 400);
  await db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(wsId(c), c.req.param("userId")).run();
  return c.json({ ok: true });
});

// API keys ------------------------------------------------------------------------------------------------------------

accountRoutes.get("/api-keys", requirePermission("read"), async (c) => {
  const { results } = await c.var.db
    .prepare("SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC")
    .bind(wsId(c), c.var.user.id)
    .all<ApiKey>();
  return c.json({ items: results });
});

accountRoutes.post("/api-keys", requirePermission("read"), async (c) => {
  if (c.var.auth === "api_key") return c.json({ error: "API keys cannot create API keys" }, 403);
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const name = normalizeName(body.name) ?? "API key";
  const key = await createApiKey(c.var.db, name, c.var.user.id, wsId(c));
  return c.json({ id: key.id, name, token: key.token });
});

accountRoutes.delete("/api-keys/:id", requirePermission("read"), async (c) => {
  await c.var.db.prepare("DELETE FROM api_keys WHERE id = ? AND workspace_id = ? AND user_id = ?").bind(c.req.param("id"), wsId(c), c.var.user.id).run();
  return c.json({ ok: true });
});

// iOS: pairing codes and devices ------------------------------------------------------------------------------------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

accountRoutes.post("/pairing-codes", requirePermission("read"), async (c) => {
  if (c.var.auth !== "session") return c.json({ error: "Pairing codes are created in the web app" }, 403);
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const t = now();
  const expiresAt = t + 10 * 60_000;
  await c.var.db
    .prepare("INSERT INTO pairing_codes (code_hash, user_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(code), c.var.user.id, wsId(c), t, expiresAt)
    .run();
  const server = await baseUrl(c.env, c.var.db, c.req.url);
  const body: PairingCode = { code, url: `revflare://pair?server=${encodeURIComponent(server)}&code=${code}`, expiresAt };
  return c.json(body);
});

interface DeviceRow {
  id: string;
  name: string | null;
  environment: "production" | "sandbox";
  prefs: string;
  activity_token: string | null;
  created_at: number;
  last_push_at: number | null;
}

const toDevice = (d: DeviceRow): Device => ({
  id: d.id,
  name: d.name,
  environment: d.environment,
  prefs: parsePrefs(d.prefs),
  liveActivity: !!d.activity_token,
  createdAt: d.created_at,
  lastPushAt: d.last_push_at,
});

accountRoutes.get("/devices", async (c) => {
  const { results } = await c.var.db
    .prepare("SELECT id, name, environment, prefs, activity_token, created_at, last_push_at FROM devices WHERE user_id = ? ORDER BY created_at DESC")
    .bind(c.var.user.id)
    .all<DeviceRow>();
  return c.json({ items: results.map(toDevice) });
});

/** `{ [appId]: { muted?, sales?, renewals?, ... } }`; booleans only, empty entries dropped, at most 200 apps. */
function cleanOverrides(v: unknown): Record<string, AppPushOverride> {
  const out: Record<string, AppPushOverride> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [appId, o] of Object.entries(v as Record<string, unknown>).slice(0, 200)) {
    if (!o || typeof o !== "object" || appId.length > 64) continue;
    const entry: AppPushOverride = {};
    for (const key of ["muted", ...APP_PUSH_KINDS] as const) {
      const b = (o as Record<string, unknown>)[key];
      if (typeof b === "boolean") entry[key] = b;
    }
    if (Object.keys(entry).length) out[appId] = entry;
  }
  return out;
}

function cleanPrefs(input: unknown): Partial<typeof DEFAULT_PREFS> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  const src = input as Record<string, unknown>;
  for (const [k, def] of Object.entries(DEFAULT_PREFS)) {
    const v = src[k];
    if (v === undefined) continue;
    if (k === "apps") out[k] = Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 200) : null;
    else if (k === "appOverrides") out[k] = cleanOverrides(v);
    else if (k === "quietStart" || k === "quietEnd") out[k] = typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : null;
    else if (k === "sound") out[k] = ["cash", "default", "none"].includes(String(v)) ? v : def;
    else if (typeof def === "boolean") out[k] = !!v;
    else if (typeof def === "number") out[k] = Number(v) >= 0 ? Number(v) : def;
    else if (typeof v === "string") out[k] = v.slice(0, 64);
  }
  return out as Partial<typeof DEFAULT_PREFS>;
}

/** Registers (or updates) the APNs token of the calling device. */
accountRoutes.post("/devices", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const token = typeof body.apnsToken === "string" && /^[0-9a-f]{32,200}$/i.test(body.apnsToken) ? body.apnsToken.toLowerCase() : null;
  if (!token) return c.json({ error: "apnsToken (hex) is required" }, 400);
  const environment = body.environment === "sandbox" ? "sandbox" : "production";
  const db = c.var.db;
  const existing = await db.prepare("SELECT id, prefs FROM devices WHERE apns_token = ?").bind(token).first<{ id: string; prefs: string }>();
  const prefs = { ...parsePrefs(existing?.prefs), ...cleanPrefs(body.prefs) };
  const t = now();
  const id = existing?.id ?? newId("dev_");
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, session_id, name, apns_token, environment, prefs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(apns_token) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, name = excluded.name,
       environment = excluded.environment, prefs = excluded.prefs, updated_at = excluded.updated_at`,
    )
    .bind(id, c.var.user.id, c.var.sessionId ?? null, normalizeName(body.name), token, environment, JSON.stringify(prefs), t, t)
    .run();
  const row = await db.prepare("SELECT id, name, environment, prefs, activity_token, created_at, last_push_at FROM devices WHERE id = ?").bind(id).first<DeviceRow>();
  return c.json(toDevice(row!));
});

accountRoutes.patch("/devices/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const db = c.var.db;
  const row = await db.prepare("SELECT prefs FROM devices WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.user.id).first<{ prefs: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  const prefs = { ...parsePrefs(row.prefs), ...cleanPrefs(body.prefs) };
  const hexOrNull = (v: unknown) => (v === undefined ? undefined : typeof v === "string" && /^[0-9a-f]{32,400}$/i.test(v) ? v.toLowerCase() : null);
  // Live Activity push token and WidgetKit push token (null when they end / are revoked).
  const activity = hexOrNull(body.activityToken);
  const widget = hexOrNull(body.widgetToken);
  await db
    .prepare(`UPDATE devices SET prefs = ?, ${activity === undefined ? "" : "activity_token = ?, "}${widget === undefined ? "" : "widget_token = ?, "}updated_at = ? WHERE id = ?`)
    .bind(...[JSON.stringify(prefs), ...(activity === undefined ? [] : [activity]), ...(widget === undefined ? [] : [widget]), now(), c.req.param("id")])
    .run();
  const d = await db.prepare("SELECT id, name, environment, prefs, activity_token, created_at, last_push_at FROM devices WHERE id = ?").bind(c.req.param("id")).first<DeviceRow>();
  return c.json(toDevice(d!));
});

accountRoutes.delete("/devices/:id", async (c) => {
  await c.var.db.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.user.id).run();
  return c.json({ ok: true });
});

/** Sends a test push to one of the user's devices. */
accountRoutes.post("/devices/:id/test", async (c) => {
  const d = await c.var.db
    .prepare("SELECT id, apns_token, environment, activity_token, prefs FROM devices WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.var.user.id)
    .first<{ id: string; apns_token: string; environment: string; activity_token: string | null; prefs: string }>();
  if (!d) return c.json({ error: "Not found" }, 404);
  if (!apnsConfigured(c.env)) return c.json({ error: "Push is not configured on this server (APNS_* settings)" }, 400);
  const ok = await pushToDevice(c.env, c.var.db, d, { kind: "sale", titleKey: "PUSH_TITLE_DEMO", titleArgs: ["Revflare"], bodyKey: "PUSH_BODY_DEMO", bodyArgs: [] });
  return ok ? c.json({ ok: true }) : c.json({ error: "Apple did not accept the push" }, 502);
});


