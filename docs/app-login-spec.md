# Sign in on the web with the iOS app

Shared spec for Postflare and Revflare (same users / devices model); this copy is adapted to Revflare. A user who is signed in on the iOS app can sign a
browser in without typing a password, in two ways that share one backend object, the **web login request**:

1. **QR (default, shown on the sign-in page):** the page shows a QR code; the user scans it with the app (scanner in
   the app, or the iPhone camera, which opens the app through the URL scheme), sees where the request comes from and
   approves with Face ID / passcode. Nothing to type, and the approval is bound to the browser that shows the code.
2. **Push with number matching (when the QR can't be scanned, e.g. the browser is on the same iPhone):** the user types
   their email and taps "Send to my iPhone"; every device of that user with push enabled gets a notification; the web
   page shows a two-digit number; the app shows three numbers and the user picks the one on the web page, then Face ID.
   A wrong pick denies the request. (Number matching stops "approve fatigue" attacks.)

Both are on by default when the instance has users with the app. Push needs APNs configured (`APNS_*`); without it the
"Send to my iPhone" option is hidden.

## Data

```sql
CREATE TABLE web_logins (
  id TEXT PRIMARY KEY,              -- wl_<random>, in the QR / push payload
  secret_hash TEXT NOT NULL,        -- sha256 of the browser's poll secret (only the browser knows it)
  nonce_hash TEXT NOT NULL,         -- sha256 of the QR nonce (proves the scanner saw this QR)
  user_id TEXT,                     -- push: the target user; QR: set on approval
  kind TEXT NOT NULL,               -- qr | push
  number INTEGER,                   -- push: the 2-digit number shown on the web
  status TEXT NOT NULL,             -- pending | approved | denied | consumed | expired
  ip TEXT, city TEXT, country TEXT, user_agent TEXT,  -- shown in the app (from cf-connecting-ip / request.cf)
  approved_device_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL       -- created_at + 3 minutes
);
```

## API

Browser (public, same-origin checks as other /auth mutations, throttled per IP: 10 starts / 10 min):
- `POST /api/v1/auth/app-login { kind: "qr" }` → `{ id, secret, qr: "revflare://web-login?s=<server origin>&r=<id>&k=<nonce>", expiresAt }`
- `POST /api/v1/auth/app-login { kind: "push", email, turnstileToken? }` → `{ id, secret, number, expiresAt }`. Same answer
  whether or not the email exists or has devices (no enumeration); pushes are only sent to existing active users'
  devices. Push starts are also limited per email (3 / 10 min). (Revflare has no Turnstile; the IP and email throttles apply.)
- `GET /api/v1/auth/app-login/:id` with header `X-Login-Secret: <secret>` → `{ status }`; on `approved` the server marks it
  `consumed` atomically (UPDATE … WHERE status='approved' RETURNING) and sets the normal web session cookie in that same
  response (`{ status: "signed_in", workspaceId? }`). Wrong secret → 404. The page polls every 2 s until expiry, pauses
  while the tab is hidden, and offers "Show a new code".
- `DELETE /api/v1/auth/app-login/:id` (secret header) → cancels.

App (device token auth, the user's own device):
- `POST /api/v1/auth/app-login/:id/inspect { nonce? }` → `{ kind, ip, city, country, browser, os, createdAt, expiresAt, numbers? }`.
  QR: requires the nonce and that the request is pending and unexpired. Push: the request must target this user;
  `numbers` = the right number plus two different random ones, shuffled.
- `POST /api/v1/auth/app-login/:id/approve { nonce?, number? }` → `{ ok }`. QR: nonce must match; sets user_id. Push: the
  number must match, otherwise the request becomes `denied` (403). Marks `approved` with the device id.
- `POST /api/v1/auth/app-login/:id/deny` → `{ ok }`.
- Only users whose status is active; demo users never. Approval of an expired / non-pending request → 410.

Push payload (APNs alert, `category: WEB_LOGIN`, `thread-id: web-login`, `interruption-level: time-sensitive`,
custom `{ "type": "web_login", "id": "<id>" }`, `expiration` = request expiry): title "Sign-in request",
body "<Browser> on <OS> · <City, Country>". Tapping opens the approval sheet. No silent auto-approve, no approve action
from the notification itself (Face ID happens in the app).

## Web UI

Sign-in page: a third option next to password and email link: **"Sign in with the iPhone app"**. It opens a panel with
the QR (rendered client-side from the `qr` string, no third-party service; a small dependency-free QR encoder or one
already in the repo), a countdown, "Show a new code", and a link "Can't scan? Send a request to my iPhone" (email field
→ number display "Tap 42 in the app"). States: waiting, approved → signing in → app, denied, expired. The panel only
shows when the server reports `appLogin: true` in the auth status (at least one signed-in iOS device on the instance), with a small "Get the
app" link if `APP_STORE_URL` is set.

## App UI

- Settings/Account → "Sign in on a computer" opens the scanner (same scanner as onboarding pairing; it recognises both
  pairing QR codes and `web-login` QR codes) and handles `revflare://web-login` deep links from the camera.
- Approval sheet: app icon, "Sign in to <server host>?", browser + OS, location + IP, time, a warning line "Only approve
  if you are signing in right now. Revflare will never ask you to approve a request someone else sends you." Buttons:
  Approve (Face ID / passcode via LocalAuthentication, falls back to passcode) and Deny. Push requests show the three
  number buttons instead of Approve.
- The server URL in the QR must equal the app's configured server, otherwise refuse ("This code is for another server").

## Security notes

- The browser secret never leaves the browser; the QR only carries id + nonce, so a photographed QR cannot be used to
  take over the browser's session (the session cookie goes only to the holder of the secret).
- Risk of a phishing page relaying a real QR (classic QRLJacking): mitigated by showing the browser's IP/location and
  the server host in the app, short expiry, single use. Document it in SECURITY.md.
- Cleanup of old rows in the existing daily job.

## Revflare notes

- Routes: `worker/routes/app-login.ts`, mounted at `/api/v1/auth/app-login` (before `requireAuth`; the app endpoints
  check for a device token themselves). Table: `migrations/0009_web_logins.sql`. Tests: `test/workers/app-login.test.ts`.
- `appLogin` = a non-expired device session (`sessions.kind = 'device'`) exists; `pushLogin` = APNs configured and one
  of those sessions has a `devices` row. Push devices are the user's `devices` rows whose session is still valid.
- `approved_device_id` is the approving device session's `sessions.id`; the browser session opens that session's
  workspace (`workspaceId` in the poll answer).
- Revflare has no demo users. QR `deny` also needs the nonce (so only someone who saw the code can end it); a browser
  `DELETE` marks the request `expired`.
- The QR's `s` is the server's public URL (`PUBLIC_URL` / the stored `public_url`, as in pairing codes). The app
  compares scheme, host and port with its configured server.
- Push texts are localized on the device: `PUSH_TITLE_WEB_LOGIN`, `PUSH_BODY_WEB_LOGIN` (browser, OS, place) and
  `PUSH_BODY_WEB_LOGIN_NO_PLACE` (browser, OS).
