-- Sign in on the web with the iOS app (docs/app-login-spec.md): a browser asks, a signed-in device approves. QR codes
-- carry id + nonce (the app proves it saw the code), push requests carry a two-digit number the user picks in the app.
-- Only the SHA-256 of the browser poll secret and of the nonce are kept; a request lives 3 minutes and works once.
-- approved_device_id is the sessions.id of the device session that approved. Rows are removed by the nightly cleanup.
CREATE TABLE web_logins (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL,
  number INTEGER,
  status TEXT NOT NULL,
  ip TEXT,
  city TEXT,
  country TEXT,
  user_agent TEXT,
  approved_device_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_web_logins_expires ON web_logins(expires_at);
-- The sign-in page asks whether any iOS device is signed in (auth status appLogin).
CREATE INDEX idx_sessions_kind ON sessions(kind, expires_at);
