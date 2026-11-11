// REST API v1 contract (`/api/v1`), shared by the Worker, the web app and the CLI. The iOS app mirrors these in
// ios/Revflare/Core/Models.swift. Amounts are in the response's `currency` (the workspace's reporting currency)
// unless a field ends in `Usd`.

export type Role = "owner" | "admin" | "viewer";
export type Permission = "read" | "manage" | "members" | "delete";

export interface User {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  /** Opted in to the daily digest email (sent only when the server has email configured). */
  dailyDigestEmail?: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  currency: string;
}

export interface Me {
  user: User;
  workspace: (WorkspaceSummary & { permissions: Permission[] }) | null;
  workspaces: WorkspaceSummary[];
  auth: "session" | "device" | "api_key";
  version: string;
  apiVersion: number;
  /** push: APNs configured; email: Email Sending configured (daily digest email can be turned on). */
  features: { push: boolean; email?: boolean };
}

export interface AuthStatus {
  setup: boolean;
  authenticated: boolean;
  setupToken?: boolean;
  /** Sign-in links by email are offered (EMAIL binding + EMAIL_FROM set, turned on in Admin → Settings). */
  magicLink?: boolean;
  /** "Sign in with the iPhone app" is offered (at least one iOS device is signed in on this instance). */
  appLogin?: boolean;
  /** The push variant ("Send a request to my iPhone") is offered too (APNs configured, devices with push). */
  pushLogin?: boolean;
  /** App Store page of the iOS app (APP_STORE_URL), for a "Get the app" link. */
  appStoreUrl?: string;
}

/** POST /auth/app-login: a web login request the iOS app approves (docs/app-login-spec.md). */
export interface WebLoginStart {
  id: string;
  /** Poll secret (header X-Login-Secret); only the browser has it. */
  secret: string;
  /** QR requests: revflare://web-login?s=<server>&r=<id>&k=<nonce> (shown as a QR code). */
  qr?: string;
  /** Push requests: the number to pick in the app. */
  number?: number;
  expiresAt: number;
}

export type WebLoginStatus = "pending" | "approved" | "denied" | "consumed" | "expired" | "signed_in";

/** GET /auth/app-login/:id. `signed_in` comes with the session cookie (once). */
export interface WebLoginPoll {
  status: WebLoginStatus;
  workspaceId?: string;
}

/** POST /auth/app-login/:id/inspect (iOS app): where the request comes from. */
export interface WebLoginInfo {
  kind: "qr" | "push";
  ip: string | null;
  city: string | null;
  country: string | null;
  browser: string;
  os: string;
  createdAt: number;
  expiresAt: number;
  /** Push requests: three numbers, one of them shown on the web page. */
  numbers?: number[];
}

export interface DeviceTokenResponse {
  token: string;
  user: User;
  workspace: WorkspaceSummary | null;
  server: string;
}

export interface PairingCode {
  code: string;
  /** revflare://pair?server=...&code=... (shown as a QR code). */
  url: string;
  expiresAt: number;
}

export interface DevicePrefs {
  sales: boolean;
  renewals: boolean;
  trials: boolean;
  refunds: boolean;
  cancellations: boolean;
  alerts: boolean;
  /** Event silence, funnel anomaly and release regression alerts (default true). */
  funnelAlerts?: boolean;
  dailySummary: boolean;
  weeklySummary: boolean;
  minUsd: number;
  apps: string[] | null;
  /** Per app id: `muted` silences the app's sale / event notifications; a kind set here wins over the global one. */
  appOverrides?: Record<
    string,
    { muted?: boolean; sales?: boolean; renewals?: boolean; trials?: boolean; refunds?: boolean; cancellations?: boolean; alerts?: boolean; funnelAlerts?: boolean }
  >;
  sound: "cash" | "default" | "none";
  quietStart: string | null;
  quietEnd: string | null;
  timezone: string;
  locale: string;
  /** Push texts (loc-keys) the app build knows: 1 = funnel alerts and the summary's digest line (older builds: 0, they get neither). */
  pushVersion?: number;
}

export interface Device {
  id: string;
  name: string | null;
  environment: "production" | "sandbox";
  prefs: DevicePrefs;
  liveActivity: boolean;
  createdAt: number;
  lastPushAt: number | null;
}

// Apps ------------------------------------------------------------------------------------------------------------

export type NotificationUrlStatus = "revflare" | "other" | "none" | "unknown";

/** ios: App Store app (bundle id); android: Google Play app (bundleId = package name, docs/google-play.md); web: a website selling through Polar (docs/polar.md). */
export const APP_PLATFORMS = ["ios", "android", "web"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

export interface App {
  id: string;
  name: string;
  /** "ios" | "android" | "web" (AppPlatform). Apple-only features (App Store Connect, Apple Ads, refund requests, offers, acquisition) are iOS only. */
  platform: string;
  /** iOS: the bundle id; Android: the package name. */
  bundleId: string | null;
  appleAppId: string | null;
  iconUrl: string | null;
  commissionPct: number;
  archived: boolean;
  /** Where Apple sends this app's notifications. "other": e.g. RevenueCat — Revflare then polls Notification History. */
  notificationUrlStatus: NotificationUrlStatus;
  /** The URL to give Apple (App Store Connect → App Information → App Store Server Notifications). */
  revflareNotificationUrl: string;
  currentNotificationUrl: string | null;
  lastNotificationAt: number | null;
  lastHistorySyncAt: number | null;
  historyBackfilledFrom: string | null;
  rcProjectId: string | null;
  /** False when Apple has no production data for the app yet (never released). */
  storeAvailable: boolean | null;
  /** Public key RevflareKit embeds (Apple Ads attribution, /sdk/v1). */
  sdkKey: string | null;
  /** Verified App Store notifications are also POSTed unchanged to this URL (e.g. the app's RevenueCat notification URL). */
  forwardNotificationUrl?: string | null;
  /** Last forward attempt (status 0 = network error). */
  forwardStatus?: { at: number; status: number; error?: string } | null;
  /** Meta Ads integration on (GET /apps/:id/integrations/meta has the settings). */
  metaEnabled?: boolean;
  /** Answers to Apple's refund requests on (GET /apps/:id/integrations/refunds has the settings). */
  refundRequestsEnabled?: boolean;
  /** App Analytics report request (GET /apps/:id only). */
  acquisition?: AcquisitionStatus;
  /** Android apps: Google Play setup summary (GET /apps/:id/google-play has the details). */
  /** Web apps: Polar setup summary (GET /apps/:id/polar has the details). */
  polar?: { webhookUrl: string; connected: boolean } | null;
  googlePlay?: { rtdnUrl: string; configured: boolean; pushAuth: boolean; lastCheck: GooglePlayCheck | null } | null;
  mrr: number;
  revenue28d: number;
  activeSubscriptions: number;
  activeTrials: number;
}

export interface GooglePlayCheck {
  at: number;
  ok: boolean;
  error?: string;
}

/** GET / PUT /apps/:id/polar: a web app's Polar setup (docs/polar.md). */
export interface PolarSettings {
  appId: string;
  /** Webhook endpoint URL to add in Polar (Settings → Webhooks; secret: anyone with it and the signing secret can post). */
  webhookUrl: string;
  /** A webhook signing secret is stored (webhooks are verified and applied). */
  connected: boolean;
  /** An organization access token is stored (webhook endpoint creation, order import). */
  hasAccessToken: boolean;
  /** Polar sandbox: sales are stored as Sandbox. */
  sandbox: boolean;
  /** Polar product id → Revflare product id (unmapped products keep their Polar id). */
  products: Record<string, string>;
  /** The Polar webhook endpoint Revflare created with the access token. */
  webhookEndpointId: string | null;
  lastNotificationAt: number | null;
  /** Last order import (POST /apps/:id/polar/sync). */
  lastSync: { at: number; orders: number; error?: string } | null;
  /** Webhook events Revflare uses. */
  events: readonly string[];
}

/** GET / PUT /apps/:id/google-play: an Android app's Google Play setup. */
export interface GooglePlaySettings {
  appId: string;
  packageName: string;
  /** Push endpoint for the Pub/Sub subscription of the app's real-time developer notifications (secret: anyone with it can post). */
  rtdnUrl: string;
  /** Service account Pub/Sub authenticates its pushes with (OIDC token, verified when set). */
  pushServiceAccount: string | null;
  /** The service account key the app uses (its own, else the workspace's newest google_play key); null: none yet. */
  credential: { id: string; name: string; clientEmail: string | null; projectId: string | null; appSpecific: boolean } | null;
  lastNotificationAt: number | null;
  /** Last service account check or Play API call: ok, or the error. */
  lastCheck: GooglePlayCheck | null;
  /** Last daily voided purchases poll (refunds RTDN missed). */
  voidedCheckedAt: number | null;
}

export interface Product {
  productId: string;
  name: string | null;
  type: string | null;
  period: string | null;
}

/**
 * appstore_reports: an optional App Store Connect key for reports only (Sales and Trends, App Analytics), e.g. one with
 * the Sales role; reports use it before the main appstore_connect key.
 * google_play: a Google Cloud service account JSON key (Android apps: Play Developer API). keyId = private_key_id,
 * issuerId = client_email, config { projectId, clientEmail }.
 */
export type CredentialKind = "appstore_iap" | "appstore_connect" | "appstore_reports" | "revenuecat" | "google_play";

export interface CredentialView {
  id: string;
  kind: CredentialKind;
  name: string;
  keyId: string | null;
  issuerId: string | null;
  config: Record<string, unknown>;
}

// Metrics -----------------------------------------------------------------------------------------------------------

export type Interval = "day" | "week" | "month";

export const METRICS = [
  "revenue",
  "proceeds",
  "mrr",
  "mrr_proceeds",
  "arr",
  "active_subscriptions",
  "active_trials",
  "new_subscriptions",
  "renewals",
  "one_time_purchases",
  "trials_started",
  "trial_conversions",
  "trial_conversion_rate",
  "refunds",
  "refunds_amount",
  "refund_rate",
  "churn_rate",
  "churned_subscriptions",
  "new_customers",
  "arppu",
] as const;
export type Metric = (typeof METRICS)[number];

export type MetricFormat = "money" | "count" | "percent";

export interface Point {
  date: string;
  value: number;
}

export interface Series {
  key: string;
  label: string;
  points: Point[];
  total?: number;
}

export interface Chart {
  metric: Metric;
  format: MetricFormat;
  currency: string;
  interval: Interval;
  from: string;
  to: string;
  points: Point[];
  /** Sum (flows) or last value (stocks) over the range. */
  total: number;
  /** Same metric over the previous range of equal length. */
  previousTotal: number | null;
  /** Breakdown when `groupBy` is set (top groups + "other"). */
  series?: Series[];
  /** Dates whose values come from an import (RevenueCat Charts) rather than transactions. */
  importedUntil?: string | null;
}

export interface Kpi {
  id: string;
  metric: Metric;
  label: string;
  format: MetricFormat;
  value: number;
  previous: number | null;
  /** Relative change vs previous (0.12 = +12%). */
  change: number | null;
  /** Last 28 days (or 12 months for MRR-like), oldest first. */
  spark: number[];
}

/** Goal metrics: money (stored in USD, shown in the workspace currency) and counts. */
export const GOAL_METRICS = ["revenue", "proceeds", "mrr", "new_subscriptions", "trials_started", "active_subscriptions", "sales"] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
/** Rolling periods start over (weeks start on Monday, UTC days); a custom period runs from startDate to endDate and ends. */
export const GOAL_PERIODS = ["week", "month", "quarter", "year", "custom"] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];
/** all: every app of the workspace; include: the listed apps; exclude: every app but the listed ones (apps added later count). */
export const GOAL_SCOPES = ["all", "include", "exclude"] as const;
export type GoalScope = (typeof GOAL_SCOPES)[number];

export interface Goal {
  id: string;
  /** Custom name (≤ 60 characters); null = unnamed (show `label`). */
  name: string | null;
  /** The name, else a generated English label ("Revenue · 3 apps"). */
  label: string;
  metric: GoalMetric;
  /** money (workspace currency) or count. */
  format: "money" | "count";
  /** flow: summed over the period (revenue, proceeds, new subscriptions, trials, sales); stock: a level (MRR, active subscriptions). */
  kind: "flow" | "stock";
  period: GoalPeriod;
  /** Custom period: first and last day (YYYY-MM-DD, inclusive); null for rolling periods. */
  startDate: string | null;
  endDate: string | null;
  /** In the workspace currency for money metrics. */
  target: number;
  scope: GoalScope;
  /** The included (scope include) or excluded (scope exclude) apps; empty for all. */
  appIds: string[];
  /** The app of a goal on exactly one app (scope include with one app), else null (older clients). */
  appId: string | null;
  archived: boolean;
  /** Push to the workspace's devices when the goal is reached (once per period). */
  notify: boolean;
  sortOrder: number;
  createdAt: number;
}

export type GoalPace = "upcoming" | "on_track" | "behind" | "reached" | "missed";

export interface GoalProgress extends Goal {
  /** The current (or, for an ended custom goal, the last) period: first and last day, UTC. */
  periodStart: string;
  periodEnd: string;
  /** "2026-10" (month), "2026-Q4", "2026", "2026-W44" (ISO week), "2026-10-01..2026-12-31" (custom). */
  periodLabel: string;
  status: "upcoming" | "active" | "ended";
  daysTotal: number;
  /** Days of the period so far, today included. */
  daysElapsed: number;
  /** Whole days after today until the period ends. */
  daysLeft: number;
  /** Flow: the period's total so far; stock: today's value. */
  current: number;
  /** Stock metrics: the value at the start of the period (end of the day before), for "change in period"; null for flow. */
  startValue: number | null;
  /** current / target. */
  progress: number;
  /** End-of-period value at the current pace (flow: linear extrapolation; stock: the current value). */
  projected: number;
  /** Where a linear path to the target would be today (stock: from startValue to the target). */
  expected: number;
  /** current - expected: ahead (> 0) or behind (< 0). */
  delta: number;
  pace: GoalPace;
  /** Still needed per remaining day to hit the target (0 once reached; null when the period has ended). */
  requiredPerDay: number | null;
  /** First day the target was reached in this period. */
  reachedAt: string | null;
  /** The previous period of a rolling goal: its final value and whether it hit the (current) target. */
  previous: { periodStart: string; periodEnd: string; periodLabel: string; value: number; reached: boolean } | null;
}

/** POST /goals body (PATCH /goals/:id: any subset). Money targets in the workspace currency. */
export interface GoalInput {
  name?: string | null;
  metric?: GoalMetric;
  target?: number;
  period?: GoalPeriod;
  startDate?: string | null;
  endDate?: string | null;
  scope?: GoalScope;
  appIds?: string[];
  /** Older clients: one app (= scope include [appId]). */
  appId?: string | null;
  archived?: boolean;
  notify?: boolean;
}

export interface Overview {
  currency: string;
  asOf: number;
  today: { revenue: number; proceeds: number; sales: number; newSubscriptions: number; trialsStarted: number; refunds: number; date: string };
  yesterday: { revenue: number; proceeds: number; sales: number };
  kpis: Kpi[];
  mrrMovement: { new: number; expansion: number; contraction: number; churn: number; reactivation: number; net: number };
  atRisk: { mrr: number; subscriptions: number };
  forecast30: number;
  goals: GoalProgress[];
  records: { bestDay: { date: string; revenue: number } | null; todayIsRecord: boolean; bestMonth: { date: string; revenue: number } | null };
  topApps: { appId: string; name: string; iconUrl: string | null; revenue28d: number; mrr: number; change: number | null; platform?: string }[];
  alerts: Alert[];
}

export interface MrrMovement {
  currency: string;
  interval: Interval;
  points: { date: string; new: number; expansion: number; contraction: number; churn: number; reactivation: number; net: number; mrr: number }[];
}

export interface Breakdown {
  metric: Metric;
  by: "app" | "country" | "product";
  currency: string;
  from: string;
  to: string;
  rows: { key: string; label: string; value: number; share: number; iconUrl?: string | null; appId?: string }[];
}

/** "cancellation": auto-renew turned off, only in the feed's cancellations stream (`GET /transactions?cancellations=true`). */
export type TransactionKind = "trial" | "conversion" | "new" | "renewal" | "one_time" | "cancellation";

/** A purchase within this long of the install, or a cancellation within this long of the purchase, is "quick" (5 minutes, inclusive). */
export const QUICK_ACTION_MS = 5 * 60_000;

export interface Transaction {
  id: string;
  appId: string;
  appName: string;
  appIconUrl: string | null;
  customerId: string | null;
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  productName: string | null;
  kind: TransactionKind;
  purchasedAt: number;
  expiresAt: number | null;
  price: number;
  storeCurrency: string | null;
  storePrice: number;
  proceeds: number;
  country: string | null;
  environment: string;
  refundedAt: number | null;
  /** Percentage refunded (100 = full refund, e.g. 40 for a prorated refund); null when not refunded. */
  refundPercentage?: number | null;
  /** Offer label: discount type for introductory offers ("free trial"), else the offer type ("win-back", "promotional (pay as you go)"). */
  offer: string | null;
  /** Apple offerType: 1 introductory, 2 promotional, 3 offer code, 4 win-back (OFFER_TYPE_LABELS). */
  offerType?: number | null;
  /** Offer identifier (promotional / offer code / win-back). */
  offerId?: string | null;
  source: string;
  /** Acquisition of the install that made the purchase (install_links / appAccountToken → RevflareKit attribution); source unknown when no install is linked. */
  attribution?: AdsAttribution | null;
  /** Transactions feed, subscription rows: current auto-renew state of the subscription (false: cancelled, it ends at its expiry). */
  autoRenew?: boolean;
  /** app_store | play_store | polar */
  store?: string;
  /** Feed: ms from the RevflareKit install to this purchase, on the customer's first purchase / trial when the install time is known (null otherwise). */
  sinceInstallMs?: number | null;
  /** Feed, subscription rows whose auto-renew is off: ms from this purchase to auto-renew being turned off within its period (null otherwise). */
  cancelledAfterMs?: number | null;
  /** Cancellation rows: ms from the subscription's latest purchase / trial start before the cancellation (null when unknown). */
  sincePurchaseMs?: number | null;
  /** Cancellation rows: kind of that purchase ("trial": a trial was cancelled). */
  purchaseKind?: TransactionKind | null;
  /** Feed: bought within QUICK_ACTION_MS of the install, or cancelled within QUICK_ACTION_MS of the purchase. */
  quick?: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** Transactions feed: totals of each day the page touches (local days, see `tzOffset`), newest first. */
  days?: { date: string; revenue: number; proceeds: number; sales: number; count: number }[];
  /** Currency of the amounts (transactions). */
  currency?: string;
}

export interface Subscription {
  id: string;
  appId: string;
  appName: string;
  customerId: string | null;
  originalTransactionId: string;
  productId: string;
  productName: string | null;
  status: "trial" | "active" | "grace" | "billing_retry" | "expired" | "revoked" | "refunded";
  autoRenew: boolean;
  startedAt: number;
  expiresAt: number | null;
  period: string | null;
  mrr: number;
  country: string | null;
  /** Customer endpoint: when auto-renew was turned off (latest DID_CHANGE_RENEWAL_STATUS / AUTO_RENEW_DISABLED), null while it is on or unknown. */
  autoRenewOffAt?: number | null;
  /** Google Play: why it was cancelled, user[:<survey reason>] | system | developer | replacement. */
  cancelReason?: string | null;
  /** Customer endpoint: ms from the latest purchase / trial start before `autoRenewOffAt` to it (null while on or unknown). */
  cancelledAfterMs?: number | null;
}

/** One Apple notification of a customer's subscriptions / purchases (customer history). */
export interface CustomerEvent {
  /** Apple notificationType, e.g. SUBSCRIBED, DID_RENEW, DID_CHANGE_RENEWAL_STATUS, EXPIRED, REFUND. */
  type: string;
  /** Apple subtype, e.g. AUTO_RENEW_DISABLED, INITIAL_BUY, VOLUNTARY. */
  subtype: string | null;
  /** Apple signedDate (ms). */
  at: number;
  productId: string | null;
  environment: string;
  /** Apple transaction id of the notification's transaction (matches `transactions[].transactionId`), when it has one. */
  transactionId?: string | null;
}

/** Customer timing (GET /customers/:id `timing`): how fast they bought, cancelled and asked for a refund. */
export interface CustomerTiming {
  /** First purchase or trial start (ms) and its kind. */
  firstPurchaseAt: number | null;
  firstPurchaseKind: TransactionKind | null;
  /** Install (RevflareKit) → first purchase / trial start, ms; null without an install time before it. */
  installToPurchaseMs: number | null;
  /** Fastest purchase / trial start → auto-renew turned off over the customer's subscriptions, ms; null: never turned off (or unknown). */
  purchaseToCancelMs: number | null;
  /** When that cancellation happened (ms). */
  cancelledAt: number | null;
  /** Fastest purchase → refund, ms; null: no refund. */
  purchaseToRefundMs: number | null;
  refundedAt: number | null;
  /** First purchase / trial within QUICK_ACTION_MS of the install. */
  quickPurchase: boolean;
  /** Auto-renew turned off within QUICK_ACTION_MS of a purchase / trial start. */
  quickCancel: boolean;
}

export interface Customer {
  id: string;
  appId: string;
  appName: string;
  country: string | null;
  /** Earliest of the RevflareKit install time and the first transaction (ms). */
  firstSeenAt: number;
  /** "install": the RevflareKit install; "purchase": the first transaction (no earlier install known). */
  firstSeenSource?: "install" | "purchase";
  firstPaidAt: number | null;
  /** Latest of the app's activity (RevflareKit key events and reports), transactions (not after now) and store notifications (ms). */
  lastSeenAt: number;
  /** "app": RevflareKit (key events / reports); "purchase": a transaction; "notification": an App Store / Google Play notification. */
  lastSeenSource?: "app" | "purchase" | "notification";
  /** Install time of the customer's earliest linked RevflareKit install (ms), null when no install is linked. */
  installedAt?: number | null;
  /** "device": the first launch RevflareKit recorded on the device; "first_report": its first report reached Revflare. */
  installedAtSource?: "device" | "first_report" | null;
  timing?: CustomerTiming;
  totalSpent: number;
  totalProceeds: number;
  appAccountToken: string | null;
  rcAppUserId: string | null;
  /** Consent to share consumption data with Apple for refund requests (PUT /customers/:id/refund-consent). */
  refundDataConsent?: boolean;
  /** Acquisition of the install of the customer's first linked transaction (unknown: no RevflareKit install linked). */
  attribution?: AdsAttribution | null;
  subscriptions: Subscription[];
  transactions: Transaction[];
  /** Apple notification history of the customer's subscriptions and purchases, newest first (at most 100; Production only unless the customer is sandbox-only). */
  events?: CustomerEvent[];
}

export interface AtRisk {
  currency: string;
  /** MRR that will not renew unless something changes. */
  mrr: number;
  groups: { reason: "billing_retry" | "grace" | "cancelled"; label: string; mrr: number; subscriptions: number }[];
  items: Subscription[];
}

export interface Forecast {
  currency: string;
  days: number;
  expected: number;
  /** Renewal rate used per period (P1M → 0.82). */
  renewalRates: Record<string, number>;
  points: { date: string; due: number; expected: number }[];
}

export interface Cohorts {
  currency: string;
  /** Month of the first payment. */
  rows: { cohort: string; customers: number; revenue: number[]; ltv: number[]; retained: number[] }[];
}

/**
 * Alert kinds: notifications_silent, sync_failing, revenue_drop, refund_spike (revenue side) and events_silent,
 * funnel_anomaly, release_regression (app events and funnels, docs/funnels.md#alerts), experiment_result (an
 * experiment reached a confident result, docs/experiments.md), key_events_capped (an app reached its daily key-event
 * cap or the background budget: the rest of the day is sampled, docs/funnels.md#exact-key-events), google_play_test (info: a
 * Google Play test notification reached the app's RTDN URL, docs/google-play.md), refund_request_unanswered
 * (an Apple refund request could not be answered: settings off, Apple refused, window passed, docs/refund-requests.md).
 */
export const ALERT_KINDS = ["notifications_silent", "sync_failing", "revenue_drop", "refund_spike", "events_silent", "funnel_anomaly", "release_regression", "experiment_result", "key_events_capped", "google_play_test", "refund_request_unanswered"] as const;

export interface Alert {
  id: string;
  appId: string | null;
  /** One of ALERT_KINDS (older servers may send others). */
  kind: string;
  /** funnel_anomaly / release_regression: the funnel (report at /apps/:appId/funnels/:funnelId). */
  funnelId?: string | null;
  /** experiment_result: the experiment (results at /apps/:appId/experiments/:experimentId). */
  experimentId?: string | null;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  createdAt: number;
  resolvedAt: number | null;
}

export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  params: Record<string, unknown>;
  progress: Record<string, unknown>;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface ReconciliationRow {
  day: string;
  appId: string | null;
  apple: { units: number; proceeds: number; gross: number } | null;
  revflare: { units: number; proceeds: number; gross: number } | null;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  createdAt: number;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

// App Store acquisition (Apple's App Analytics reports) ---------------------------------------------------------------

/**
 * Where App Store visitors came from (Apple's "Source Type"): App Store search, App Store browse, App referrer,
 * Web referrer, App Clip, Notification, Institutional purchase, Unavailable. Apple Ads taps count as App Store search.
 */
export type AcquisitionDimension = "day" | "app" | "source" | "referrer" | "campaign";

export interface AcquisitionMetrics {
  /** App icon seen in a list (search results, Today, charts...). */
  impressions: number;
  impressionsUnique: number;
  /** Product page / in-app event page / store sheet views. */
  pageViews: number;
  pageViewsUnique: number;
  /** First-time downloads. */
  downloads: number;
  redownloads: number;
  /** downloads / unique page views (page views when Apple gives no unique count); null without page views. */
  conversionRate: number | null;
  /** App Store purchases (paid app + in-app purchases, refunds subtract) by the source of the download. */
  purchases: number;
  /** Apple's estimate, in the response currency. */
  proceeds: number;
  sales: number;
}

export interface AcquisitionRow extends AcquisitionMetrics {
  day?: string;
  appId?: string;
  sourceType?: string;
  /** Source Info: the app (bundle id) or website that referred the visitor; "" when none. */
  referrer?: string;
  /** Campaign token (`ct=` in an App Store link); "" when none. */
  campaign?: string;
}

/** GET /acquisition */
export interface Acquisition {
  currency: string;
  from: string;
  to: string;
  by: AcquisitionDimension[];
  /**
   * standard: Apple's Standard reports (complete totals, by source type); detailed: the Detailed reports (referrer and
   * campaign; Apple leaves out rows with fewer than 5 users and adds a little noise, so they sum to less).
   */
  level: "standard" | "detailed";
  totals: AcquisitionMetrics;
  rows: AcquisitionRow[];
  /** First and last day with data for the scope (any range). */
  firstDay: string | null;
  lastDay: string | null;
}

/** GET /acquisition/campaigns: campaign tokens seen in Apple's reports (all time). */
export interface AcquisitionCampaign {
  campaign: string;
  appId: string;
  appleAppId: string | null;
  firstSeen: string;
  lastSeen: string;
  impressions: number;
  pageViews: number;
  downloads: number;
  redownloads: number;
  purchases: number;
  proceeds: number;
}

/**
 * State of the app's App Analytics report request: none (not requested), requested (waiting for Apple's first
 * reports, 1–2 days), producing (reports arriving), stopped (Apple stopped it after a long time without downloads: a
 * new request is made), failed (see error).
 */
export type AcquisitionState = "none" | "requested" | "producing" | "stopped" | "failed";

export interface AcquisitionStatus {
  appId: string;
  appleAppId: string | null;
  state: AcquisitionState;
  requestId: string | null;
  requestedAt: number | null;
  checkedAt: number | null;
  /** Reports Apple produces for the request (found so far). */
  reports: string[];
  /** Newest processing date imported and the day range of the stored data. */
  lastProcessingDate: string | null;
  firstDay: string | null;
  lastDay: string | null;
  error: string | null;
}

/** Revenue of installs Apple attributed to Apple Ads (RevflareKit), per day, app, campaign, ad group and keyword. */
export interface AttributedRevenue {
  currency: string;
  from: string;
  to: string;
  /** Installs that reported to RevflareKit in the range, and how many of them Apple attributed to Apple Ads. */
  /** Test data counted (`includeTest=true`): test attribution (Apple's AdServices test payload), sandbox / Xcode builds and test devices. */
  includeTest?: boolean;
  /**
   * Installs that reported to RevflareKit in the range, how many of them Apple attributed to Apple Ads (test attribution
   * never counts), and installs with Apple's test attribution (hidden unless includeTest).
   */
  coverage: { installs: number; attributed: number; testInstalls?: number };
  rows: {
    date: string;
    appId: string;
    appleAppId: string | null;
    campaignId: string;
    adGroupId: string | null;
    keywordId: string | null;
    /** Names from PUT /attribution/names (null when unknown: show "#<id>"). */
    campaignName?: string | null;
    adGroupName?: string | null;
    keywordName?: string | null;
    /** Test data (with includeTest): Apple's test attribution, a sandbox / Xcode build or a test device. */
    test?: boolean;
    revenue: number;
    proceeds: number;
    transactions: number;
    trials: number;
    installs: number;
    payers: number;
  }[];
}

/**
 * Acquisition of a purchase or customer (feed, customer): the RevflareKit install linked to it (install_links by
 * original transaction id, or appAccountToken = install id) and what Apple said about it. unknown: no install linked or
 * Apple has not answered yet; ids and names only for apple_ads (names from PUT /attribution/names, null when unknown).
 */
export interface AdsAttribution {
  /** InstallSource: google_ads / referral come from the Play Install Referrer of Android installs. */
  source: InstallSource;
  /** Apple's AdServices test payload (development / TestFlight builds): left out of attribution totals, LTV and Meta. */
  test: boolean;
  campaignId: string | null;
  campaignName: string | null;
  adGroupId: string | null;
  adGroupName: string | null;
  keywordId: string | null;
  keywordName: string | null;
}

/** Campaign id of Apple's AdServices test payload (ad group 1234567890, keyword 12323222, org 1234567890 too). */
export const TEST_ATTRIBUTION_CAMPAIGN_ID = "1234567890";

export const ADS_NAME_KINDS = ["campaign", "adgroup", "keyword"] as const;
export type AdsNameKind = (typeof ADS_NAME_KINDS)[number];

/** An Apple Ads campaign / ad group / keyword name (GET / PUT /attribution/names). */
export interface AdsName {
  kind: AdsNameKind;
  /** Apple Ads id (digits). */
  id: string;
  name: string;
}

/** Names per PUT /attribution/names request. */
export const ADS_NAMES_LIMIT = 1000;

/** GET /attribution/names. */
export interface AdsNames {
  names: AdsName[];
}

/** PUT /attribution/names: names written (new or changed) and deleted (empty name); unchanged ones cost nothing. */
export interface AdsNamesUpdate {
  updated: number;
  deleted: number;
}

// RevflareKit installs ---------------------------------------------------------------------------------------------

/**
 * The build RevflareKit runs in: production (App Store / Google Play), sandbox (TestFlight / development build / Play
 * test track), xcode (StoreKit configuration file), debug (debuggable Android build; test data like xcode). Missing or
 * invalid = production (older SDKs).
 */
export const SDK_ENVIRONMENTS = ["production", "sandbox", "xcode", "debug"] as const;
export type SdkEnvironment = (typeof SDK_ENVIRONMENTS)[number];

/**
 * How an install was acquired: apple_ads (Apple attributed it), google_ads (Android: the Play Install Referrer has a
 * gclid), referral (Android: a utm_source other than Play's organic "google-play"), organic (none of these, or no
 * attribution could be had), unknown (not answered yet).
 */
export const INSTALL_SOURCES = ["apple_ads", "google_ads", "referral", "organic", "unknown"] as const;
export type InstallSource = (typeof INSTALL_SOURCES)[number];

/** POST /sdk/v1/report answer. Apple Ads ids only for apple_ads. */
export interface SdkReportResponse {
  ok: true;
  /** pending | resolved | failed. */
  attribution: string | null;
  source: InstallSource;
  campaignId: string | null;
  adGroupId: string | null;
  keywordId: string | null;
}

/** Test devices of an app: install ids left out of events, funnels, experiments, LTV and attribution (with sandbox and Xcode data). */
export const TEST_INSTALLS_LIMIT = 50;

/** GET / PUT /apps/:id/test-devices. */
export interface TestDevices {
  appId: string;
  installIds: string[];
  limit: number;
}

// LTV by acquisition source (`/ltv`, `/ltv/summary`, docs/ltv.md) ----------------------------------------------------

/** Install grouping: source (apple_ads | organic), Apple Ads campaign / ad group / keyword (organic installs = "organic"), country. */
export type LtvDimension = "source" | "campaign" | "adgroup" | "keyword" | "country";
export const LTV_DIMENSIONS: LtvDimension[] = ["source", "campaign", "adgroup", "keyword", "country"];
export type LtvCohortUnit = "day" | "week" | "month";

/** Value of a cohort (or group) at a horizon: what its installs paid in the first `day` days (D0 = first 24 hours). */
export interface LtvHorizon {
  /** Days after install (0 = the first 24 hours); null = to date. */
  day: number | null;
  /** The cohort is younger than the horizon: values are null. */
  immature: boolean;
  revenuePerInstall: number | null;
  proceedsPerInstall: number | null;
  /** Installs that paid within the horizon. */
  payers: number | null;
}

export interface LtvGroup {
  /** Group key: apple_ads | organic (source), the campaign id, campaignId/adGroupId, campaignId/adGroupId/keywordId ("none" for a missing id), the country code or "unknown"; organic installs are "organic" for campaign / ad group / keyword. */
  group: string;
  campaignId: string | null;
  adGroupId: string | null;
  keywordId: string | null;
  country: string | null;
}

export interface LtvCoverage {
  /** Installs that reported to RevflareKit in the range (pre-existing ones excluded), and how many Apple attributed to Apple Ads. */
  installs: number;
  attributed: number;
  /** Installs not counted in `installs` or any value: every purchase linked to them started more than 48 hours before the install (users who had the app before, reinstalls). */
  preexisting: number;
  /** The apps' customers whose first payment is in the range (or later), and how many are linked to a reporting install (by a purchase that counts). */
  payingCustomers: number;
  linkedCustomers: number;
  /** linkedCustomers / payingCustomers (null without paying customers). */
  share: number | null;
}

export interface LtvRow extends LtvGroup {
  /** First day of the cohort (install day, Monday of the install week, or first of the month). */
  cohort: string;
  installs: number;
  payers: number;
  trials: number;
  /** Revenue / proceeds to date (refunds excluded). */
  revenue: number;
  proceeds: number;
  /** D0, D7, D30, D90, D180, then to date (`day: null`). */
  horizons: LtvHorizon[];
}

export interface Ltv {
  currency: string;
  by: LtvDimension;
  cohort: LtvCohortUnit;
  /** Install days covered (inclusive). */
  from: string;
  to: string;
  horizons: number[];
  coverage: LtvCoverage;
  rows: LtvRow[];
  /** With `summary=1`: per group, pooled over the same installs (as `/ltv/summary`). */
  summary?: LtvSummaryRow[];
}

export interface LtvSummaryRow extends LtvGroup {
  installs: number;
  payers: number;
  trials: number;
  /** payers / installs. */
  conversion: number | null;
  revenue: number;
  proceeds: number;
  /** Pooled over the installs old enough for the horizon (`installs`); null values when none is. */
  horizons: (LtvHorizon & { installs: number })[];
}

export interface LtvSummary {
  currency: string;
  by: LtvDimension;
  from: string;
  to: string;
  horizons: number[];
  coverage: LtvCoverage;
  rows: LtvSummaryRow[];
}

// Instance administration (`/admin/*`, instance admins with a web or device session; never API keys) -----------------

export type UserStatus = "active" | "disabled";

/** GET /admin/users */
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  status: UserStatus;
  createdAt: number;
  lastLoginAt: number | null;
  workspaces: { id: string; name: string; role: Role }[];
}

/** GET /admin/workspaces */
export interface AdminWorkspace {
  id: string;
  name: string;
  currency: string;
  createdAt: number;
  members: number;
  owners: { id: string; name: string; email: string }[];
  apps: number;
  apiKeys: number;
}

/** GET /admin/invitations: invitations to a workspace, or to a new workspace of the invitee's own. */
export interface AdminInvitation {
  id: string;
  email: string | null;
  /** Role in `workspaceId`; "owner" for a new workspace. */
  role: Role;
  workspaceId: string | null;
  workspaceName: string | null;
  /** Set when the invitee gets a new workspace (workspaceId is null). */
  newWorkspaceName: string | null;
  /** The invitee becomes an instance admin. */
  isAdmin: boolean;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
}

/** GET /admin/usage: database size and the Free plan budget. `database` is null when the instance runs on D1. */
export interface AdminUsage {
  database: { size: number; since: number; rowsRead: number; rowsWritten: number } | null;
  background: { rowsRead: number; rowsWritten: number; readBudget: number; writeBudget: number };
  freePlan: { rowsReadPerDay: number; rowsWrittenPerDay: number; resetsAt: string };
}

/**
 * GET /admin/updates: the daily GitHub release check. `status`: `ok` (checked), `not_found` (the repository is
 * missing or private: GitHub answers 404), `error` (rate limit, network...), `never` (not checked yet), `disabled`
 * (UPDATE_CHECK="false").
 */
/** GET/PATCH /admin/email: Cloudflare Email Sending for sign-in links. */
export interface AdminEmailSettings {
  /** The EMAIL binding and EMAIL_FROM exist. */
  configured: boolean;
  from: string | null;
  /** Sign-in links by email are turned on (only possible when configured). */
  enabled: boolean;
}

export interface UpdateStatus {
  current: string;
  commit: string;
  latest: string | null;
  updateAvailable: boolean;
  url: string | null;
  publishedAt: number | null;
  checkedAt: number | null;
  status: "ok" | "not_found" | "error" | "never" | "disabled";
  /** Human-readable note for not_found / error. */
  message: string | null;
  enabled: boolean;
  repo: string;
}

/** GET /admin/overview. Counts come from small tables and the daily rollups (never from `transactions`). */
export interface AdminOverview {
  generatedAt: number;
  counts: {
    users: number;
    activeUsers: number;
    disabledUsers: number;
    admins: number;
    /** Users with a web / iOS session or an API key used in the last 30 days. */
    activeLast30d: number;
    workspaces: number;
    apps: number;
    archivedApps: number;
    apiKeys: number;
    devices: number;
  };
  /** From the daily rollups (`workspace_daily`): purchases = new subscriptions + renewals + one-time purchases. */
  sales: { purchases: number; purchases30d: number; revenue30dUsd: number; firstDay: string | null };
  recentSignups: { id: string; name: string; email: string; createdAt: number }[];
  recentLogins: { id: string; name: string; email: string; lastLoginAt: number }[];
  jobs: {
    queued: number;
    running: number;
    /** Failed in the last 7 days. */
    failed7d: number;
    recentFailed: { id: string; kind: string; workspaceId: string; workspaceName: string | null; error: string | null; at: number }[];
  };
  alerts: { open: number };
  /** Last cron tick (every 5 minutes); `stale` when none ran in the last 15 minutes. */
  cron: { lastRunAt: number | null; durationMs: number | null; stale: boolean };
  usage: AdminUsage;
  version: { version: string; commit: string; apiVersion: number };
  update: UpdateStatus;
}

// Integrations ------------------------------------------------------------------------------------------------------

/** Meta Ads event types (from the ledger's transaction kinds: trial, new, conversion, renewal, one_time). */
export type MetaEventType = "trial_started" | "initial_purchase" | "trial_converted" | "renewal" | "non_subscription_purchase";

/** Meta Ads integration of an app (GET/PUT /apps/:id/integrations/meta): purchases go to Meta's Conversions API as app events. */
export interface MetaIntegration {
  enabled: boolean;
  datasetId: string | null;
  /** The access token is write-only. */
  accessTokenSet: boolean;
  testEventCode: string | null;
  /** Also send Sandbox transactions (default off). */
  sendSandbox: boolean;
  /** Also send installs whose ATT status is not authorized (default off). */
  sendWithoutAtt: boolean;
  events: Record<MetaEventType, { enabled: boolean; name: string; defaultName: string }>;
  stats: { pending: number; sent: number; skipped: number; failed: number };
  lastSentAt: number | null;
  lastError: string | null;
  /** When the last 7 days were queued (first enable or POST .../backfill). */
  backfilledAt: number | null;
}

/** PUT /apps/:id/integrations/meta body: every field optional; "" or null clears datasetId / accessToken / testEventCode; name null = default. */
export interface MetaIntegrationUpdate {
  enabled?: boolean;
  datasetId?: string | null;
  accessToken?: string | null;
  testEventCode?: string | null;
  sendSandbox?: boolean;
  sendWithoutAtt?: boolean;
  events?: Partial<Record<MetaEventType, { enabled?: boolean; name?: string | null }>>;
}

/** One row of the delivery log (last 100 per app, newest first). */
export interface MetaDelivery {
  id: number;
  at: number;
  transactionId: string;
  eventType: MetaEventType | null;
  eventName: string | null;
  eventId: string | null;
  status: "sent" | "skipped" | "failed";
  /** Meta's HTTP status (0 = network error); null for skipped events. */
  httpStatus: number | null;
  /** Meta's response, trimmed (includes fbtrace_id). */
  response: string | null;
  /** Why it was skipped or failed. */
  reason: string | null;
}

/** What Revflare tells Apple it prefers for a refund request (Send Consumption Information's refundPreference). */
export type RefundPolicy = "none" | "decline" | "decline_if_delivered_after_days" | "grant_prorated" | "grant_full";

/** Refund requests of an app (GET/PUT /apps/:id/integrations/refunds): answers to Apple's CONSUMPTION_REQUEST notifications. */
export interface RefundRequestSettings {
  /** Where the settings come from: the app's own, the workspace defaults (GET /integrations/refunds/defaults), or none (off). */
  source?: "app" | "workspace" | "none";
  /** Answer Apple's refund requests (default off; needs `consentAttested`). */
  enabled: boolean;
  /** The developer confirmed they obtained their customers' consent to share consumption data with Apple. */
  consentAttested: boolean;
  consentAttestedAt: number | null;
  /** Who confirmed it (name and email). */
  consentAttestedBy: string | null;
  /** none: no preference sent (default); decline: DECLINE (content delivered) at any age; decline_if_delivered_after_days: DECLINE when the purchase (or the subscription) is at least `declineAfterDays` days old; grant_prorated / grant_full. */
  refundPolicy: RefundPolicy;
  declineAfterDays: number | null;
  /** Sent as sampleContentProvided: a free trial / sample or a description of the content was offered before purchase. */
  sampleContentProvided: boolean;
  /** Optional consumed percentage (0-100) sent for consumables, non-consumables and non-renewing subscriptions; null = not sent. Never sent for auto-renewable subscriptions. */
  consumptionPercent: number | null;
  /** Always DELIVERED: Revflare cannot know about delivery problems. */
  deliveryStatus: "DELIVERED";
  /** Where the app's notifications go. Revflare answers requests that reach its URL (also when it forwards them) and, for apps whose URL is another server's, requests polled from Notification History inside Apple's 12 hours. */
  notifications: { status: "revflare" | "other" | "unknown" | string; forwarded: boolean; lastNotificationAt: number | null };
  stats: { pending: number; sent: number; skipped: number; failed: number; expired: number };
  lastSentAt: number | null;
  lastError: string | null;
}

/** Workspace defaults for refund requests (GET/PUT /integrations/refunds/defaults): apps without their own settings use them. */
export interface RefundRequestDefaults {
  enabled: boolean;
  consentAttested: boolean;
  consentAttestedAt: number | null;
  consentAttestedBy: string | null;
  refundPolicy: RefundPolicy;
  declineAfterDays: number | null;
  sampleContentProvided: boolean;
  consumptionPercent: number | null;
  /** App Store apps (not archived), and those without their own settings (the defaults apply to them). */
  apps: { total: number; usingDefaults: number };
}

/** PUT /apps/:id/integrations/refunds body (every field optional; PUT /integrations/refunds/defaults takes the same fields but useDefaults). */
export interface RefundRequestSettingsUpdate {
  /** App only: drop the app's own settings, the workspace defaults apply again. */
  useDefaults?: boolean;
  enabled?: boolean;
  /** true records who confirmed it and when; false withdraws it (and turns answers off). */
  consentAttested?: boolean;
  refundPolicy?: RefundPolicy;
  /** 1-3650, required with decline_if_delivered_after_days. */
  declineAfterDays?: number | null;
  sampleContentProvided?: boolean;
  consumptionPercent?: number | null;
}

/** One refund request (GET /apps/:id/integrations/refunds/log: the last 100, newest first). */
export interface RefundRequestLogItem {
  id: number;
  receivedAt: number;
  /** Apple's deadline (received + 12 h). */
  dueAt: number;
  transactionId: string;
  originalTransactionId: string | null;
  productId: string | null;
  productName: string | null;
  environment: string;
  /** Apple's consumptionRequestReason (e.g. UNINTENDED_PURCHASE, FULFILLMENT_ISSUE, UNSATISFIED_WITH_PURCHASE, LEGAL, OTHER). */
  requestReason: string | null;
  status: "pending" | "sent" | "skipped" | "failed" | "expired";
  attempts: number;
  /** The ConsumptionRequest body sent (or about to be sent). */
  request: Record<string, unknown> | null;
  /** Apple's HTTP status (202 = accepted, 0 = network error). */
  httpStatus: number | null;
  /** Apple's answer, trimmed. */
  response: string | null;
  /** Why it was skipped, failed or expired (or the last retry error while pending). */
  reason: string | null;
  updatedAt: number;
}

// Offerings (paywalls) ---------------------------------------------------------------------------------------------

/** Identifiers of offerings, packages and placements. */
export const OFFERING_IDENTIFIER_RE = /^[A-Za-z0-9_.$-]{1,64}$/;
/** Suggested package identifiers (any other identifier is fine too). */
export const PACKAGE_PRESETS = ["$weekly", "$monthly", "$two_month", "$three_month", "$six_month", "$annual", "$lifetime"] as const;
/** Per app: offerings, packages per offering, placements, bytes of each metadata JSON, bytes of the whole config. */
export const OFFERING_LIMITS = { offerings: 50, packages: 20, placements: 50, metadataBytes: 8192, configBytes: 512 * 1024 } as const;

/** One product of an offering. productId: the App Store product id. */
export interface OfferingPackage {
  identifier: string;
  productId: string;
  /** Free-form JSON object for the paywall (≤ 8 KB). */
  metadata: Record<string, unknown>;
}

export interface Offering {
  identifier: string;
  displayName: string;
  /** Free-form JSON object for the paywall (≤ 8 KB). */
  metadata: Record<string, unknown>;
  /** In display order. */
  packages: OfferingPackage[];
  isCurrent: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A paywall location in the app. offeringId null: the current offering. */
export interface Placement {
  identifier: string;
  offeringId: string | null;
}

/** What GET /sdk/v1/offerings returns to RevflareKit (also `preview` of the management endpoints). */
export interface SdkOfferings {
  /** Short hash of the config: changes on every edit (ETag). */
  version: string;
  currentOfferingId: string | null;
  offerings: { identifier: string; displayName: string; metadata: Record<string, unknown>; packages: OfferingPackage[] }[];
  /** Placement → offering identifier, null = the current offering. */
  placements: Record<string, string | null>;
  /**
   * Server-driven entitlements (RevflareKit 1.9+): entitlement → product ids, merged with the app's own map (union).
   * Omitted when none are set (older SDKs ignore it).
   */
  entitlements?: Record<string, string[]>;
  /** Product settings (RevflareKit 1.9+): the duration of non-renewing products. Omitted when none are set. */
  products?: Record<string, { duration: ProductDuration }>;
}

// Entitlements and non-renewing durations ------------------------------------------------------------------------

export const DURATION_UNITS = ["day", "week", "month", "year"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];
/** How long a non-renewing product (a pass) lasts after its purchase: `count` × `unit` (UTC calendar, months clamp to the month's last day). */
export interface ProductDuration {
  unit: DurationUnit;
  count: number;
}
/** Per app: entitlements, product ids per entitlement, products with a duration, the largest count. */
export const ENTITLEMENT_LIMITS = { entitlements: 50, productsPerEntitlement: 100, durations: 100, maxCount: 1000 } as const;

export interface EntitlementEntry {
  identifier: string;
  /** Sorted. */
  productIds: string[];
}

export interface NonRenewingDuration extends ProductDuration {
  productId: string;
}

/** GET /apps/:id/entitlements (and every change, with `warnings`). */
export interface EntitlementsConfig {
  /** Sorted by identifier. */
  entitlements: EntitlementEntry[];
  /** Sorted by product id. */
  durations: NonRenewingDuration[];
  /** Last change (null: never configured). */
  updatedAt: number | null;
  /** What RevflareKit gets, inside GET /sdk/v1/offerings. */
  preview: { entitlements?: Record<string, string[]>; products?: Record<string, { duration: ProductDuration }> };
}

export interface EntitlementsChange extends EntitlementsConfig {
  warnings: string[];
  /** Stored transactions whose expiry was recomputed after a duration change. */
  updatedTransactions: number;
  /**
   * True when a month / year duration change touched more than 5,000 stored transactions: the first 5,000 were
   * recomputed now, the rest continue in the background (cron, within the daily budget).
   */
  truncated: boolean;
}

/**
 * PUT /apps/:id/entitlements body (replaces both parts that are present). Entitlements as a map { pro: [ids] } or a
 * list [{ identifier, productIds }]; durations as a map { productId: { unit, count } | "3d" } or a list [{ productId, unit, count }].
 */
export interface EntitlementsInput {
  entitlements?: Record<string, string[]> | { identifier: string; productIds: string[] }[];
  durations?: Record<string, ProductDuration | string> | NonRenewingDuration[];
}

/** GET /apps/:id/offerings (and every change, with `warnings`). */
export interface OfferingsConfig {
  currentOfferingId: string | null;
  /** In display order. */
  offerings: Offering[];
  placements: Placement[];
  version: string;
  /** Last change (null: never configured). */
  updatedAt: number | null;
  /** The exact JSON RevflareKit gets. */
  preview: SdkOfferings;
}

/** Response of the changes: the new config plus warnings (e.g. a package's product is not among the app's known products). */
export interface OfferingsChange extends OfferingsConfig {
  warnings: string[];
}

/** An offering as sent to POST /apps/:id/offerings and PUT /apps/:id/offerings. */
export interface OfferingInput {
  identifier: string;
  /** Default: the identifier. */
  displayName?: string;
  metadata?: Record<string, unknown> | null;
  packages?: { identifier: string; productId: string; metadata?: Record<string, unknown> | null }[];
  /** POST / PATCH: make it the current offering (true) or stop it being current (false). */
  isCurrent?: boolean;
}

/** PUT /apps/:id/offerings body (the whole config; `revflare offerings <app> apply`). Placements as a list or a map. */
export interface OfferingsInput {
  currentOfferingId?: string | null;
  offerings: OfferingInput[];
  placements?: Placement[] | Record<string, string | null>;
}

// Remote config (like Firebase Remote Config) ------------------------------------------------------------------------

/** Condition names (Firebase-compatible). */
export const RC_CONDITION_NAME_RE = /^[A-Za-z0-9_ .-]{1,64}$/;
/** Parameter keys. */
export const RC_PARAMETER_KEY_RE = /^[A-Za-z0-9_.-]{1,128}$/;
/** Per app: parameters, conditions, rules per condition, values per list rule, bytes of each value, bytes of the whole config. */
export const RC_LIMITS = { parameters: 300, conditions: 50, rulesPerCondition: 20, valuesPerRule: 300, valueBytes: 32 * 1024, configBytes: 512 * 1024 } as const;
export const RC_VALUE_TYPES = ["string", "number", "boolean", "json"] as const;
export type RemoteConfigValueType = (typeof RC_VALUE_TYPES)[number];
/** Optional UI tag of a condition (Firebase tagColor names, lowercase). */
export const RC_CONDITION_COLORS = ["blue", "brown", "cyan", "deep_orange", "green", "indigo", "lime", "orange", "pink", "purple", "teal"] as const;
export type RemoteConfigConditionColor = (typeof RC_CONDITION_COLORS)[number];
/** Version comparisons (semantic: 2.10 > 2.9; missing parts are 0). */
export const RC_VERSION_OPS = [">=", ">", "<=", "<", "==", "!="] as const;
export type RemoteConfigVersionOp = (typeof RC_VERSION_OPS)[number];

/**
 * One rule of a condition (a condition matches when all its rules match).
 * - country: the device's App Store storefront (sent by RevflareKit), else the request's country (Cloudflare).
 * - ip_country: the request's country (Cloudflare). storefront: only the storefront the SDK sent.
 * - language: the language of the device locale ("zh" matches zh_CN, zh-Hans_CN; "en-US" matches that locale).
 * - locale: the device locale (en_US; "-" and "_" are the same, case-insensitive).
 * - app_version / app_build / os_version / sdk_version: semantic comparison with `value`.
 * - percent: deterministic bucket in [0, 100) from sha256(installId + seed) (seed: the rule's `seed`, else the
 *   condition name); matches when from <= bucket < to. No installId: no match.
 * - install_id: testers (RevflareKit install ids).
 * - source: how the install was acquired (apple_ads | organic | unknown, from RevflareKit's attribution report; a
 *   device that has not been answered yet, e.g. on its first launch, is unknown).
 * - apple_ads_campaign / apple_ads_ad_group / apple_ads_keyword: Apple Ads ids of an attributed install.
 * - environment: the build (production = App Store, sandbox = TestFlight / development, xcode = StoreKit configuration).
 */
export type RemoteConfigRule =
  | { type: "country" | "ip_country" | "storefront" | "language" | "locale" | "install_id"; values: string[] }
  | { type: "source"; values: InstallSource[] }
  | { type: "apple_ads_campaign" | "apple_ads_ad_group" | "apple_ads_keyword"; values: string[] }
  | { type: "environment"; values: SdkEnvironment[] }
  | { type: "app_version" | "app_build" | "os_version" | "sdk_version"; op: RemoteConfigVersionOp; value: string }
  | { type: "percent"; from: number; to: number; seed?: string };
export type RemoteConfigRuleType = RemoteConfigRule["type"];

/** Conditions are ordered: the first matching condition with a value for a parameter wins. */
export interface RemoteConfigCondition {
  name: string;
  color?: RemoteConfigConditionColor | null;
  /** All must match; an empty list always matches. */
  rules: RemoteConfigRule[];
  /** Imported from Firebase with an expression Revflare cannot evaluate: never matches. */
  unsupported?: boolean;
  /** The Firebase expression it was imported from (kept for unsupported conditions). */
  expression?: string;
}

/** A conditional value: a typed value, or { useInAppDefault: true } (the key is omitted: the app's default applies). */
export type RemoteConfigValue = unknown;

export interface RemoteConfigParameter {
  key: string;
  type: RemoteConfigValueType;
  description?: string;
  /** Typed value (absent when useInAppDefault). */
  defaultValue?: unknown;
  /** Omit the key by default (the app's in-app default applies). */
  useInAppDefault?: boolean;
  /** condition name → typed value | { useInAppDefault: true }. */
  conditionalValues: Record<string, RemoteConfigValue>;
}

/** GET /apps/:id/config. */
export interface RemoteConfig {
  /** In priority order. */
  conditions: RemoteConfigCondition[];
  parameters: RemoteConfigParameter[];
  /** Short hash of the config (changes on every edit). */
  version: string;
  /** Last change (null: never configured). */
  updatedAt: number | null;
  /** E.g. unsupported or unused conditions. */
  warnings: string[];
}

/** PUT /apps/:id/config body (the whole config; `revflare config <app> apply`). Parameters as a list or a map key → parameter. */
export interface RemoteConfigInput {
  conditions?: RemoteConfigCondition[];
  parameters?: RemoteConfigParameter[] | Record<string, Omit<RemoteConfigParameter, "key">>;
}

/** POST /apps/:id/config/import-firebase: the converted config (saved unless dryRun) and the import warnings. */
export interface RemoteConfigImport extends RemoteConfig {
  dryRun: boolean;
  merged: boolean;
  imported: { parameters: number; conditions: number; unsupportedConditions: number };
}

/** What GET /sdk/v1/config returns to RevflareKit. */
export interface SdkRemoteConfig {
  /** Short hash of this device's response (ETag): changes only when its values (or matched conditions) change. */
  version: string;
  /** Parameter key → typed value (keys using the in-app default are omitted). */
  values: Record<string, unknown>;
  /** Names of the conditions the device matches, in priority order. */
  conditions: string[];
  /** The country used for `country` rules (storefront, else the request's), null if unknown. */
  country: string | null;
  /** The experiments the device is enrolled in (omitted when none): its variant and the parameter keys it overrides. */
  experiments?: SdkExperimentAssignment[];
}

/** An experiment assignment in GET /sdk/v1/config (RevflareKit logs `experiment_exposure` with these). */
export interface SdkExperimentAssignment {
  id: string;
  variant: string;
  keys: string[];
}

/** POST /apps/:id/config/evaluate body ("preview as"). */
export interface RemoteConfigEvaluateInput {
  installId?: string;
  appVersion?: string;
  appBuild?: string;
  osVersion?: string;
  locale?: string;
  storefront?: string;
  ipCountry?: string;
  sdkVersion?: string;
  source?: InstallSource;
  /** Apple Ads ids (digits). */
  campaign?: string;
  adGroup?: string;
  keyword?: string;
  environment?: SdkEnvironment;
}

/** GET /apps/:id/config/attribution-options: Apple Ads ids seen in the app's installs (last `days` days), for condition pickers. */
export interface AttributionOptions {
  appId: string;
  days: number;
  /** Install counts per id (production installs Apple attributed); `name` when known (null otherwise). */
  campaigns: { id: string; name: string | null; installs: number }[];
  adGroups: { id: string; campaignId: string | null; name: string | null; installs: number }[];
  keywords: { id: string; campaignId: string | null; adGroupId: string | null; name: string | null; installs: number }[];
}

/** POST /apps/:id/config/evaluate: the SDK payload plus where each parameter's value came from. */
export interface RemoteConfigEvaluation extends SdkRemoteConfig {
  /** `experiment` / `variant`: the value comes from an experiment's variant (condition is then null). */
  parameters: Record<string, { condition: string | null; useInAppDefault: boolean; value?: unknown; experiment?: string; variant?: string }>;
}

// Experiments (A/B tests on remote config parameters, docs/experiments.md) ---------------------------------------

export const EXPERIMENT_METRICS = ["trial_started", "paid", "revenue_per_install"] as const;
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];
/** draft → running → stopped → rolled_out; archived from draft, running or stopped. */
export const EXPERIMENT_STATUSES = ["draft", "running", "stopped", "rolled_out", "archived"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
/**
 * Variants (2 to 5, ids a..e, "a" = control), parameter keys per experiment, experiments per app, days an experiment
 * runs at most (then stopped by the cron), and the guardrails before results are shown: days running, exposed installs
 * per variant, conversions on the primary metric in total; installs read per experiment (Analytics Engine, spread
 * evenly over the variants).
 */
export const EXPERIMENT_LIMITS = {
  minVariants: 2,
  maxVariants: 5,
  maxKeys: 10,
  perApp: 100,
  maxDays: 90,
  minDays: 7,
  minExposed: 100,
  minConversions: 10,
  installCap: 20_000,
} as const;
/** The event RevflareKit sends when the app reads an experiment's parameter: props { experiment: id, variant: "<id>:<variant>" }. */
export const EXPERIMENT_EXPOSURE_EVENT = "experiment_exposure";

export interface ExperimentVariant {
  /** a, b, c... in order; "a" is the control. */
  id: string;
  name: string;
  /** Share of enrolled devices (all variants sum to 100). */
  weight: number;
  /** Parameter key → typed value. The control may leave keys out (devices keep the values they would get anyway). */
  values: Record<string, unknown>;
}

export interface Experiment {
  id: string;
  appId: string;
  name: string;
  hypothesis: string | null;
  /** Remote config parameters the variants set (one active experiment per parameter). */
  keys: string[];
  variants: ExperimentVariant[];
  /** Name of a remote config condition: only devices matching it enroll (null: every device with an install id). */
  targeting: string | null;
  /** Percent of the matching devices enrolled (1 to 100). */
  traffic: number;
  primaryMetric: ExperimentMetric;
  status: ExperimentStatus;
  startedAt: number | null;
  stoppedAt: number | null;
  /** Running experiments are stopped by the cron at this time (startedAt + 90 days). */
  endsAt: number | null;
  rolledOutVariant: string | null;
  createdAt: number;
  updatedAt: number;
}

/** POST /apps/:id/experiments, PATCH (draft only, partial). Weights may be left out on every variant (even split). */
export interface ExperimentInput {
  name?: string;
  hypothesis?: string | null;
  keys?: string[];
  variants?: { id?: string; name?: string; weight?: number; values?: Record<string, unknown> }[];
  targeting?: string | null;
  traffic?: number;
  primaryMetric?: ExperimentMetric;
}

/** Posterior of a rate's lift against the control: mean and 95% credible interval (relative, 0.1 = +10%). */
export interface ExperimentLift {
  expected: number;
  low: number;
  high: number;
}

export interface ExperimentVariantResult {
  variant: string;
  name: string;
  weight: number;
  /** Unique installs that sent experiment_exposure for this variant since the start. */
  exposed: number;
  /** Exposed installs that started a trial after their first exposure. */
  trials: number;
  trialRate: number | null;
  /** Exposed installs with a paid transaction (not fully refunded) after their first exposure. */
  paid: number;
  paidRate: number | null;
  /** Paid after the first exposure, refunds subtracted, in `currency`. */
  revenue: number;
  proceeds: number;
  revenuePerInstall: number | null;
  proceedsPerInstall: number | null;
  /** Probability to be the best variant (Beta posteriors, Monte Carlo); null without exposed installs. */
  probabilityBest: { trial_started: number | null; paid: number | null };
  /** Against the control (null for the control). */
  lift: { trial_started: ExperimentLift | null; paid: ExperimentLift | null };
}

/** GET /apps/:id/experiments/:eid/results. */
export interface ExperimentResults {
  experimentId: string;
  status: ExperimentStatus;
  primaryMetric: ExperimentMetric;
  currency: string;
  /** Window: the start to the stop (or now). */
  from: number | null;
  to: number | null;
  daysRunning: number;
  variants: ExperimentVariantResult[];
  /** Guardrails met (days, exposed per variant, conversions): only then are probabilities meant to be read. */
  enoughData: boolean;
  /** Why there is not enough data yet. */
  reasons: string[];
  /** P(best) ≥ 95% on the primary metric (trial_started / paid) with the guardrails met. */
  confident: { variant: string; probability: number } | null;
  /** events: install lists from Analytics Engine; snapshot: daily counts only (no conversions). */
  exposureSource: "events" | "snapshot" | "none";
  /** Analytics Engine sampled the events or an install list hit the cap. */
  approximate: boolean;
  notes: string[];
  /** Daily exposed installs per variant (cron snapshot, UTC days). */
  daily: { day: string; variant: string; exposed: number }[];
  /** Computed after the stop: final. */
  frozen: boolean;
  generatedAt: number;
}

// Events and funnels (RevflareKit app events in Workers Analytics Engine) ---------------------------------------

/** Event names: letters, digits, _ . : - (1 to 64 characters). */
export const EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Event property keys: letters, digits, _ . - (1 to 40 characters). */
export const EVENT_PROP_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;
/** POST /sdk/v1/events limits. */
export const EVENT_LIMITS = { eventsPerRequest: 200, propsPerEvent: 10, propValueChars: 100, maxAgeMs: 7 * 86_400_000, maxFutureMs: 3_600_000 } as const;
/** Properties stored in their own column (fast filters and funnel breakdowns); others stay in the props JSON. */
export const PROMOTED_PROPS = ["placement", "offering", "product", "step", "screen", "variant"] as const;
export type PromotedProp = (typeof PROMOTED_PROPS)[number];
/** Funnel breakdowns: by the install's app version, OS version, country or locale at the first step, or a promoted property of the first step. */
export const FUNNEL_BREAKDOWNS = ["app_version", "os_version", "country", "locale", ...PROMOTED_PROPS] as const;
export type FunnelBreakdown = (typeof FUNNEL_BREAKDOWNS)[number];
/** Funnel limits: steps, property filters per step, funnels per app, conversion window (seconds). */
export const FUNNEL_LIMITS = { minSteps: 2, maxSteps: 10, filtersPerStep: 5, funnelsPerApp: 50, minWindowSeconds: 60, maxWindowSeconds: 90 * 86_400 } as const;
/** Filter values (WAE SQL has no bind parameters: values are restricted to this alphabet). */
export const FUNNEL_FILTER_VALUE_RE = /^[A-Za-z0-9 _.:@\/+,#-]{0,100}$/;

/**
 * Key events: stored exactly in the database besides Analytics Engine (which samples), so funnels, experiment exposures,
 * insights and the events page count them exactly (docs/funnels.md#exact-key-events). Built in (case-insensitive):
 * first_open, purchase_*, restore_*, paywall_view, paywall_close, onboarding_*, experiment_exposure; each app can add
 * up to 20 patterns (exact names, or a single leading or trailing `*`).
 */
export const BUILTIN_KEY_EVENTS = ["first_open", "purchase_*", "restore_*", "paywall_view", "paywall_close", "onboarding_*", "experiment_exposure"] as const;
/** An extra key-event pattern: an event name, optionally with one `*` at its start or end (`*_paywall_view`, `promo_*`). */
export const KEY_EVENT_PATTERN_RE = /^(\*[A-Za-z0-9_.:-]{1,63}|[A-Za-z0-9_.:-]{1,63}\*?)$/;
/**
 * Key events limits: extra patterns per app, daily cap per app (default upper bound: the server's default is
 * min(defaultDailyCap, background writes a day / 3 / 2), see KeyEventSettings.defaultDailyCap; max), retention days
 * (default, min, max), per install and day (anti-abuse, approximate).
 */
export const KEY_EVENT_LIMITS = { patterns: 20, defaultDailyCap: 50_000, maxDailyCap: 1_000_000, defaultRetentionDays: 180, minRetentionDays: 7, maxRetentionDays: 365, perInstallPerDay: 500 } as const;
/** Where counts come from: "exact" (key events stored in the database) or "sampled" (Analytics Engine). */
export type EventSource = "exact" | "sampled";

/** GET / PUT /apps/:id/key-events (PUT body: { patterns?, dailyCap? (null: the default), retentionDays? }). */
export interface KeyEventSettings {
  appId: string;
  /** Built-in key events (BUILTIN_KEY_EVENTS). */
  builtin: string[];
  /** The app's extra patterns. */
  patterns: string[];
  /** Key events stored per UTC day at most, in effect (0: none stored); over it, Analytics Engine only and a key_events_capped alert. */
  dailyCap: number;
  /** dailyCap is the instance's default (not set for the app). */
  dailyCapIsDefault: boolean;
  /** The instance's default daily cap: min(50,000, backgroundWritesPerDay / writesPerEvent / 2). */
  defaultDailyCap: number;
  /** The instance's daily background write budget (rows; BACKGROUND_WRITES_PER_DAY, 55,000 by default for the Free plan). */
  backgroundWritesPerDay: number;
  /** Rows written per stored key event (the row and its two index entries). */
  writesPerEvent: number;
  /** Stored key events are deleted after this many days. */
  retentionDays: number;
  /** First UTC day whose key events are all stored (exact reads start there); null: none stored yet. */
  since: string | null;
  /** Today (UTC): key events stored and whether the day is incomplete (cap or background budget reached, or a failed write). */
  today: { date: string; count: number; capped: boolean };
  limits: { patterns: number; maxDailyCap: number; minRetentionDays: number; maxRetentionDays: number; perInstallPerDay: number };
}

/** Equality on an event property (a promoted property's column, or the props JSON for the others). */
export interface FunnelPropFilter {
  key: string;
  value: string;
}

export type RevenueStepKind = "trial_started" | "paid" | "any_purchase";

export type FunnelStep =
  | { type: "event"; name: string; filters?: FunnelPropFilter[]; label?: string }
  /** From Revflare's own transactions of the install (install_links / appAccountToken): never the first step. */
  | { type: "revenue"; kind: RevenueStepKind; label?: string };

export interface Funnel {
  id: string;
  appId: string;
  name: string;
  steps: FunnelStep[];
  /** Each step must happen within this many seconds of the first step (ordered: also after the previous step). */
  windowSeconds: number;
  /** true: steps must happen in order. false: steps 2..n in any order after step 1. */
  ordered: boolean;
  /** Funnel anomaly and release regression alerts (docs/funnels.md#alerts). */
  alerts: FunnelAlertSettings;
  createdAt: number;
  updatedAt: number;
}

/** Alert sensitivity: the relative drop that raises an alert (high 15 %, normal 20 %, low 30 %; event silence 3 / 6 / 12 hours). */
export const FUNNEL_ALERT_SENSITIVITIES = ["high", "normal", "low"] as const;
export type FunnelAlertSensitivity = (typeof FUNNEL_ALERT_SENSITIVITIES)[number];

export interface FunnelAlertSettings {
  enabled: boolean;
  sensitivity: FunnelAlertSensitivity;
}

/** POST /apps/:id/funnels and PATCH (partial). window: "1h", "1d", "7d", "30d", ... or windowSeconds. */
export interface FunnelInput {
  name?: string;
  steps?: FunnelStep[];
  window?: string;
  windowSeconds?: number;
  ordered?: boolean;
  /** Partial: { enabled?, sensitivity? }. */
  alerts?: Partial<FunnelAlertSettings>;
}

export interface FunnelReportStep {
  index: number;
  label: string;
  /** Installs that reached this step. */
  users: number;
  /** Fraction (0..1) of the previous step's users; 1 for the first step. */
  conversionFromPrevious: number;
  /** Fraction (0..1) of the first step's users. */
  conversionFromFirst: number;
  /** Users of the previous step who did not reach this one (0 for the first step). */
  dropOff: number;
  /** Median seconds from the previous step (ordered funnels) or from the first step (unordered); null when nobody converted. */
  medianSecondsFromPrevious: number | null;
}

/** GET /apps/:id/funnels/:fid/report. */
export interface FunnelReport {
  funnel: Funnel;
  /** Entry dates (first step), YYYY-MM-DD inclusive, UTC. */
  from: string;
  to: string;
  breakdown: FunnelBreakdown | null;
  steps: FunnelReportStep[];
  /** Per breakdown value (top 10 by first-step users, the rest as "(other)"). */
  groups: { value: string; steps: FunnelReportStep[] }[];
  /** True when sampled (Analytics Engine `_sample_interval` > 1), capped (too many installs) or partly inferred. */
  approximate: boolean;
  /** exact: every event step came from stored key events; sampled: from Analytics Engine. Missing from older servers. */
  source?: EventSource;
  notes: string[];
  /** Test data counted (`includeTest=true`): sandbox / Xcode builds and the app's test devices. */
  includeTest?: boolean;
  generatedAt: number;
}

/** GET /apps/:id/events/summary. Counts are weighted by the sample interval; uniqueInstalls are exact only when not sampled. */
export interface EventSummary {
  appId: string;
  from: string;
  to: string;
  days: number;
  totalEvents: number;
  uniqueInstalls: number;
  /** Top events (by count). */
  /** source: exact (stored key event) or sampled (Analytics Engine); both counted by UTC day of reception; missing from older servers. */
  events: { name: string; count: number; installs: number; lastSeenAt: number | null; source?: EventSource }[];
  /** Per UTC day: total count and counts of the top events (others summed into "(other)"). */
  daily: { date: string; count: number; byEvent: Record<string, number> }[];
  approximate: boolean;
  /** Test data counted (`includeTest=true`): sandbox / Xcode builds and the app's test devices. */
  includeTest?: boolean;
  /** Why some counts are not exact (exact key events not usable for the range, daily breakdown truncated...); missing from older servers. */
  notes?: string[];
  generatedAt: number;
}

/** GET /apps/:id/analytics/status. */
export interface AnalyticsStatus {
  /** The EVENTS Analytics Engine binding is configured (events are stored). */
  ingest: boolean;
  /** CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are set (events can be queried). */
  query: boolean;
  dataset: string;
  /** What is missing, in words (empty when all is set). */
  missing: string[];
  /** Last time this app sent production events (noted at most every few minutes, not per event); null: never / not yet noted. */
  lastEventAt: number | null;
  /** Same for test builds (sandbox / Xcode events). */
  lastTestEventAt: number | null;
  sdkKey: string | null;
}

// Promotional offers (docs/offers.md) ---------------------------------------------------------------------------------

/** Apple offerType of a transaction: 1 introductory, 2 promotional, 3 offer code, 4 win-back. */
export type OfferType = 1 | 2 | 3 | 4;

export const OFFER_TYPE_LABELS: Record<number, string> = { 1: "Introductory", 2: "Promotional", 3: "Offer code", 4: "Win-back" };

/** promotional: signed by POST /sdk/v1/offers/sign. win_back: needs no signature, listed only to label redemptions. */
export type OfferKind = "promotional" | "win_back";

/** One allowlisted offer of an app. */
export interface OfferEntry {
  productId: string;
  /** The offer identifier set up in App Store Connect (promotional: "Offer Identifier"; win-back: the offer id). */
  offerId: string;
  label: string | null;
  kind: OfferKind;
}

export const OFFER_LIMITS = { offers: 200, labelLength: 100 } as const;

/** GET / PUT /apps/:id/offers. */
export interface OfferSettings {
  appId: string;
  offers: OfferEntry[];
  /** Sign only for installs linked to a subscription of the product's group (any subscription of the app when unknown). */
  strict: boolean;
  /** An In-App Purchase key (credential appstore_iap) is set up: needed to sign. */
  keyConfigured: boolean;
  /** The app has a bundle id: needed to sign. */
  bundleId: string | null;
  sdkKey: string | null;
  updatedAt: number | null;
}

/** PUT /apps/:id/offers body (partial: omitted fields are kept). */
export interface OfferSettingsUpdate {
  offers?: { productId: string; offerId: string; label?: string | null; kind?: OfferKind }[];
  strict?: boolean;
}

/** POST /apps/:id/offers/import: offers found in App Store Connect, merged into the allowlist. */
export interface OfferImportResult {
  added: number;
  found: number;
  settings: OfferSettings;
  errors: string[];
}

export type OfferSignatureStatus = "signed" | "not_allowed" | "not_configured" | "not_subscribed";

/** GET /apps/:id/offers/log: the last signature requests (newest first, ~1000 kept per app). */
export interface OfferSignatureLogItem {
  at: number;
  installId: string;
  productId: string;
  offerId: string;
  status: OfferSignatureStatus;
  /** Answers this row stands for: 1, more for sampled refusals (after the first 20 an hour, 1 in 50 is kept). */
  count: number;
  /** The build that asked (null: logged before RevflareKit sent it). */
  environment?: SdkEnvironment | null;
}

/** POST /sdk/v1/offers/sign answer (RevflareKit). signature: legacy (SKPaymentDiscount / Product.PurchaseOption.promotionalOffer); jws: iOS 18.4+. */
export interface OfferSignature {
  productId: string;
  offerId: string;
  keyId: string;
  /** Lowercase UUID. */
  nonce: string;
  /** Milliseconds. */
  timestamp: number;
  /** Base64 DER ECDSA P-256 SHA-256 signature. */
  signature: string;
  /** Compact JWS (aud "promotional-offer"). */
  jws: string;
}

/** A lapsed subscription: expired in the window without auto-renew (grace / billing retry excluded). */
export interface LapsedSubscriber {
  customerId: string | null;
  originalTransactionId: string;
  productId: string;
  productName: string | null;
  expiredAt: number;
  country: string | null;
  /** Customer's total paid (revenue), in the response currency. */
  totalPaid: number;
}

/** GET /apps/:id/lapsed?days=90. */
export interface LapsedSegment {
  appId: string;
  days: number;
  from: number;
  to: number;
  currency: string;
  total: number;
  byProduct: { productId: string; productName: string | null; count: number }[];
  /** Most recently expired first, at most `limit` (200). */
  items: LapsedSubscriber[];
}

/** GET /apps/:id/offers/stats?range=90d: promotional (2) and win-back (4) redemptions per offer. */
export interface OfferStats {
  appId: string;
  from: string;
  to: string;
  currency: string;
  totals: { redemptions: number; revenue: number; proceeds: number };
  items: {
    offerType: 2 | 4;
    offerTypeLabel: string;
    offerId: string | null;
    productId: string;
    label: string | null;
    redemptions: number;
    customers: number;
    revenue: number;
    proceeds: number;
  }[];
}
