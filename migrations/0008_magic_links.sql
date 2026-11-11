-- One-time sign-in links sent by email (Cloudflare Email Sending, the EMAIL binding; off until an instance admin turns
-- on the `magic_link_enabled` setting). Only the sha256 of the token is kept; a link works once, for 15 minutes.
-- Requests are throttled through settings rows ("mail_link:ip:..", "mail_link:email:..").
CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_magic_links_user ON magic_links(user_id);
