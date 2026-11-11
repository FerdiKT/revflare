import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import worker from "../../worker/index";
import { getDb } from "../../worker/lib/db";
import { magicLinkEmail, sender } from "../../worker/lib/email";
import { sha256Hex } from "../../worker/lib/util";
import { ORIGIN, call, ownerClient, sessionCookie, type Client } from "./helpers";

// Sign-in links by email (Cloudflare Email Sending): off by default, turned on by an instance admin (Admin → Settings),
// request, the email, one-time use, expiry, throttling, no account discovery. The test Worker has no EMAIL binding:
// these tests call the Worker with a fake one that records what would be sent.

interface Sent {
  from: unknown;
  to: string;
  subject: string;
  text: string;
  html: string;
}

function fakeEmail(fail?: Error) {
  const sent: Sent[] = [];
  return {
    sent,
    binding: {
      async send(msg: unknown) {
        if (fail) throw fail;
        sent.push(msg as Sent);
        return { messageId: `m_${sent.length}` };
      },
    } as unknown as SendEmail,
  };
}

const FROM = "Revflare <revflare@rf.test>";
type Opts = { method?: string; body?: unknown; headers?: Record<string, string> };

/** Calls the Worker with extra bindings (EMAIL, EMAIL_FROM) and waits for its waitUntil work. */
async function callWith(extra: Partial<Env>, client: Client | null, path: string, opts: Opts = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.token) headers.authorization = `Bearer ${client.token}`;
  if (client?.ws) headers["x-workspace-id"] = client.ws;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body }), { ...env, ...extra } as Env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

function mailer(fail?: Error) {
  const mail = fakeEmail(fail);
  const bindings = { EMAIL: mail.binding, EMAIL_FROM: FROM };
  return { mail, call: (client: Client | null, path: string, opts?: Opts) => callWith(bindings, client, path, opts) };
}

let ipSeq = 1;
const freshIp = () => `198.51.100.${ipSeq++}`;
const request = (m: ReturnType<typeof mailer>, email: unknown, ip = freshIp()) => m.call(null, "/api/v1/auth/magic-link", { body: { email }, headers: { "cf-connecting-ip": ip } });
const verify = (m: ReturnType<typeof mailer>, token: unknown) => m.call(null, "/api/v1/auth/magic-link/verify", { body: { token } });
/** The token of an email (from the link fragment). */
const tokenOf = (sent: Sent) => sent.text.match(/\/auth\/link#([\w-]+)/)![1];
const first = (sql: string, ...binds: unknown[]) => getDb(env).prepare(sql).bind(...binds).first<any>();

let n = 0;
/** A new viewer of the owner's workspace (through an invitation link). */
async function newUser() {
  const owner = await ownerClient();
  const email = `link${++n}-${Date.now()}@rf.test`;
  const inv = await call(owner, "/api/v1/invitations", { body: { role: "viewer" } });
  const token = inv.json.url.split("/invite/")[1];
  const acc = await call(null, "/api/v1/auth/invitations/accept", { body: { token, name: `Link ${n}`, email, password: "password123" } });
  expect(acc.status).toBe(200);
  const me = await call({ cookie: sessionCookie(acc.headers) }, "/api/v1/me");
  return { cookie: sessionCookie(acc.headers), email, id: me.json.user.id as string };
}

/** Turns the instance setting on (or off) as the owner (an instance admin). */
async function setEnabled(enabled: boolean) {
  const r = await mailer().call(await ownerClient(), "/api/v1/admin/email", { method: "PATCH", body: { enabled } });
  expect(r.status, r.text).toBe(200);
}

afterAll(() => setEnabled(false));

describe("off by default", () => {
  it("is not offered without the binding, nor with it until an admin turns it on", async () => {
    const owner = await ownerClient();
    const plain = await call(null, "/api/v1/auth/status");
    expect(plain.json).toMatchObject({ setup: true, authenticated: false });
    expect(plain.json.magicLink).toBeUndefined();
    expect((await call(null, "/api/v1/auth/magic-link", { body: { email: owner.email } })).status).toBe(404);
    expect((await call(null, "/api/v1/auth/magic-link/verify", { body: { token: "x".repeat(43) } })).status).toBe(404);
    const m = mailer();
    expect((await m.call(null, "/api/v1/auth/status")).json).toMatchObject({ setup: true, authenticated: false });
    expect((await m.call(null, "/api/v1/auth/status")).json.magicLink).toBeUndefined();
    expect((await request(m, owner.email)).status).toBe(404);
    expect((await verify(m, "x".repeat(43))).status).toBe(404);
    expect(m.mail.sent).toHaveLength(0);
    const noSender = await callWith({ EMAIL: fakeEmail().binding, EMAIL_FROM: " " }, owner, "/api/v1/admin/email");
    expect(noSender.json).toEqual({ configured: false, from: null, enabled: false });
  });

  it("cannot be turned on while email is not set up", async () => {
    const owner = await ownerClient();
    expect((await call(owner, "/api/v1/admin/email")).json).toEqual({ configured: false, from: null, enabled: false });
    const on = await call(owner, "/api/v1/admin/email", { method: "PATCH", body: { enabled: true } });
    expect(on.status).toBe(400);
    expect(on.json.error).toMatch(/EMAIL.*EMAIL_FROM.*Workers Paid/);
    expect((await call(owner, "/api/v1/admin/email/test", { method: "POST" })).status).toBe(400);
    expect((await call(owner, "/api/v1/admin/email")).json.enabled).toBe(false);
    expect((await call(owner, "/api/v1/admin/email", { method: "PATCH", body: { enabled: "yes" } })).status).toBe(400);
  });

  it("is for instance admins with a session only", async () => {
    const owner = await ownerClient();
    const viewer = await newUser();
    const m = mailer();
    expect((await m.call(viewer, "/api/v1/admin/email")).status).toBe(403);
    expect((await m.call(viewer, "/api/v1/admin/email", { method: "PATCH", body: { enabled: true } })).status).toBe(403);
    expect((await m.call(viewer, "/api/v1/admin/email/test", { method: "POST" })).status).toBe(403);
    const key = await call(owner, "/api/v1/api-keys", { body: { name: "email-cli" } });
    expect((await m.call({ token: key.json.token }, "/api/v1/admin/email", { method: "PATCH", body: { enabled: true } })).status).toBe(403);
    expect((await m.call(null, "/api/v1/admin/email")).status).toBe(401);
    expect(m.mail.sent).toHaveLength(0);
    expect((await m.call(owner, "/api/v1/admin/email")).json.enabled).toBe(false);
  });
});

describe("admin settings", () => {
  it("turns on when configured and shows the sender", async () => {
    const owner = await ownerClient();
    const m = mailer();
    expect((await m.call(owner, "/api/v1/admin/email")).json).toEqual({ configured: true, from: FROM, enabled: false });
    const on = await m.call(owner, "/api/v1/admin/email", { method: "PATCH", body: { enabled: true } });
    expect(on.status).toBe(200);
    expect(on.json).toEqual({ configured: true, from: FROM, enabled: true });
    expect((await m.call(null, "/api/v1/auth/status")).json).toMatchObject({ setup: true, authenticated: false, magicLink: true });
    // Without the binding the setting does nothing.
    expect((await call(null, "/api/v1/auth/status")).json.magicLink).toBeUndefined();
    expect((await call(owner, "/api/v1/admin/email")).json.enabled).toBe(false);
  });

  it("sends a test email to the admin, and reports Cloudflare's error", async () => {
    const owner = await ownerClient();
    const m = mailer();
    const ok = await m.call(owner, "/api/v1/admin/email/test", { method: "POST" });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toEqual({ ok: true, to: owner.email });
    expect(m.mail.sent).toHaveLength(1);
    expect(m.mail.sent[0]).toMatchObject({ to: owner.email, from: { name: "Revflare", email: "revflare@rf.test" }, subject: "Revflare test email" });
    const failing = mailer(Object.assign(new Error("sender domain not verified"), { code: "E_SENDER_NOT_VERIFIED" }));
    const bad = await failing.call(owner, "/api/v1/admin/email/test", { method: "POST" });
    expect(bad.status).toBe(502);
    expect(bad.json.error).toContain("sender domain not verified (E_SENDER_NOT_VERIFIED)");
  });
});

describe("requesting a link", () => {
  it("emails a one-time link to an existing account", async () => {
    await setEnabled(true);
    const m = mailer();
    const u = await newUser();
    const res = await request(m, `  ${u.email.toUpperCase()} `);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(sessionCookie(res.headers)).toBeUndefined();
    expect(m.mail.sent).toHaveLength(1);
    const sent = m.mail.sent[0];
    expect(sent.to).toBe(u.email);
    expect(sent.from).toEqual({ name: "Revflare", email: "revflare@rf.test" });
    expect(sent.subject).toBe("Your Revflare sign-in link");
    expect(sent.text).toContain(`${ORIGIN}/auth/link#`);
    expect(sent.html).toContain(`${ORIGIN}/auth/link#${tokenOf(sent)}`);
    const row = await first("SELECT user_id, expires_at - created_at AS ttl, used_at FROM magic_links WHERE token_hash = ?", await sha256Hex(tokenOf(sent)));
    expect(row).toEqual({ user_id: u.id, ttl: 15 * 60_000, used_at: null });
  });

  it("answers the same for unknown and disabled accounts, without sending anything", async () => {
    await setEnabled(true);
    const m = mailer();
    const disabled = await newUser();
    await getDb(env).prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(disabled.id).run();
    for (const email of [`nobody-${Date.now()}@rf.test`, disabled.email]) {
      const res = await request(m, email);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true });
    }
    expect(m.mail.sent).toHaveLength(0);
    expect(await first("SELECT COUNT(*) AS n FROM magic_links WHERE user_id = ?", disabled.id)).toEqual({ n: 0 });
  });

  it.each([
    ["no email", undefined],
    ["an invalid email", "not-an-email"],
    ["a number", 42],
  ])("rejects %s", async (_l, email) => {
    await setEnabled(true);
    const m = mailer();
    const res = await request(m, email);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Enter a valid email");
  });

  it("still answers ok when sending fails (logged, not shown)", async () => {
    await setEnabled(true);
    const m = mailer(Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" }));
    const u = await newUser();
    expect((await request(m, u.email)).json).toEqual({ ok: true });
  });

  it("allows 3 links per email in 15 minutes", async () => {
    await setEnabled(true);
    const m = mailer();
    const u = await newUser();
    for (let i = 0; i < 3; i++) expect((await request(m, u.email)).status).toBe(200);
    const blocked = await request(m, u.email);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toMatch(/Too many sign-in links/);
    expect(m.mail.sent).toHaveLength(3);
  });

  it("allows 10 links per IP in 15 minutes, also for unknown emails", async () => {
    await setEnabled(true);
    const m = mailer();
    const ip = "203.0.113.77";
    for (let i = 0; i < 10; i++) expect((await request(m, `n${i}-${Date.now()}@rf.test`, ip)).status).toBe(200);
    expect((await request(m, `n-${Date.now()}@rf.test`, ip)).status).toBe(429);
    expect((await request(m, `n-${Date.now()}@rf.test`)).status).toBe(200);
  });

  it("refuses cross-site requests", async () => {
    await setEnabled(true);
    const m = mailer();
    const u = await newUser();
    const res = await m.call(null, "/api/v1/auth/magic-link", { body: { email: u.email }, headers: { origin: "https://evil.example", "cf-connecting-ip": freshIp() } });
    expect(res.status).toBe(403);
    expect((await m.call(null, "/api/v1/auth/magic-link/verify", { body: { token: "x".repeat(43) }, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(m.mail.sent).toHaveLength(0);
  });
});

describe("using a link", () => {
  it("signs in once, then the link (and the user's other open links) stop working", async () => {
    await setEnabled(true);
    const m = mailer();
    const u = await newUser();
    await request(m, u.email);
    await request(m, u.email);
    const [one, two] = m.mail.sent.map(tokenOf);
    const res = await verify(m, one);
    expect(res.status, res.text).toBe(200);
    const cookie = sessionCookie(res.headers)!;
    expect(cookie).toBeTruthy();
    expect((await call({ cookie }, "/api/v1/me")).json.user).toMatchObject({ id: u.id, email: u.email });
    expect((await first("SELECT last_login_at FROM users WHERE id = ?", u.id)).last_login_at).toBeGreaterThan(Date.now() - 60_000);
    for (const t of [one, two]) {
      const again = await verify(m, t);
      expect(again.status).toBe(400);
      expect(again.json.error).toBe("This sign-in link is invalid, used or expired. Request a new one.");
      expect(sessionCookie(again.headers)).toBeUndefined();
    }
  });

  it("refuses expired links", async () => {
    await setEnabled(true);
    const m = mailer();
    const u = await newUser();
    await request(m, u.email);
    const token = tokenOf(m.mail.sent[0]);
    await getDb(env).prepare("UPDATE magic_links SET expires_at = ? WHERE token_hash = ?").bind(Date.now() - 1, await sha256Hex(token)).run();
    expect((await verify(m, token)).status).toBe(400);
  });

  it("refuses links of accounts disabled after the email was sent", async () => {
    await setEnabled(true);
    const m = mailer();
    const u = await newUser();
    await request(m, u.email);
    await getDb(env).prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(u.id).run();
    const res = await verify(m, tokenOf(m.mail.sent[0]));
    expect(res.status).toBe(403);
    expect(sessionCookie(res.headers)).toBeUndefined();
  });

  it.each([
    ["no token", undefined],
    ["a short token", "abc"],
    ["a made-up token", "x".repeat(43)],
    ["an object", { $ne: null }],
    ["sql", "' OR 1=1 --aaaaaaaaaaaaaaaaaaaaaa"],
  ])("refuses %s", async (_l, token) => {
    await setEnabled(true);
    const res = await verify(mailer(), token);
    expect(res.status).toBe(400);
    expect(sessionCookie(res.headers)).toBeUndefined();
  });

  it("stops working when an admin turns the feature off (and stays dead when it comes back)", async () => {
    await setEnabled(true);
    const m = mailer();
    const u = await newUser();
    await request(m, u.email);
    const token = tokenOf(m.mail.sent[0]);
    await setEnabled(false);
    expect((await m.call(null, "/api/v1/auth/status")).json.magicLink).toBeUndefined();
    expect((await verify(m, token)).status).toBe(404);
    expect((await request(m, u.email)).status).toBe(404);
    await setEnabled(true);
    expect((await verify(m, token)).status).toBe(400);
  });

  it("is removed when the user is disabled or deleted by an admin", async () => {
    await setEnabled(true);
    const owner = await ownerClient();
    const m = mailer();
    const a = await newUser();
    const b = await newUser();
    await request(m, a.email);
    await request(m, b.email);
    expect((await call(owner, `/api/v1/admin/users/${a.id}`, { method: "PATCH", body: { status: "disabled" } })).status).toBe(200);
    expect((await call(owner, `/api/v1/admin/users/${b.id}`, { method: "DELETE" })).status).toBe(200);
    for (const id of [a.id, b.id]) expect(await first("SELECT COUNT(*) AS n FROM magic_links WHERE user_id = ?", id)).toEqual({ n: 0 });
    for (const sent of m.mail.sent) expect((await verify(m, tokenOf(sent))).status).toBe(400);
  });
});

describe("email helpers", () => {
  it.each([
    ["Revflare <a@b.co>", { name: "Revflare", email: "a@b.co" }],
    ['"Rev Team" <a@b.co>', { name: "Rev Team", email: "a@b.co" }],
    ["<a@b.co>", "a@b.co"],
    [" a@b.co ", "a@b.co"],
  ])("parses the sender %j", (from, expected) => {
    expect(sender(from)).toEqual(expected);
  });

  it("escapes the link and host in the HTML", () => {
    const m = magicLinkEmail('https://x.test/auth/link#a"><script>', "x.test<b>", 15);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&quot;&gt;&lt;script&gt;");
    expect(m.html).toContain("x.test&lt;b&gt;");
    expect(m.text).toContain("expires in 15 minutes");
  });
});
