interface Env {
  /** Optional D1 database. When bound, it is used instead of the Durable Object database (worker/lib/db.ts). */
  D1?: D1Database;
  /** Optional encryption secret for stored credentials. When unset, a key is generated on first run and stored. */
  SECRET_KEY?: string;
  /** Optional public base URL (e.g. https://revflare.example.com). Defaults to the request origin. */
  PUBLIC_URL?: string;
  /** Optional secret: when set, creating the first user (POST /api/v1/auth/setup) requires it. */
  SETUP_TOKEN?: string;
  /** Cloudflare Email Sending binding (send_email, Workers Paid): sign-in links by email, once turned on in Admin → Settings. */
  EMAIL?: SendEmail;
  /** Sender of those emails, on a domain onboarded to Email Sending: "Revflare <revflare@example.com>" or an address. */
  EMAIL_FROM?: string;
  /** APNs token auth (iOS app push). The key is a secret; key id, team id and topic can be vars. */
  APNS_PRIVATE_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  /** Bundle id of the Revflare iOS app (APNs topic). */
  APNS_TOPIC?: string;
  /** Optional App Store page of the iOS app: the sign-in page links to it next to "Sign in with the iPhone app". */
  APP_STORE_URL?: string;
  /** Daily row budgets for background work (worker/lib/budget.ts); defaults fit the Workers Free plan. */
  BACKGROUND_WRITES_PER_DAY?: string;
  BACKGROUND_READS_PER_DAY?: string;
  /** "false" turns off the daily GitHub release check (Admin → Overview). */
  UPDATE_CHECK?: string;
  /** GitHub repository ("owner/name") the update check asks for releases; default FerdiKT/revflare. */
  UPDATE_REPO?: string;
  // EVENTS (Workers Analytics Engine dataset for RevflareKit app events, POST /sdk/v1/events) comes from wrangler.jsonc
  // (worker-configuration.d.ts); a config without it still works: events are accepted and dropped (worker/lib/events.ts).
  /** Dataset name used in SQL queries (default "revflare_events", must match the EVENTS binding's dataset). */
  EVENTS_DATASET?: string;
  /** Cloudflare account id (var), for querying events through the Analytics Engine SQL API. */
  CF_ACCOUNT_ID?: string;
  /** Secret: API token with Account → Account Analytics → Read, for the Analytics Engine SQL API. */
  CF_ANALYTICS_TOKEN?: string;
  /**
   * Optional service binding to a Worker serving a marketing site (worker/lib/landing.ts): signed-out visitors of `/`
   * and the site's own pages get it; the dashboard, API and every other path are unchanged.
   */
  LANDING?: Fetcher;
  /** Optional Studioflare instance (https://...): unanswered refund requests are also posted as notes there. */
  STUDIOFLARE_URL?: string;
  /** Secret: a Studioflare team key (sfk_tm_...) for those notes. */
  STUDIOFLARE_API_KEY?: string;
  /** Optional team slug of the notes (default: the key's own team). */
  STUDIOFLARE_TEAM?: string;
  /** "true" enables POST /api/v1/dev/seed (synthetic data) — local development only. */
  DEV_SEED?: string;
  /** "true" in the integration tests: trusts the test Apple root certificate, skips external calls. */
  TEST_MODE?: string;
  /** Base64 DER of an extra trusted root for App Store JWS (tests only, honoured with TEST_MODE). */
  TEST_APPLE_ROOT?: string;
}
