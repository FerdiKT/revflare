// Sign in on the web with the iOS app (docs/app-login-spec.md). The browser starts a request and polls it with a
// secret only it knows; a signed-in device of the user approves it: by scanning the QR code (the nonce proves it saw
// this code) or from a push, picking the number the web page shows. The session cookie goes to the poll that finds
// the request approved, once.
import { Hono } from "hono";
import type { WebLoginInfo, WebLoginPoll, WebLoginStart } from "../../shared/types";
import { COUNTRY_NAMES } from "../../shared/countries";
import { countHits, createWebSession, principal, throttleIp, type AppEnv, type Ctx } from "../lib/auth";
import { timingSafeEqual } from "../lib/crypto";
import { apnsConfigured, pushWebLogin } from "../lib/push";
import { baseUrl } from "../lib/settings";
import { newId, now, randomToken, sha256Hex } from "../lib/util";
import { normalizeEmail } from "./auth";

export const appLoginRoutes = new Hono<AppEnv>();

const TTL_MS = 3 * 60_000;
const WINDOW_MS = 10 * 60_000;
const LIMITS = { ip: 10, email: 3 };

interface WebLoginRow {
  id: string;
  secret_hash: string;
  nonce_hash: string;
  user_id: string | null;
  kind: "qr" | "push";
  number: number | null;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  ip: string | null;
  city: string | null;
  country: string | null;
  user_agent: string | null;
  approved_device_id: string | null;
  created_at: number;
  expires_at: number;
}

/** "Chrome" / "macOS" from a User-Agent (enough to recognise one's own browser in the app). */
export function describeUserAgent(ua: string | null | undefined): { browser: string; os: string } {
  const s = ua ?? "";
  const browser = /Edg(e|A|iOS)?\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(s)
        ? "Firefox"
        : /SamsungBrowser\//.test(s)
          ? "Samsung Internet"
          : /Chrome\/|CriOS\/|Chromium\//.test(s)
            ? "Chrome"
            : /Safari\//.test(s) && /Version\//.test(s)
              ? "Safari"
              : "Browser";
  const os = /iPhone/.test(s)
    ? "iOS"
    : /iPad/.test(s)
      ? "iPadOS"
      : /Android/.test(s)
        ? "Android"
        : /CrOS/.test(s)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(s)
            ? "macOS"
            : /Windows/.test(s)
              ? "Windows"
              : /Linux/.test(s)
                ? "Linux"
                : "Unknown OS";
  return { browser, os };
}

/** "Berlin, Germany" (what the request's IP locates to), or "". */
function placeOf(row: Pick<WebLoginRow, "city" | "country">): string {
  const country = row.country ? (COUNTRY_NAMES[row.country] ?? row.country) : "";
  return [row.city, country].filter(Boolean).join(", ");
}

const randomNumber = () => 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);

/** The right number and two different ones, shuffled. */
export function numberChoices(right: number): number[] {
  const set = new Set([right]);
  while (set.size < 3) set.add(randomNumber());
  const out = [...set];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const validId = (id: string) => /^wl_[\w-]{16,40}$/.test(id);
const live = (row: WebLoginRow) => row.status === "pending" && row.expires_at > now();

/** Starts a request: QR (default) or push to the devices of the account with that email. */
appLoginRoutes.post("/", async (c) => {
  const db = c.var.db;
  const body = await c.req.json<{ kind?: unknown; email?: unknown }>().catch(() => ({}) as { kind?: unknown; email?: unknown });
  const kind = body.kind === "push" ? "push" : body.kind === undefined || body.kind === "qr" ? "qr" : null;
  if (!kind) return c.json({ error: "kind must be qr or push" }, 400);
  const email = kind === "push" ? normalizeEmail(body.email) : null;
  if (kind === "push") {
    if (!apnsConfigured(c.env)) return c.json({ error: "Push is not configured on this server" }, 404);
    if (!email) return c.json({ error: "Enter a valid email" }, 400);
  }
  const ip = c.req.header("cf-connecting-ip") ?? null;
  const counts = await countHits(db, [`app_login:ip:${throttleIp(ip)}`, ...(email ? [`app_login:email:${email}`] : [])], WINDOW_MS);
  if (counts[0] > LIMITS.ip || (email && counts[1] > LIMITS.email)) return c.json({ error: "Too many sign-in requests. Try again in 10 minutes." }, 429);

  const id = newId("wl_");
  const secret = randomToken(32);
  const nonce = randomToken(16);
  const t = now();
  const expiresAt = t + TTL_MS;
  const cf = c.req.raw.cf as { city?: string; country?: string } | undefined;
  const userAgent = c.req.header("user-agent")?.slice(0, 400) ?? null;
  // Push: only existing active accounts get pushes; the answer is the same either way (no account discovery).
  const user = email ? await db.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").bind(email).first<{ id: string }>() : null;
  const number = kind === "push" ? randomNumber() : null;
  await db
    .prepare(
      `INSERT INTO web_logins (id, secret_hash, nonce_hash, user_id, kind, number, status, ip, city, country, user_agent, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, await sha256Hex(secret), await sha256Hex(nonce), user?.id ?? null, kind, number, ip, cf?.city?.slice(0, 100) ?? null, cf?.country?.slice(0, 2) ?? null, userAgent, t, expiresAt)
    .run();
  if (kind === "push") {
    if (user) {
      const env = c.env;
      const ua = describeUserAgent(userAgent);
      c.executionCtx.waitUntil(
        pushWebLogin(env, db, user.id, { id, expiresAt, ...ua, place: placeOf({ city: cf?.city ?? null, country: cf?.country ?? null }) }).catch((err) => console.error("web login push", err?.message ?? err)),
      );
    }
    const res: WebLoginStart = { id, secret, number: number!, expiresAt };
    return c.json(res);
  }
  const server = await baseUrl(c.env, db, c.req.url);
  const res: WebLoginStart = { id, secret, qr: `revflare://web-login?s=${encodeURIComponent(server)}&r=${id}&k=${nonce}`, expiresAt };
  return c.json(res);
});

/** The browser's request, if the X-Login-Secret header matches. */
async function ownRequest(c: Ctx): Promise<WebLoginRow | null> {
  const id = c.req.param("id") ?? "";
  const secret = c.req.header("x-login-secret") ?? "";
  if (!validId(id) || !secret) return null;
  const row = await c.var.db.prepare("SELECT * FROM web_logins WHERE id = ?").bind(id).first<WebLoginRow>();
  if (!row || !timingSafeEqual(row.secret_hash, await sha256Hex(secret))) return null;
  return row;
}

const notFound = (c: Ctx) => c.json({ error: "This sign-in request does not exist" }, 404);

/** Polled by the browser every 2 s. When approved: consumed atomically and the session cookie is set. */
appLoginRoutes.get("/:id", async (c) => {
  const row = await ownRequest(c);
  if (!row) return notFound(c);
  const reply = (body: WebLoginPoll) => c.json(body);
  if (row.status === "pending") return reply({ status: row.expires_at > now() ? "pending" : "expired" });
  if (row.status !== "approved") return reply({ status: row.status });
  const db = c.var.db;
  const t = now();
  const won = await db
    .prepare("UPDATE web_logins SET status = 'consumed' WHERE id = ? AND status = 'approved' AND secret_hash = ? RETURNING user_id, approved_device_id")
    .bind(row.id, row.secret_hash)
    .first<{ user_id: string; approved_device_id: string | null }>();
  if (!won) return reply({ status: "consumed" });
  const user = await db.prepare("SELECT status FROM users WHERE id = ?").bind(won.user_id).first<{ status: string }>();
  if (user?.status !== "active") return c.json({ error: "This account is disabled" }, 403);
  // The browser opens the workspace the approving app is on.
  const device = won.approved_device_id ? await db.prepare("SELECT workspace_id FROM sessions WHERE id = ?").bind(won.approved_device_id).first<{ workspace_id: string | null }>() : null;
  await db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(t, won.user_id).run();
  await createWebSession(c, won.user_id, device?.workspace_id ?? null);
  return reply({ status: "signed_in", ...(device?.workspace_id ? { workspaceId: device.workspace_id } : {}) });
});

/** The browser gives up (closed the panel, asked for a new code). */
appLoginRoutes.delete("/:id", async (c) => {
  const row = await ownRequest(c);
  if (!row) return notFound(c);
  await c.var.db.prepare("UPDATE web_logins SET status = 'expired', expires_at = MIN(expires_at, ?) WHERE id = ? AND status IN ('pending', 'approved')").bind(now(), row.id).run();
  return c.json({ ok: true });
});

// ---------- The iOS app (device token of the user's own device) ----------

type AppCheck = { row: WebLoginRow; userId: string; sessionId: string } | { error: Response };

/**
 * The request as seen by a signed-in device: QR requests need the nonce from the code, push requests must target the
 * device's user. Unknown ids, wrong nonces and other users' requests all answer 404; finished or expired ones 410.
 */
async function appRequest(c: Ctx, nonce: unknown): Promise<AppCheck> {
  const p = await principal(c);
  if (!p || p.kind !== "device" || !p.sessionId) return { error: c.json({ error: "Sign in with the Revflare iOS app" }, 401) };
  const id = c.req.param("id") ?? "";
  const row = validId(id) ? await c.var.db.prepare("SELECT * FROM web_logins WHERE id = ?").bind(id).first<WebLoginRow>() : null;
  const missing = { error: c.json({ error: "This sign-in request does not exist. Show a new code on the web." }, 404) };
  if (!row) return missing;
  if (row.kind === "qr") {
    if (typeof nonce !== "string" || !nonce || !timingSafeEqual(row.nonce_hash, await sha256Hex(nonce))) return missing;
  } else if (row.user_id !== p.user.id) return missing;
  if (!live(row)) return { error: c.json({ error: "This sign-in request has expired or was already answered." }, 410) };
  return { row, userId: p.user.id, sessionId: p.sessionId };
}

type AppBody = { nonce?: unknown; number?: unknown };
const appBody = (c: Ctx) => c.req.json<AppBody>().catch(() => ({}) as AppBody);

appLoginRoutes.post("/:id/inspect", async (c) => {
  const body = await appBody(c);
  const r = await appRequest(c, body.nonce);
  if ("error" in r) return r.error;
  const { row } = r;
  const info: WebLoginInfo = {
    kind: row.kind,
    ip: row.ip,
    city: row.city,
    country: row.country ? (COUNTRY_NAMES[row.country] ?? row.country) : null,
    ...describeUserAgent(row.user_agent),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.kind === "push" && row.number !== null ? { numbers: numberChoices(row.number) } : {}),
  };
  return c.json(info);
});

appLoginRoutes.post("/:id/approve", async (c) => {
  const body = await appBody(c);
  const r = await appRequest(c, body.nonce);
  if ("error" in r) return r.error;
  const { row, userId, sessionId } = r;
  const db = c.var.db;
  const t = now();
  if (row.kind === "push" && Number(body.number) !== row.number) {
    // A wrong pick ends the request (number matching: guessing is not retried).
    await db.prepare("UPDATE web_logins SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(row.id).run();
    return c.json({ error: "That was not the number on the web page. The request was denied." }, 403);
  }
  const done = await db
    .prepare(
      `UPDATE web_logins SET status = 'approved', user_id = ?, approved_device_id = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ? AND (user_id IS NULL OR user_id = ?) RETURNING id`,
    )
    .bind(userId, sessionId, row.id, t, userId)
    .first();
  if (!done) return c.json({ error: "This sign-in request has expired or was already answered." }, 410);
  return c.json({ ok: true });
});

appLoginRoutes.post("/:id/deny", async (c) => {
  const body = await appBody(c);
  const r = await appRequest(c, body.nonce);
  if ("error" in r) return r.error;
  await c.var.db.prepare("UPDATE web_logins SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(r.row.id).run();
  return c.json({ ok: true });
});
