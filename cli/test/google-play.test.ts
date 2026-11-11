import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
import { resolveApp } from "../src/resolve.js";
import type { GooglePlaySettings } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch, reply } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const ANDROID = app("app_a", "Example Android", "com.example.app", {
  platform: "android",
  revflareNotificationUrl: "https://rf.test/google/rtdn/k",
  googlePlay: { rtdnUrl: "https://rf.test/google/rtdn/k", configured: true, pushAuth: false, lastCheck: { at: Date.UTC(2026, 9, 20), ok: true } },
  revenue28d: 120,
});
const IOS = app("app_i", "Example iOS", "com.example.app", { revenue28d: 300 });
const APPS = { items: [IOS, ANDROID], currency: "USD" };
const SETTINGS: GooglePlaySettings = {
  appId: "app_a",
  packageName: "com.example.app",
  rtdnUrl: "https://rf.test/google/rtdn/k",
  pushServiceAccount: null,
  credential: { id: "cred_1", name: "revflare@example-project.iam.gserviceaccount.com", clientEmail: "revflare@example-project.iam.gserviceaccount.com", projectId: "example-project", appSpecific: true },
  lastNotificationAt: null,
  lastCheck: null,
  voidedCheckedAt: null,
};

describe("apps (Google Play)", () => {
  it("resolves ios: / android: prefixes when an iOS and an Android app share the bundle id", () => {
    expect(() => resolveApp("com.example.app", APPS.items)).toThrow(/ios:com\.example\.app \/ android:com\.example\.app/);
    expect(resolveApp("android:com.example.app", APPS.items).id).toBe("app_a");
    expect(resolveApp("ios:com.example.app", APPS.items).id).toBe("app_i");
  });

  it("lists the store and filters by --platform", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS });
    expect(await run(["apps", "--platform", "android", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toContain("Google Play");
    expect(out.stdout).toContain("Example Android");
    expect(out.stdout).not.toContain("Example iOS");
    expect(out.stdout).toContain("waiting for RTDN");
    expect(await run(["apps", "--platform", "windows"], { env: loggedInEnv(), fetch })).toBe(2);
  });

  it("adds an Android app", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "POST /apps": (c: any) => ({ ...ANDROID, name: c.body.name }) });
    expect(await run(["apps", "add-android", "Example", "com.example.app", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[0].body).toEqual({ platform: "android", name: "Example", packageName: "com.example.app" });
    expect(out.stdout).toContain("https://rf.test/google/rtdn/k");
    expect(await run(["apps", "add-android", "Example", "not a package"], { env: loggedInEnv(), fetch })).toBe(2);
  });
});

describe("google-play", () => {
  it("shows the status and refuses iOS apps", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "GET /apps/app_a/google-play": SETTINGS });
    expect(await run(["google-play", "android:com.example.app", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toMatch(/Service account\s+revflare@example-project\.iam\.gserviceaccount\.com \(example-project\)/);
    expect(out.stdout).toMatch(/RTDN push URL\s+https:\/\/rf\.test\/google\/rtdn\/k/);
    expect(await run(["google-play", "ios:com.example.app"], { env: loggedInEnv(), fetch })).toBe(1);
  });

  it("uploads a service account key, sets the push account, tests and polls refunds", async () => {
    capture();
    const dir = mkdtempSync(join(tmpdir(), "revflare-gp-"));
    const file = join(dir, "key.json");
    writeFileSync(file, JSON.stringify({ type: "service_account", client_email: "revflare@example-project.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n" }));
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "PUT /apps/app_a/google-play": SETTINGS,
      "POST /apps/app_a/google-play/test": { ok: true },
      "POST /apps/app_a/google-play/voided": { apps: 1, requests: 1, refunded: 2, errors: [] },
    });
    const env = loggedInEnv();
    expect(await run(["google-play", "app_a", "set-credential", file], { env, fetch })).toBe(0);
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body.serviceAccount).client_email).toBe("revflare@example-project.iam.gserviceaccount.com");
    expect(await run(["google-play", "app_a", "set-push-account", "rtdn-push@example-project.iam.gserviceaccount.com"], { env, fetch })).toBe(0);
    expect(calls.filter((c) => c.method === "PUT")[1].body).toEqual({ pushServiceAccount: "rtdn-push@example-project.iam.gserviceaccount.com" });
    expect(await run(["google-play", "app_a", "set-push-account", "none"], { env, fetch })).toBe(0);
    expect(calls.filter((c) => c.method === "PUT")[2].body).toEqual({ pushServiceAccount: null });
    expect(await run(["google-play", "app_a", "set-push-account", "nope"], { env, fetch })).toBe(2);
    expect(await run(["google-play", "app_a", "test"], { env, fetch })).toBe(0);
    expect(await run(["google-play", "app_a", "voided"], { env, fetch })).toBe(0);
    expect(await run(["google-play", "app_a", "explode"], { env, fetch })).toBe(2);
  });

  it("fails the test action when the check fails", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "POST /apps/app_a/google-play/test": { ok: false, error: "Google Play API 403: The caller does not have permission" } });
    expect(await run(["google-play", "app_a", "test"], { env: loggedInEnv(), fetch })).toBe(1);
    expect(out.stderr).toContain("403");
    const notAndroid = mockFetch({ "GET /apps": APPS, "GET /apps/app_i/google-play": reply(400, { error: "Google Play settings are for Android apps" }) });
    expect(await run(["google-play", "app_i"], { env: loggedInEnv(), fetch: notAndroid.fetch })).toBe(1);
  });
});
