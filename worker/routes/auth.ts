import { Hono } from "hono";
import type { AuthStatus, DeviceTokenResponse } from "../../shared/types";
import { countHits, createDeviceSession, createWebSession, destroySession, principal, throttleIp, type AppEnv, type Ctx } from "../lib/auth";
import { hashPassword, timingSafeEqual, verifyPassword } from "../lib/crypto";
import type { Db } from "../lib/db";
import { magicLinkEmail, magicLinkEnabled, sender } from "../lib/email";
import { apnsConfigured } from "../lib/push";
import { baseUrl, getSetting, setSetting } from "../lib/settings";
import { newId, now, parseJson, randomToken, sha256Hex } from "../lib/util";

export const authRoutes = new Hono<AppEnv>();

async function hasUsers(db: Db) {
  return !!(await db.prepare("SELECT 1 AS x FROM users LIMIT 1").first());
}

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200 ? e : null;
}

export function normalizeName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.trim().replace(/\s+/g, " ");
  return n && n.length <= 100 ? n : null;
}

export function passwordError(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 8) return "The password must have at least 8 characters";
  if (v.length > 200) return "The password is too long";
  return null;
}

/** Whether a signed-in iOS device exists (sign in with the app), and one with push when APNs is configured. One query. */
async function appLoginFlags(env: Env, db: Db) {
  const t = now();
  const push = apnsConfigured(env);
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM sessions WHERE kind = 'device' AND expires_at > ?) AS app,
         ${push ? "EXISTS (SELECT 1 FROM devices d JOIN sessions s ON s.id = d.session_id WHERE s.kind = 'device' AND s.expires_at > ?)" : "0"} AS push`,
    )
    .bind(...(push ? [t, t] : [t]))
    .first<{ app: number; push: number }>();
  return { app: !!row?.app, push: !!row?.app && !!row?.push };
}

authRoutes.get("/status", async (c) => {
  const db = c.var.db;
  const [setup, p, magicLink, app] = await Promise.all([hasUsers(db), principal(c), magicLinkEnabled(c.env, db), appLoginFlags(c.env, db)]);
  const body: AuthStatus = {
    setup,
    authenticated: !!p && setup,
    ...(!setup && c.env.SETUP_TOKEN ? { setupToken: true } : {}),
    ...(setup && magicLink ? { magicLink: true } : {}),
    ...(setup && app.app ? { appLogin: true, ...(app.push ? { pushLogin: true } : {}), ...(c.env.APP_STORE_URL ? { appStoreUrl: c.env.APP_STORE_URL } : {}) } : {}),
  };
  return c.json(body);
});

/** First run: creates the first user (instance admin) and their workspace, then signs in. */
authRoutes.post("/setup", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  if (!name) return c.json({ error: "Name is required" }, 400);
  if (!email) return c.json({ error: "A valid email is required" }, 400);
  const pwError = passwordError(body.password);
  if (pwError) return c.json({ error: pwError }, 400);
  const db = c.var.db;
  if (await hasUsers(db)) return c.json({ error: "Already set up" }, 409);
  if (c.env.SETUP_TOKEN && !timingSafeEqual(await sha256Hex(String(body.setupToken ?? "")), await sha256Hex(c.env.SETUP_TOKEN))) {
    return c.json({ error: "Wrong setup token (the SETUP_TOKEN secret of this deployment)" }, 403);
  }
  const userId = newId("usr_");
  const workspaceId = newId("ws_");
  const t = now();
  const currency = typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : "USD";
  const userExists = "WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)";
  const [res] = await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, is_admin, status, created_at, updated_at, last_login_at)
         SELECT ?, ?, ?, ?, 1, 'active', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .bind(userId, email, name, await hashPassword(String(body.password)), t, t, t),
    db
      .prepare(`INSERT INTO workspaces (id, name, currency, created_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ? ${userExists}`)
      .bind(workspaceId, normalizeName(body.workspaceName) ?? "My apps", currency, userId, t, t, userId),
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT ?, ?, 'owner', ? ${userExists}`).bind(workspaceId, userId, t, userId),
  ]);
  if (!res.meta.changes) return c.json({ error: "Already set up" }, 409);
  await baseUrl(c.env, db, c.req.url);
  await createWebSession(c, userId, workspaceId);
  return c.json({ ok: true });
});

const MAX_FAILURES_IP = 8;
const MAX_FAILURES_EMAIL = 10;
const LOCK_MS = 15 * 60 * 1000;
type Failures = { n: number; until: number };

// Verified for unknown emails so they cost the same PBKDF2 as wrong passwords (no user enumeration by timing).
const DUMMY_HASH = "pbkdf2$20000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Checks email + password with a persistent per-IP and per-email throttle. */
async function checkLogin(c: Ctx, body: { email?: unknown; password?: unknown }) {
  const db = c.var.db;
  const ipKey = `login_fail:${throttleIp(c.req.header("cf-connecting-ip"))}`;
  const email = normalizeEmail(body.email) ?? "";
  const emailKey = `login_fail:email:${email}`;
  const get = async (k: string) => parseJson<Failures>(await getSetting(db, k), { n: 0, until: 0 });
  const [ipF, emailF] = await Promise.all([get(ipKey), email ? get(emailKey) : { n: 0, until: 0 }]);
  const locked = (f: Failures, max: number) => f.n >= max && f.until > Date.now();
  if (locked(ipF, MAX_FAILURES_IP) || locked(emailF, MAX_FAILURES_EMAIL)) return { error: "Too many attempts, try again in a few minutes", status: 429 as const };
  const user = email
    ? await db.prepare("SELECT id, password_hash, status FROM users WHERE email = ?").bind(email).first<{ id: string; password_hash: string; status: string }>()
    : null;
  const ok = await verifyPassword(typeof body.password === "string" ? body.password : "", user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    const bump = (k: string, f: Failures) => setSetting(db, k, JSON.stringify({ n: (f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + LOCK_MS }));
    await Promise.all([bump(ipKey, ipF), email ? bump(emailKey, emailF) : null]);
    return { error: "Wrong email or password", status: 401 as const };
  }
  if (user.status !== "active") return { error: "This account is disabled", status: 403 as const };
  await db.batch([db.prepare("DELETE FROM settings WHERE key IN (?, ?)").bind(ipKey, emailKey), db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), user.id)]);
  return { userId: user.id };
}

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<{ email?: unknown; password?: unknown }>().catch(() => ({}));
  const r = await checkLogin(c, body);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  await createWebSession(c, r.userId);
  return c.json({ ok: true });
});

// ---------- Sign-in links by email (Cloudflare Email Sending, turned on in Admin → Settings; existing active accounts) ----------

const LINK_TTL_MS = 15 * 60_000;
const MAIL_LIMITS = { ip: 10, email: 3 };
const MAIL_WINDOW_MS = 15 * 60_000;
const notEnabled = (c: Ctx) => c.json({ error: "Sign-in links by email are not turned on on this instance" }, 404);

/** Counts a link request per IP and per email (fixed 15-minute windows, settings "mail_link:*"); true when over a limit. */
async function mailThrottled(db: Db, ip: string, email: string) {
  const [a, b] = await countHits(db, [`mail_link:ip:${ip}`, `mail_link:email:${email}`], MAIL_WINDOW_MS);
  return a > MAIL_LIMITS.ip || b > MAIL_LIMITS.email;
}

/**
 * Emails a one-time sign-in link. The answer is the same whether or not the account exists (no account discovery);
 * the user lookup, the link and the send happen after the response.
 */
authRoutes.post("/magic-link", async (c) => {
  const db = c.var.db;
  if (!(await magicLinkEnabled(c.env, db))) return notEnabled(c);
  const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: "Enter a valid email" }, 400);
  if (await mailThrottled(db, throttleIp(c.req.header("cf-connecting-ip")), email)) return c.json({ error: "Too many sign-in links requested. Try again in 15 minutes." }, 429);
  const origin = new URL(c.req.url).origin;
  const env = c.env;
  c.executionCtx.waitUntil(
    (async () => {
      const user = await db.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").bind(email).first<{ id: string }>();
      if (!user) return;
      const token = randomToken(32);
      const t = now();
      await db
        .prepare("INSERT INTO magic_links (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256Hex(token), user.id, t, t + LINK_TTL_MS)
        .run();
      const link = `${origin}/auth/link#${token}`;
      await env.EMAIL!.send({ from: sender(env.EMAIL_FROM!), to: email, ...magicLinkEmail(link, new URL(origin).host, LINK_TTL_MS / 60_000) });
    })().catch((err) => console.error("magic link", err?.code ?? "", err?.message ?? err)),
  );
  return c.json({ ok: true });
});

/** Signs in with a link token: works once, within 15 minutes, for an active account; other open links of the user end. */
authRoutes.post("/magic-link/verify", async (c) => {
  const db = c.var.db;
  if (!(await magicLinkEnabled(c.env, db))) return notEnabled(c);
  const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
  const token = typeof body.token === "string" ? body.token : "";
  const invalid = () => c.json({ error: "This sign-in link is invalid, used or expired. Request a new one." }, 400);
  if (!/^[\w-]{20,100}$/.test(token)) return invalid();
  const t = now();
  const row = await db
    .prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id")
    .bind(t, await sha256Hex(token), t)
    .first<{ user_id: string }>();
  if (!row) return invalid();
  const user = await db.prepare("SELECT status FROM users WHERE id = ?").bind(row.user_id).first<{ status: string }>();
  if (user?.status !== "active") return c.json({ error: "This account is disabled" }, 403);
  await db.batch([
    db.prepare("UPDATE magic_links SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(t, row.user_id),
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(t, row.user_id),
  ]);
  await createWebSession(c, row.user_id);
  return c.json({ ok: true });
});

async function deviceResponse(c: Ctx, userId: string, workspaceId: string | null, name: string | null): Promise<DeviceTokenResponse> {
  const db = c.var.db;
  const user = await db.prepare("SELECT id, name, email, is_admin FROM users WHERE id = ?").bind(userId).first<{ id: string; name: string; email: string; is_admin: number }>();
  const ws = workspaceId
    ? await db
        .prepare("SELECT w.id, w.name, w.currency, COALESCE(m.role, 'owner') AS role FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ? WHERE w.id = ?")
        .bind(userId, workspaceId)
        .first<{ id: string; name: string; currency: string; role: "owner" | "admin" | "viewer" }>()
    : await db
        .prepare("SELECT w.id, w.name, w.currency, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at LIMIT 1")
        .bind(userId)
        .first<{ id: string; name: string; currency: string; role: "owner" | "admin" | "viewer" }>();
  const { token } = await createDeviceSession(db, userId, ws?.id ?? null, name);
  return {
    token,
    user: { id: user!.id, name: user!.name, email: user!.email, isAdmin: !!user!.is_admin },
    workspace: ws ? { id: ws.id, name: ws.name, currency: ws.currency, role: ws.role } : null,
    server: await baseUrl(c.env, db, c.req.url),
  };
}

/** iOS app sign-in with email and password: returns a device token (Authorization: Bearer rfd_...). */
authRoutes.post("/device", async (c) => {
  const body = await c.req.json<{ email?: unknown; password?: unknown; deviceName?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const r = await checkLogin(c, body);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json(await deviceResponse(c, r.userId, null, normalizeName(body.deviceName)));
});

/** iOS app sign-in with a pairing code (QR code shown in the web app). */
authRoutes.post("/pair", async (c) => {
  const body = await c.req.json<{ code?: unknown; deviceName?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) return c.json({ error: "Missing code" }, 400);
  const db = c.var.db;
  const hash = await sha256Hex(code);
  const row = await db
    .prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id, workspace_id")
    .bind(now(), hash, now())
    .first<{ user_id: string; workspace_id: string }>();
  if (!row) return c.json({ error: "This code is invalid or expired. Show a new one in Revflare on the web." }, 400);
  return c.json(await deviceResponse(c, row.user_id, row.workspace_id, normalizeName(body.deviceName)));
});

authRoutes.post("/logout", async (c) => {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(rfd_\S+)$/i)?.[1];
  if (bearer) {
    const id = await sha256Hex(bearer);
    await c.var.db.batch([c.var.db.prepare("DELETE FROM devices WHERE session_id = ?").bind(id), c.var.db.prepare("DELETE FROM sessions WHERE id = ?").bind(id)]);
    return c.json({ ok: true });
  }
  await destroySession(c);
  return c.json({ ok: true });
});

interface InvitationRow {
  id: string;
  workspace_id: string | null;
  email: string | null;
  role: string;
  new_workspace_name: string | null;
  instance_admin: number;
}

async function findInvitation(db: Db, token: unknown): Promise<InvitationRow | null> {
  if (typeof token !== "string" || token.length < 20) return null;
  return db
    .prepare("SELECT id, workspace_id, email, role, new_workspace_name, instance_admin FROM invitations WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?")
    .bind(await sha256Hex(token), now())
    .first<InvitationRow>();
}

/** What an invitation link is for (the invite page shows it before signing up). The token is the credential. */
authRoutes.get("/invitations/:token", async (c) => {
  const db = c.var.db;
  const inv = await findInvitation(db, c.req.param("token"));
  if (!inv) return c.json({ error: "This invitation is invalid or expired" }, 404);
  const ws = inv.workspace_id ? await db.prepare("SELECT name FROM workspaces WHERE id = ?").bind(inv.workspace_id).first<{ name: string }>() : null;
  return c.json({
    email: inv.email,
    role: inv.role,
    workspaceName: ws?.name ?? null,
    newWorkspace: !inv.workspace_id,
    newWorkspaceName: inv.workspace_id ? null : inv.new_workspace_name,
    isAdmin: !!inv.instance_admin,
  });
});

/**
 * Accept an invitation: existing users sign in with their password, new users create an account. Instance invitations
 * without a workspace create one with the invitee as owner (and may make them an instance admin).
 */
authRoutes.post("/invitations/accept", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const db = c.var.db;
  const inv = await findInvitation(db, body.token);
  if (!inv) return c.json({ error: "This invitation is invalid or expired" }, 400);
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: "A valid email is required" }, 400);
  if (inv.email && inv.email !== email) return c.json({ error: `This invitation is for ${inv.email}` }, 400);
  let user = await db.prepare("SELECT id, name, password_hash, status FROM users WHERE email = ?").bind(email).first<{ id: string; name: string; password_hash: string; status: string }>();
  if (user) {
    if (!(await verifyPassword(String(body.password ?? ""), user.password_hash))) return c.json({ error: "Wrong password for this account" }, 401);
    if (user.status !== "active") return c.json({ error: "This account is disabled" }, 403);
  } else {
    const name = normalizeName(body.name);
    if (!name) return c.json({ error: "Name is required" }, 400);
    const pwError = passwordError(body.password);
    if (pwError) return c.json({ error: pwError }, 400);
    const id = newId("usr_");
    const t = now();
    await db
      .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, status, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, 0, 'active', ?, ?, ?)")
      .bind(id, email, name, await hashPassword(String(body.password)), t, t, t)
      .run();
    user = { id, name, password_hash: "", status: "active" };
  }
  const t = now();
  const workspaceId = inv.workspace_id ?? newId("ws_");
  // Claim the invitation first (one use), then apply it in the same transaction.
  const claimed = "WHERE EXISTS (SELECT 1 FROM invitations WHERE id = ? AND accepted_at = ?)";
  const [claim] = await db.batch([
    db.prepare("UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL").bind(t, inv.id),
    ...(inv.workspace_id
      ? [
          db
            .prepare(
              `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT ?, ?, ?, ? ${claimed}
               ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
            )
            .bind(workspaceId, user.id, inv.role, t, inv.id, t),
        ]
      : [
          db
            .prepare(`INSERT INTO workspaces (id, name, currency, created_by, created_at, updated_at) SELECT ?, ?, 'USD', ?, ?, ? ${claimed}`)
            .bind(workspaceId, inv.new_workspace_name ?? `${user.name}'s apps`, user.id, t, t, inv.id, t),
          db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT ?, ?, 'owner', ? ${claimed}`).bind(workspaceId, user.id, t, inv.id, t),
        ]),
    ...(inv.instance_admin ? [db.prepare(`UPDATE users SET is_admin = 1, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM invitations WHERE id = ? AND accepted_at = ?)`).bind(t, user.id, inv.id, t)] : []),
  ]);
  if (!claim.meta.changes) return c.json({ error: "This invitation is invalid or expired" }, 400);
  await createWebSession(c, user.id, workspaceId);
  return c.json({ ok: true, workspaceId });
});
