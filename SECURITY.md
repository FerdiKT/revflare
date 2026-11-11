# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through
[GitHub Security Advisories](https://github.com/FerdiKT/revflare/security/advisories/new) ("Report a vulnerability" on
the repository's Security tab).

Include what you found, how to reproduce it and the impact you expect. You will get an answer as soon as possible; once a
fix is released the advisory is published with credit to you (unless you prefer otherwise).

## Supported versions

Fixes go to the `main` branch and the latest release. Self-hosted instances get them by redeploying from an up-to-date
checkout (Admin → Overview shows when a newer release exists; copies made with the Deploy button get an update pull
request from the *Revflare update* workflow, see the README's "Updating"); the `revflare` CLI by rebuilding or
reinstalling it; the iOS app and RevflareKit by rebuilding them.

## Hardening your instance

- **Set `SECRET_KEY`** (`wrangler secret put SECRET_KEY`) before adding App Store Connect, In-App Purchase or
  RevenueCat keys. Without it the encryption key of the stored credentials lives in the database next to them.
- **Create the first user right after deploying, or set `SETUP_TOKEN` first**: until an account exists, whoever opens
  the URL first becomes the instance admin.
- Sign-in is throttled (8 failures per IP or IPv6 /64 and 10 per email, locked for 15 minutes). Passwords are hashed
  with PBKDF2-SHA256; unknown emails cost the same as wrong passwords. Still use long, unique passwords.
- Sign-in links by email (optional: `EMAIL` binding + `EMAIL_FROM`, turned on in Admin → Settings, off by default) work
  once, for 15 minutes, only for existing active accounts; only the token's SHA-256 is stored. The token travels in the
  URL fragment and is used on a click, so mail scanners that open links do not spend it. Requests answer the same
  whether or not the account exists and are limited to 3 per email and 10 per IP per 15 minutes. Turning the setting
  off, disabling or deleting a user, or resetting their password ends outstanding links.
- Signing in on the web with the iOS app (QR code, or a push with number matching) needs a signed-in device of the
  account and Face ID / passcode in the app. A request lives 3 minutes and works once; only SHA-256 hashes of its
  browser secret and QR nonce are stored. The QR code carries the request id and nonce, never the browser's poll
  secret: the session cookie goes only to the browser that started the request, so a photographed code cannot take
  over a session. Push requests make the user pick the number shown in the browser out of three (a wrong pick denies
  the request), against "approve fatigue". Starts are limited to 10 per IP and 3 per email (push) in 10 minutes, and
  answer the same whether or not the account exists. **Relayed QR codes (QRLjacking):** a phishing page can show a
  real Revflare code from its own browser; if the victim approves it, the attacker's browser is signed in. The app
  mitigates this by showing the server host, the requesting browser, its IP and location, and a warning to approve only
  a sign-in you are doing right now; refuse requests you did not start. Codes for another server are refused.
- Give the App Store Connect API key the narrowest role that works (App Manager, plus Sales only if you want Sales and
  Trends reconciliation) and RevenueCat secret keys read access only.
- App Store notifications are accepted only with a valid JWS chain to Apple Root CA G3; the per-app notification URL
  key only routes them. RevflareKit SDK keys (`rfp_...`) are public by design: they can only add install and purchase
  reports for their app; rotate one if it is abused.
- A Revflare API key (`rf_...`) only acts inside its own workspace. It cannot use the instance Admin area (users,
  workspaces, invitations), even when its user is an instance admin. Signing out in the iOS app deletes its device
  token (`rfd_...`) and push registrations; QR pairing codes expire after 10 minutes and work once.
- The only outgoing requests Revflare makes on its own besides Apple, RevenueCat (imports you start), exchange rates
  (`api.frankfurter.dev`) and APNs is the daily update check to `api.github.com` (no instance data is sent);
  `UPDATE_CHECK = "false"` turns it off.
- Invitation links are bearer credentials until they are accepted or expire (7 days).
- Do not set `DEV_SEED` on a deployed instance: it enables an endpoint that writes synthetic data.

## Scope

In scope: the Worker and web app in this repository (authentication, sessions, device tokens, API keys, workspace
isolation and permission checks, App Store notification verification, encryption of stored credentials, the MCP
server, the RevflareKit report endpoint), the `revflare` CLI, the iOS app and RevflareKit.

Out of scope: vulnerabilities of Cloudflare, Apple or RevenueCat themselves (report them to those vendors);
misconfigured self-hosted instances (weak password, leaked API key); denial of service against the Workers Free plan's
quotas.
