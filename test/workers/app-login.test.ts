import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { describeUserAgent, numberChoices } from "../../worker/routes/app-login";
import { getDb } from "../../worker/lib/db";
import { ORIGIN, call, ownerClient, sessionCookie, type Client } from "./helpers";

// Sign in on the web with the iOS app (docs/app-login-spec.md): QR codes (nonce bound to the scanning device, session
// bound to the browser's poll secret), push requests with number matching (APNs mocked: these tests call the Worker
// with APNS_* bindings and a stubbed fetch), expiry, single use, no account discovery, throttles, disabled users.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
type Opts = { method?: string; body?: unknown; headers?: Record<string, string>; cf?: Record<string, unknown> };

let apnsEnv: Partial<Env> = {};
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
  apnsEnv = { APNS_PRIVATE_KEY: pem, APNS_KEY_ID: "KEY123", APNS_TEAM_ID: "TEAM123", APNS_TOPIC: "com.example.revflare" };
});

afterEach(() => vi.restoreAllMocks());

/** Calls the Worker directly (extra bindings, request.cf) and waits for its waitUntil work. */
async function callWith(extra: Partial<Env>, client: Client | null, path: string, opts: Opts = {}) {
  const headers: Record<string, string> = { "user-agent": UA, ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.token) headers.authorization = `Bearer ${client.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, cf: opts.cf } as RequestInit);
  const res = await worker.fetch(req, { ...env, ...extra } as Env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

/** Records APNs requests (stubbed global fetch). */
function mockApns(status = 200) {
  const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("push.apple.com")) throw new Error(`unexpected fetch ${url}`);
    sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
    return new Response(status === 200 ? null : JSON.stringify({ reason: "BadDeviceToken" }), { status });
  });
  return sent;
}

let ipSeq = 1;
const freshIp = () => `192.0.2.${ipSeq++}`;
const first = (sql: string, ...binds: unknown[]) => getDb(env).prepare(sql).bind(...binds).first<any>();

let n = 0;
/** A new viewer of the owner's workspace with a signed-in iOS device (device token), optionally registered for push. */
async function newUser(opts: { push?: boolean } = {}) {
  const owner = await ownerClient();
  const email = `app${++n}-${Date.now()}@rf.test`;
  const inv = await call(owner, "/api/v1/invitations", { body: { role: "viewer" } });
  const acc = await call(null, "/api/v1/auth/invitations/accept", { body: { token: inv.json.url.split("/invite/")[1], name: `App ${n}`, email, password: "password123" } });
  expect(acc.status).toBe(200);
  const dev = await call(null, "/api/v1/auth/device", { body: { email, password: "password123", deviceName: "iPhone" } });
  expect(dev.status).toBe(200);
  const device: Client = { token: dev.json.token };
  const apnsToken = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (opts.push) expect((await call(device, "/api/v1/devices", { body: { apnsToken, environment: "sandbox" } })).status).toBe(200);
  return { email, id: dev.json.user.id as string, device, apnsToken, workspaceId: dev.json.workspace?.id as string };
}

const startQr = (ip = freshIp(), extra: Partial<Env> = {}) => callWith(extra, null, "/api/v1/auth/app-login", { body: { kind: "qr" }, headers: { "cf-connecting-ip": ip }, cf: { city: "Berlin", country: "DE" } });
const startPush = (email: unknown, ip = freshIp(), extra: Partial<Env> = apnsEnv) => callWith(extra, null, "/api/v1/auth/app-login", { body: { kind: "push", email }, headers: { "cf-connecting-ip": ip } });
const poll = (id: string, secret?: string) => callWith({}, null, `/api/v1/auth/app-login/${id}`, { headers: secret === undefined ? {} : { "x-login-secret": secret } });
const app = (device: Client, id: string, action: "inspect" | "approve" | "deny", body: unknown = {}) => callWith({}, device, `/api/v1/auth/app-login/${id}/${action}`, { body });

/** id and nonce from a QR string. */
function parseQr(qr: string) {
  const u = new URL(qr);
  expect(u.protocol).toBe("revflare:");
  expect(u.host).toBe("web-login");
  return { server: u.searchParams.get("s")!, id: u.searchParams.get("r")!, nonce: u.searchParams.get("k")! };
}

describe("auth status", () => {
  it("offers sign-in with the app once an iOS device is signed in, and the push variant with APNs and push devices", async () => {
    await newUser({ push: true });
    const plain = await callWith({}, null, "/api/v1/auth/status");
    expect(plain.json).toMatchObject({ setup: true, authenticated: false, appLogin: true });
    expect(plain.json.pushLogin).toBeUndefined();
    expect(plain.json.appStoreUrl).toBeUndefined();
    const withPush = await callWith({ ...apnsEnv, APP_STORE_URL: "https://apps.apple.com/app/id1" }, null, "/api/v1/auth/status");
    expect(withPush.json).toMatchObject({ appLogin: true, pushLogin: true, appStoreUrl: "https://apps.apple.com/app/id1" });
  });
});

describe("QR", () => {
  it("signs the browser in once the app approves, and only once", async () => {
    const u = await newUser();
    const start = await startQr();
    expect(start.status, start.text).toBe(200);
    expect(start.json).toMatchObject({ id: expect.stringMatching(/^wl_/), secret: expect.any(String), expiresAt: expect.any(Number) });
    expect(start.json.number).toBeUndefined();
    expect(start.json.expiresAt - Date.now()).toBeGreaterThan(170_000);
    expect(start.json.expiresAt - Date.now()).toBeLessThanOrEqual(180_000);
    const qr = parseQr(start.json.qr);
    expect(qr.id).toBe(start.json.id);
    expect(qr.server).toBe(ORIGIN);
    expect(start.json.qr).not.toContain(start.json.secret);
    const row = await first("SELECT secret_hash, nonce_hash, kind, status, user_id FROM web_logins WHERE id = ?", qr.id);
    expect(row).toMatchObject({ kind: "qr", status: "pending", user_id: null });
    expect(row.secret_hash).not.toContain(start.json.secret);
    expect(row.nonce_hash).not.toBe(qr.nonce);

    expect((await poll(qr.id, start.json.secret)).json).toEqual({ status: "pending" });
    const info = await app(u.device, qr.id, "inspect", { nonce: qr.nonce });
    expect(info.status, info.text).toBe(200);
    expect(info.json).toMatchObject({ kind: "qr", city: "Berlin", country: "Germany", browser: "Chrome", os: "macOS", expiresAt: start.json.expiresAt });
    expect(info.json.numbers).toBeUndefined();
    expect((await app(u.device, qr.id, "approve", { nonce: qr.nonce })).json).toEqual({ ok: true });
    expect(await first("SELECT status, user_id FROM web_logins WHERE id = ?", qr.id)).toEqual({ status: "approved", user_id: u.id });

    const done = await poll(qr.id, start.json.secret);
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ status: "signed_in", workspaceId: u.workspaceId });
    const cookie = sessionCookie(done.headers)!;
    expect(cookie).toBeTruthy();
    const me = await call({ cookie }, "/api/v1/me");
    expect(me.json.user.id).toBe(u.id);
    expect(me.json.auth).toBe("session");

    const again = await poll(qr.id, start.json.secret);
    expect(again.json).toEqual({ status: "consumed" });
    expect(sessionCookie(again.headers)).toBeUndefined();
    expect((await app(u.device, qr.id, "approve", { nonce: qr.nonce })).status).toBe(410);
  });

  it("binds the approval to the nonce and the session to the browser's secret", async () => {
    const u = await newUser();
    const start = await startQr();
    const qr = parseQr(start.json.qr);
    for (const nonce of [undefined, "", "x".repeat(22), 42]) {
      expect((await app(u.device, qr.id, "inspect", { nonce })).status).toBe(404);
      expect((await app(u.device, qr.id, "approve", { nonce })).status).toBe(404);
      expect((await app(u.device, qr.id, "deny", { nonce })).status).toBe(404);
    }
    expect((await first("SELECT status FROM web_logins WHERE id = ?", qr.id)).status).toBe("pending");
    await app(u.device, qr.id, "approve", { nonce: qr.nonce });
    // Whoever has only the QR (id + nonce) cannot collect the session.
    for (const secret of [undefined, "", qr.nonce, "x".repeat(43)]) {
      const r = await poll(qr.id, secret);
      expect(r.status).toBe(404);
      expect(sessionCookie(r.headers)).toBeUndefined();
      expect((await callWith({}, null, `/api/v1/auth/app-login/${qr.id}`, { method: "DELETE", headers: secret ? { "x-login-secret": secret } : {} })).status).toBe(404);
    }
    expect((await first("SELECT status FROM web_logins WHERE id = ?", qr.id)).status).toBe("approved");
    expect((await poll("wl_doesnotexist000000", start.json.secret)).status).toBe(404);
    expect((await poll("not-an-id", start.json.secret)).status).toBe(404);
    expect((await poll(qr.id, start.json.secret)).json.status).toBe("signed_in");
  });

  it("is answered by a device token only (not a web session, an API key or nobody)", async () => {
    const owner = await ownerClient();
    const key = await call(owner, "/api/v1/api-keys", { body: { name: "app-login" } });
    const start = await startQr();
    const qr = parseQr(start.json.qr);
    for (const client of [null, { cookie: owner.cookie }, { token: key.json.token }, { token: "rfd_madeup" }]) {
      expect((await app(client as Client, qr.id, "inspect", { nonce: qr.nonce })).status).toBe(401);
      expect((await app(client as Client, qr.id, "approve", { nonce: qr.nonce })).status).toBe(401);
    }
    expect((await first("SELECT status FROM web_logins WHERE id = ?", qr.id)).status).toBe("pending");
  });

  it("can be denied in the app or cancelled by the browser", async () => {
    const u = await newUser();
    const a = await startQr();
    const qa = parseQr(a.json.qr);
    expect((await app(u.device, qa.id, "deny", { nonce: qa.nonce })).json).toEqual({ ok: true });
    expect((await poll(qa.id, a.json.secret)).json).toEqual({ status: "denied" });
    expect((await app(u.device, qa.id, "approve", { nonce: qa.nonce })).status).toBe(410);

    const b = await startQr();
    const qb = parseQr(b.json.qr);
    expect((await callWith({}, null, `/api/v1/auth/app-login/${qb.id}`, { method: "DELETE", headers: { "x-login-secret": b.json.secret } })).json).toEqual({ ok: true });
    expect((await app(u.device, qb.id, "inspect", { nonce: qb.nonce })).status).toBe(410);
    expect((await app(u.device, qb.id, "approve", { nonce: qb.nonce })).status).toBe(410);
    expect((await poll(qb.id, b.json.secret)).json.status).toBe("expired");
  });

  it("expires after 3 minutes", async () => {
    const u = await newUser();
    const start = await startQr();
    const qr = parseQr(start.json.qr);
    await getDb(env).prepare("UPDATE web_logins SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, qr.id).run();
    expect((await app(u.device, qr.id, "inspect", { nonce: qr.nonce })).status).toBe(410);
    expect((await app(u.device, qr.id, "approve", { nonce: qr.nonce })).status).toBe(410);
    expect((await poll(qr.id, start.json.secret)).json).toEqual({ status: "expired" });
  });

  it("refuses devices of disabled users, and approvals of users disabled before the browser collects them", async () => {
    const owner = await ownerClient();
    const a = await newUser();
    const s1 = await startQr();
    const q1 = parseQr(s1.json.qr);
    await getDb(env).prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(a.id).run();
    expect((await app(a.device, q1.id, "approve", { nonce: q1.nonce })).status).toBe(401);

    const b = await newUser();
    const s2 = await startQr();
    const q2 = parseQr(s2.json.qr);
    await app(b.device, q2.id, "approve", { nonce: q2.nonce });
    await getDb(env).prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(b.id).run();
    const r = await poll(q2.id, s2.json.secret);
    expect(r.status).toBe(403);
    expect(sessionCookie(r.headers)).toBeUndefined();

    // An admin disabling a user removes their requests.
    const c = await newUser();
    const s3 = await startQr();
    const q3 = parseQr(s3.json.qr);
    await app(c.device, q3.id, "approve", { nonce: q3.nonce });
    expect((await call(owner, `/api/v1/admin/users/${c.id}`, { method: "PATCH", body: { status: "disabled" } })).status).toBe(200);
    expect(await first("SELECT COUNT(*) AS n FROM web_logins WHERE user_id = ?", c.id)).toEqual({ n: 0 });
    expect((await poll(q3.id, s3.json.secret)).status).toBe(404);
  });

  it("allows 10 requests per IP in 10 minutes", async () => {
    const ip = "203.0.113.90";
    for (let i = 0; i < 10; i++) expect((await startQr(ip)).status).toBe(200);
    const blocked = await startQr(ip);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toMatch(/Too many sign-in requests/);
    expect((await startQr()).status).toBe(200);
  });

  it("refuses cross-site starts and bad kinds", async () => {
    const r = await callWith({}, null, "/api/v1/auth/app-login", { body: { kind: "qr" }, headers: { origin: "https://evil.example", "cf-connecting-ip": freshIp() } });
    expect(r.status).toBe(403);
    expect((await callWith({}, null, "/api/v1/auth/app-login", { body: { kind: "sms" }, headers: { "cf-connecting-ip": freshIp() } })).status).toBe(400);
    expect((await callWith({}, null, "/api/v1/auth/app-login", { body: {}, headers: { "cf-connecting-ip": freshIp() } })).json.qr).toMatch(/^revflare:\/\/web-login\?/);
  });
});

describe("push with number matching", () => {
  it("pushes to the user's devices and signs in when the right number is picked", async () => {
    const u = await newUser({ push: true });
    const sent = mockApns();
    const start = await startPush(` ${u.email.toUpperCase()} `);
    expect(start.status, start.text).toBe(200);
    expect(Object.keys(start.json).sort()).toEqual(["expiresAt", "id", "number", "secret"]);
    expect(start.json.number).toBeGreaterThanOrEqual(10);
    expect(start.json.number).toBeLessThanOrEqual(99);
    expect(sent).toHaveLength(1);
    const push = sent[0];
    expect(push.url).toBe(`https://api.sandbox.push.apple.com/3/device/${u.apnsToken}`);
    expect(push.headers).toMatchObject({ "apns-topic": "com.example.revflare", "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(Math.floor(start.json.expiresAt / 1000)) });
    expect(push.body).toMatchObject({
      aps: {
        alert: { "title-loc-key": "PUSH_TITLE_WEB_LOGIN", "loc-key": "PUSH_BODY_WEB_LOGIN_NO_PLACE", "loc-args": ["Chrome", "macOS"] },
        category: "WEB_LOGIN",
        "thread-id": "web-login",
        "interruption-level": "time-sensitive",
      },
      type: "web_login",
      id: start.json.id,
    });
    expect(JSON.stringify(push.body)).not.toContain(String(start.json.secret));
    expect(JSON.stringify(push.body)).not.toMatch(new RegExp(`"number"`));

    const info = await app(u.device, start.json.id, "inspect");
    expect(info.status, info.text).toBe(200);
    expect(info.json.kind).toBe("push");
    expect(info.json.numbers).toHaveLength(3);
    expect(new Set(info.json.numbers).size).toBe(3);
    expect(info.json.numbers).toContain(start.json.number);
    expect((await app(u.device, start.json.id, "approve", { number: start.json.number })).json).toEqual({ ok: true });
    const done = await poll(start.json.id, start.json.secret);
    expect(done.json.status).toBe("signed_in");
    expect((await call({ cookie: sessionCookie(done.headers) }, "/api/v1/me")).json.user.id).toBe(u.id);
  });

  it("denies the request when the wrong number is picked", async () => {
    const u = await newUser({ push: true });
    mockApns();
    const start = await startPush(u.email);
    const wrong = start.json.number === 99 ? 98 : start.json.number + 1;
    const r = await app(u.device, start.json.id, "approve", { number: wrong });
    expect(r.status).toBe(403);
    expect((await poll(start.json.id, start.json.secret)).json).toEqual({ status: "denied" });
    expect((await app(u.device, start.json.id, "approve", { number: start.json.number })).status).toBe(410);
    const noNumber = await startPush(u.email);
    expect((await app(u.device, noNumber.json.id, "approve", {})).status).toBe(403);
  });

  it("is only visible to the target user's devices", async () => {
    const u = await newUser({ push: true });
    const other = await newUser({ push: true });
    const sent = mockApns();
    const start = await startPush(u.email);
    expect(sent.map((s) => s.url)).toEqual([`https://api.sandbox.push.apple.com/3/device/${u.apnsToken}`]);
    expect((await app(other.device, start.json.id, "inspect")).status).toBe(404);
    expect((await app(other.device, start.json.id, "approve", { number: start.json.number })).status).toBe(404);
    expect((await app(other.device, start.json.id, "deny")).status).toBe(404);
    expect((await poll(start.json.id, start.json.secret)).json.status).toBe("pending");
  });

  it("answers the same for unknown, disabled and push-less accounts without sending anything", async () => {
    const disabled = await newUser({ push: true });
    await getDb(env).prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(disabled.id).run();
    const noPush = await newUser();
    const sent = mockApns();
    for (const email of [`nobody-${Date.now()}@rf.test`, disabled.email, noPush.email]) {
      const r = await startPush(email);
      expect(r.status).toBe(200);
      expect(Object.keys(r.json).sort()).toEqual(["expiresAt", "id", "number", "secret"]);
      expect((await poll(r.json.id, r.json.secret)).json).toEqual({ status: "pending" });
    }
    expect(sent).toHaveLength(0);
  });

  it("is off without APNs, and validates the email", async () => {
    const u = await newUser({ push: true });
    const sent = mockApns();
    expect((await startPush(u.email, freshIp(), {})).status).toBe(404);
    expect((await startPush("not-an-email")).status).toBe(400);
    expect((await startPush(undefined)).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("allows 3 push requests per email in 10 minutes", async () => {
    const u = await newUser({ push: true });
    const sent = mockApns();
    for (let i = 0; i < 3; i++) expect((await startPush(u.email)).status).toBe(200);
    expect((await startPush(u.email)).status).toBe(429);
    expect(sent).toHaveLength(3);
  });

  it("forgets devices Apple rejects", async () => {
    const u = await newUser({ push: true });
    mockApns(400);
    await startPush(u.email);
    expect(await first("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?", u.id)).toEqual({ n: 0 });
  });
});

describe("helpers", () => {
  it.each([
    [UA, "Chrome", "macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1", "Safari", "iOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox", "Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "Edge", "Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Chrome", "Linux"],
    ["curl/8.0", "Browser", "Unknown OS"],
  ])("reads %s", (ua, browser, os) => {
    expect(describeUserAgent(ua)).toEqual({ browser, os });
  });

  it("offers the right number and two others", () => {
    for (let i = 0; i < 50; i++) {
      const right = 10 + (i % 90);
      const nums = numberChoices(right);
      expect(nums).toHaveLength(3);
      expect(new Set(nums).size).toBe(3);
      expect(nums).toContain(right);
      for (const x of nums) expect(x >= 10 && x <= 99).toBe(true);
    }
  });
});
