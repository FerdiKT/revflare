// Typed client for the REST API v1 (docs/api.md). Errors are `{ error }` with a 4xx/5xx status → ApiError.
import type {
  AdsAttribution,
  AdsName,
  AdsNames,
  AdsNamesUpdate,
  Acquisition,
  AcquisitionCampaign,
  AcquisitionDimension,
  AcquisitionStatus,
  AdminEmailSettings,
  AdminInvitation,
  AdminOverview,
  AdminUsage,
  AdminUser,
  AdminWorkspace,
  Alert,
  ApiKey,
  App,
  AtRisk,
  AttributedRevenue,
  AuthStatus,
  Breakdown,
  Chart,
  Cohorts,
  CredentialView,
  Customer,
  Device,
  Forecast,
  GoalInput,
  GoalProgress,
  Interval,
  Job,
  Ltv,
  LtvCohortUnit,
  LtvDimension,
  LtvSummary,
  Me,
  Member,
  MetaDelivery,
  MetaIntegration,
  MetaIntegrationUpdate,
  RefundRequestLogItem,
  LapsedSegment,
  OfferImportResult,
  OfferSettings,
  OfferSettingsUpdate,
  OfferSignatureLogItem,
  OfferStats,
  RefundRequestSettings,
  RefundRequestSettingsUpdate,
  Metric,
  MrrMovement,
  OfferingInput,
  AnalyticsStatus,
  AttributionOptions,
  EventSummary,
  TestDevices,
  KeyEventSettings,
  Experiment,
  ExperimentInput,
  ExperimentResults,
  Funnel,
  GooglePlaySettings,
  PolarSettings,
  FunnelInput,
  FunnelReport,
  OfferingsChange,
  EntitlementsChange,
  EntitlementsConfig,
  EntitlementsInput,
  ProductDuration,
  OfferingsConfig,
  OfferingsInput,
  RemoteConfig,
  RemoteConfigEvaluateInput,
  RemoteConfigEvaluation,
  RemoteConfigImport,
  RemoteConfigInput,
  Overview,
  Page,
  PairingCode,
  Product,
  ReconciliationRow,
  Role,
  Transaction,
  TransactionKind,
  UpdateStatus,
  UserStatus,
  WebLoginPoll,
  WebLoginStart,
} from "@shared/types";
import { reportQuota } from "./quota";

export class ApiError extends Error {
  status: number;
  /** Machine-readable reason: `quota` (503, daily database limit reached), `budget` (429, import budget used up). */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The Workers Free plan's daily database limit was hit: every request fails until 00:00 UTC. */
export function isQuotaError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "quota";
}

export type { AdminUsage };

/** What an invitation link is for (GET /auth/invitations/:token). */
export interface InvitationInfo {
  email: string | null;
  role: Role;
  workspaceName: string | null;
  newWorkspace: boolean;
  newWorkspaceName: string | null;
  isAdmin: boolean;
}

export interface Invitation {
  id: string;
  email: string | null;
  role: Role;
  createdAt: number;
  expiresAt: number;
  /** Name of the member who created it. */
  createdBy: string | null;
}

/** Fired when the session is gone; the app shell listens and shows the sign-in screen. */
export const UNAUTHORIZED_EVENT = "revflare:unauthorized";

let workspaceId: string | null = null;
export function setApiWorkspace(id: string | null) {
  workspaceId = id;
}

export async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: "same-origin",
      headers: { ...(workspaceId ? { "x-workspace-id": workspaceId } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...init,
    });
  } catch {
    throw new ApiError("Cannot reach the server. Check your connection.", 0);
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const { error: msg, code } = (data ?? {}) as { error?: string; code?: string };
    if (res.status === 503 && code === "quota") reportQuota();
    throw new ApiError(msg || `Request failed (${res.status})`, res.status, code);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const del = <T = { ok: true }>(path: string) => request<T>("DELETE", path);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function qs(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Global filters: apps and a range preset or custom from/to. */
export interface Scope {
  apps?: string[];
  range?: string;
  from?: string;
  to?: string;
}

export interface ReconciliationResponse {
  currency: string;
  from: string;
  to: string;
  reportedDays: string[];
  rows: ReconciliationRow[];
}

export interface TransactionQuery {
  apps?: string[];
  limit?: number;
  cursor?: string | null;
  kinds?: TransactionKind[];
  country?: string;
  q?: string;
  refunded?: boolean;
  environment?: "Production" | "Sandbox" | "all";
  /** Acquisition of the purchase's install. */
  source?: AdsAttribution["source"];
  /** Bought within 5 minutes of the install, or cancelled within 5 minutes of the purchase. */
  quick?: boolean;
  /** The cancellations stream (auto-renew turned off) instead of the sales. */
  cancellations?: boolean;
}

export interface AcquisitionRequestsResult {
  created: { appId: string; name: string }[];
  existing: { appId: string; name: string }[];
  failed: { appId: string; name: string; error: string }[];
  /** Apps left to request (the call is bounded): call again while > 0. */
  remaining: number;
  error?: string;
}

export interface AcquisitionSyncResult {
  apps: number;
  requests: number;
  instances: number;
  rows: number;
  more: boolean;
  budget?: unknown;
  rateLimited?: boolean;
  errors: { appId: string; error: string }[];
}

export type NewCredential =
  | { kind: "appstore_iap" | "appstore_connect" | "appstore_reports"; name: string; keyId: string; issuerId: string; privateKey: string; vendorNumber?: string }
  | { kind: "revenuecat"; name: string; apiKey: string; projectId: string }
  | { kind: "google_play"; name?: string; serviceAccount: string };

export const api = {
  auth: {
    status: () => get<AuthStatus>("/auth/status"),
    setup: (b: { name: string; email: string; password: string; workspaceName?: string; currency?: string; setupToken?: string }) => post<{ ok: true }>("/auth/setup", b),
    login: (email: string, password: string) => post<{ ok: true }>("/auth/login", { email, password }),
    magicLink: (email: string) => post<{ ok: true }>("/auth/magic-link", { email }),
    verifyMagicLink: (token: string) => post<{ ok: true }>("/auth/magic-link/verify", { token }),
    /** Sign in with the iOS app: a QR request (default) or a push to the account's devices (docs/app-login-spec.md). */
    startAppLogin: (b: { kind: "qr" } | { kind: "push"; email: string }) => post<WebLoginStart>("/auth/app-login", b),
    pollAppLogin: (id: string, secret: string) => request<WebLoginPoll>("GET", `/auth/app-login/${encodeURIComponent(id)}`, undefined, { headers: { "x-login-secret": secret } }),
    cancelAppLogin: (id: string, secret: string) => request<{ ok: true }>("DELETE", `/auth/app-login/${encodeURIComponent(id)}`, undefined, { headers: { "x-login-secret": secret } }),
    logout: () => post<{ ok: true }>("/auth/logout"),
    invitation: (token: string) => get<InvitationInfo>(`/auth/invitations/${encodeURIComponent(token)}`),
    acceptInvitation: (b: { token: string; name?: string; email: string; password: string }) => post<{ ok: true; workspaceId: string }>("/auth/invitations/accept", b),
  },
  me: {
    get: () => get<Me>("/me"),
    update: (name: string) => patch<{ ok: true }>("/me", { name }),
    /** Daily digest email (only sent when the server has Email Sending configured). */
    setDailyDigestEmail: (on: boolean) => patch<{ ok: true }>("/me", { dailyDigestEmail: on }),
    password: (current: string, password: string) => post<{ ok: true }>("/me/password", { current, password }),
  },
  workspace: {
    create: (name: string, currency: string) => post<{ id: string }>("/workspaces", { name, currency }),
    update: (b: { name?: string; currency?: string }) => patch<{ ok: true }>("/workspace", b),
    remove: () => del("/workspace"),
  },
  members: {
    list: () => get<{ items: Member[] }>("/members"),
    invite: (b: { email?: string; role: Role }) => post<{ url: string; expiresAt: number }>("/invitations", b),
    invitations: () => get<{ items: Invitation[] }>("/invitations"),
    revokeInvitation: (id: string) => del(`/invitations/${id}`),
    setRole: (userId: string, role: Role) => patch<{ ok: true }>(`/members/${userId}`, { role }),
    remove: (userId: string) => del(`/members/${userId}`),
  },
  apiKeys: {
    list: () => get<{ items: ApiKey[] }>("/api-keys"),
    create: (name: string) => post<{ id: string; name: string; token: string }>("/api-keys", { name }),
    remove: (id: string) => del(`/api-keys/${id}`),
  },
  adminUsage: () => get<AdminUsage>("/admin/usage"),
  admin: {
    overview: () => get<AdminOverview>("/admin/overview"),
    users: () => get<{ items: AdminUser[] }>("/admin/users"),
    updateUser: (id: string, b: { name?: string; isAdmin?: boolean; status?: UserStatus; resetPassword?: true }) => patch<AdminUser & { password?: string }>(`/admin/users/${id}`, b),
    deleteUser: (id: string) => del(`/admin/users/${id}`),
    workspaces: () => get<{ items: AdminWorkspace[] }>("/admin/workspaces"),
    createWorkspace: (b: { name: string; currency?: string; ownerEmail?: string }) => post<AdminWorkspace>("/admin/workspaces", b),
    deleteWorkspace: (id: string) => del(`/admin/workspaces/${id}`),
    invitations: () => get<{ items: AdminInvitation[] }>("/admin/invitations"),
    invite: (b: { email?: string; workspaceId?: string; role?: Role; newWorkspaceName?: string; isAdmin?: boolean }) => post<{ id: string; url: string; expiresAt: number }>("/admin/invitations", b),
    revokeInvitation: (id: string) => del(`/admin/invitations/${id}`),
    updates: () => get<UpdateStatus>("/admin/updates"),
    checkUpdates: () => post<UpdateStatus>("/admin/updates/check"),
    email: () => get<AdminEmailSettings>("/admin/email"),
    updateEmail: (enabled: boolean) => patch<AdminEmailSettings>("/admin/email", { enabled }),
    testEmail: () => post<{ ok: true; to: string }>("/admin/email/test"),
  },
  pairingCode: () => post<PairingCode>("/pairing-codes"),
  devices: {
    list: () => get<{ items: Device[] }>("/devices"),
    test: (id: string) => post<{ ok: true }>(`/devices/${id}/test`),
    remove: (id: string) => del(`/devices/${id}`),
  },
  apps: {
    list: () => get<{ items: App[]; currency: string }>("/apps"),
    get: (id: string) => get<App & { products: Product[] }>(`/apps/${id}`),
    create: (b: { name: string; bundleId: string; appleAppId?: string } | { platform: "android"; name: string; packageName: string }) => post<App>("/apps", b),
    update: (id: string, b: { name?: string; commissionPct?: 15 | 30; archived?: boolean; rcProjectId?: string; forwardNotificationUrl?: string | null }) => patch<{ ok: true }>(`/apps/${id}`, b),
    import: (setUrls: "empty" | "none") => post<Record<string, unknown>>("/apps/import", { setUrls }),
    syncProducts: (appIds?: string[]) => post<Record<string, unknown>>("/apps/sync-products", appIds ? { appIds } : {}),
    connectNotifications: (id: string) => post<Record<string, unknown>>(`/apps/${id}/connect-notifications`),
    testNotification: (id: string, environment: "Sandbox" | "Production") => post<Record<string, unknown>>(`/apps/${id}/test-notification`, { environment }),
    sync: (id: string) => post<{ history: Record<string, unknown>; transactions: Record<string, unknown> | null }>(`/apps/${id}/sync`),
    rotateSdkKey: (id: string) => post<{ sdkKey: string }>(`/apps/${id}/sdk-key`),
    polar: {
      get: (id: string) => get<PolarSettings>(`/apps/${id}/polar`),
      update: (id: string, b: { webhookSecret?: string | null; accessToken?: string | null; products?: Record<string, string>; sandbox?: boolean }) => put<PolarSettings>(`/apps/${id}/polar`, b),
      sync: (id: string) => post<{ orders: number; stored: number; error?: string }>(`/apps/${id}/polar/sync`),
    },
    googlePlay: {
      get: (id: string) => get<GooglePlaySettings>(`/apps/${id}/google-play`),
      update: (id: string, b: { serviceAccount?: string; credentialId?: string | null; pushServiceAccount?: string | null }) => put<GooglePlaySettings>(`/apps/${id}/google-play`, b),
      test: (id: string) => post<{ ok: boolean; error?: string }>(`/apps/${id}/google-play/test`),
      voided: (id: string) => post<{ apps: number; requests: number; refunded: number; errors: string[] }>(`/apps/${id}/google-play/voided`),
    },
    meta: {
      get: (id: string) => get<MetaIntegration>(`/apps/${id}/integrations/meta`),
      update: (id: string, b: MetaIntegrationUpdate) => put<MetaIntegration>(`/apps/${id}/integrations/meta`, b),
      test: (id: string) => post<{ ok: true; status: number; response: unknown }>(`/apps/${id}/integrations/meta/test`),
      log: (id: string) => get<{ items: MetaDelivery[] }>(`/apps/${id}/integrations/meta/log`),
      backfill: (id: string) => post<{ queued: number }>(`/apps/${id}/integrations/meta/backfill`),
    },
    refunds: {
      get: (id: string) => get<RefundRequestSettings>(`/apps/${id}/integrations/refunds`),
      update: (id: string, b: RefundRequestSettingsUpdate) => put<RefundRequestSettings>(`/apps/${id}/integrations/refunds`, b),
      log: (id: string) => get<{ items: RefundRequestLogItem[] }>(`/apps/${id}/integrations/refunds/log`),
    },
    offers: {
      get: (id: string) => get<OfferSettings>(`/apps/${id}/offers`),
      update: (id: string, b: OfferSettingsUpdate) => put<OfferSettings>(`/apps/${id}/offers`, b),
      import: (id: string) => post<OfferImportResult>(`/apps/${id}/offers/import`),
      log: (id: string, limit = 100) => get<{ items: OfferSignatureLogItem[] }>(`/apps/${id}/offers/log?limit=${limit}`),
      stats: (id: string, range = "90d") => get<OfferStats>(`/apps/${id}/offers/stats?range=${encodeURIComponent(range)}`),
      lapsed: (id: string, days = 90) => get<LapsedSegment>(`/apps/${id}/lapsed?days=${days}`),
    },
    offerings: {
      get: (id: string) => get<OfferingsConfig>(`/apps/${id}/offerings`),
      replace: (id: string, b: OfferingsInput) => put<OfferingsChange>(`/apps/${id}/offerings`, b),
      create: (id: string, b: OfferingInput) => post<OfferingsChange>(`/apps/${id}/offerings`, b),
      update: (id: string, offering: string, b: Partial<OfferingInput>) => patch<OfferingsChange>(`/apps/${id}/offerings/${encodeURIComponent(offering)}`, b),
      remove: (id: string, offering: string, force = false) => del<OfferingsChange>(`/apps/${id}/offerings/${encodeURIComponent(offering)}${force ? "?force=true" : ""}`),
      makeCurrent: (id: string, offering: string) => post<OfferingsChange>(`/apps/${id}/offerings/${encodeURIComponent(offering)}/current`),
      setPlacement: (id: string, placement: string, offeringId: string | null) => put<OfferingsChange>(`/apps/${id}/placements/${encodeURIComponent(placement)}`, { offeringId }),
      removePlacement: (id: string, placement: string) => del<OfferingsChange>(`/apps/${id}/placements/${encodeURIComponent(placement)}`),
    },
    entitlements: {
      get: (id: string) => get<EntitlementsConfig>(`/apps/${id}/entitlements`),
      replace: (id: string, b: EntitlementsInput) => put<EntitlementsChange>(`/apps/${id}/entitlements`, b),
      set: (id: string, entitlement: string, productIds: string[]) => put<EntitlementsChange>(`/apps/${id}/entitlements/${encodeURIComponent(entitlement)}`, { productIds }),
      remove: (id: string, entitlement: string) => del<EntitlementsChange>(`/apps/${id}/entitlements/${encodeURIComponent(entitlement)}`),
      setDuration: (id: string, productId: string, d: ProductDuration) => put<EntitlementsChange>(`/apps/${id}/durations/${encodeURIComponent(productId)}`, d),
      removeDuration: (id: string, productId: string) => del<EntitlementsChange>(`/apps/${id}/durations/${encodeURIComponent(productId)}`),
    },
    remoteConfig: {
      get: (id: string) => get<RemoteConfig>(`/apps/${id}/config`),
      replace: (id: string, b: RemoteConfigInput) => put<RemoteConfig>(`/apps/${id}/config`, b),
      importFirebase: (id: string, template: unknown, opts: { dryRun?: boolean; merge?: boolean } = {}) =>
        post<RemoteConfigImport>(`/apps/${id}/config/import-firebase${qs({ dryRun: opts.dryRun ? "true" : undefined, merge: opts.merge ? "true" : undefined })}`, template),
      evaluate: (id: string, b: RemoteConfigEvaluateInput) => post<RemoteConfigEvaluation>(`/apps/${id}/config/evaluate`, b),
      attributionOptions: (id: string, days = 30) => get<AttributionOptions>(`/apps/${id}/config/attribution-options?days=${days}`),
    },
    keyEvents: {
      get: (id: string) => get<KeyEventSettings>(`/apps/${id}/key-events`),
      update: (id: string, b: { patterns?: string[]; dailyCap?: number | null; retentionDays?: number }) => put<KeyEventSettings>(`/apps/${id}/key-events`, b),
    },
    testDevices: {
      get: (id: string) => get<TestDevices>(`/apps/${id}/test-devices`),
      replace: (id: string, installIds: string[]) => put<TestDevices>(`/apps/${id}/test-devices`, { installIds }),
    },
    experiments: {
      list: (id: string) => get<{ items: Experiment[] }>(`/apps/${id}/experiments`),
      get: (id: string, eid: string) => get<Experiment>(`/apps/${id}/experiments/${encodeURIComponent(eid)}`),
      create: (id: string, b: ExperimentInput) => post<Experiment>(`/apps/${id}/experiments`, b),
      update: (id: string, eid: string, b: ExperimentInput) => patch<Experiment>(`/apps/${id}/experiments/${encodeURIComponent(eid)}`, b),
      remove: (id: string, eid: string) => del(`/apps/${id}/experiments/${encodeURIComponent(eid)}`),
      start: (id: string, eid: string) => post<Experiment>(`/apps/${id}/experiments/${encodeURIComponent(eid)}/start`),
      stop: (id: string, eid: string) => post<Experiment>(`/apps/${id}/experiments/${encodeURIComponent(eid)}/stop`),
      rollout: (id: string, eid: string, variant: string) => post<Experiment>(`/apps/${id}/experiments/${encodeURIComponent(eid)}/rollout`, { variant }),
      archive: (id: string, eid: string) => post<Experiment>(`/apps/${id}/experiments/${encodeURIComponent(eid)}/archive`),
      results: (id: string, eid: string) => get<ExperimentResults>(`/apps/${id}/experiments/${encodeURIComponent(eid)}/results`),
      refreshResults: (id: string, eid: string) => post<ExperimentResults>(`/apps/${id}/experiments/${encodeURIComponent(eid)}/results/refresh`),
    },
    analytics: {
      status: (id: string) => get<AnalyticsStatus>(`/apps/${id}/analytics/status`),
      summary: (id: string, range: string, includeTest = false) =>
        get<EventSummary>(`/apps/${id}/events/summary?range=${encodeURIComponent(range)}${includeTest ? "&includeTest=true" : ""}`),
    },
    funnels: {
      list: (id: string) => get<{ items: Funnel[] }>(`/apps/${id}/funnels`),
      get: (id: string, fid: string) => get<Funnel>(`/apps/${id}/funnels/${encodeURIComponent(fid)}`),
      create: (id: string, b: FunnelInput) => post<Funnel>(`/apps/${id}/funnels`, b),
      update: (id: string, fid: string, b: FunnelInput) => patch<Funnel>(`/apps/${id}/funnels/${encodeURIComponent(fid)}`, b),
      remove: (id: string, fid: string) => del(`/apps/${id}/funnels/${encodeURIComponent(fid)}`),
      report: (id: string, fid: string, q: { range?: string; from?: string; to?: string; breakdown?: string | null; includeTest?: "true" }) =>
        get<FunnelReport>(`/apps/${id}/funnels/${encodeURIComponent(fid)}/report${qs(q)}`),
    },
  },
  credentials: {
    list: () => get<{ items: CredentialView[] }>("/credentials"),
    create: (b: NewCredential) => post<{ id: string }>("/credentials", b),
    update: (id: string, b: { vendorNumber?: string; name?: string }) => patch<{ ok: true }>(`/credentials/${id}`, b),
    remove: (id: string) => del(`/credentials/${id}`),
  },
  overview: (s: Scope) => get<Overview>(`/overview${qs({ apps: s.apps, tzOffset: String(-new Date().getTimezoneOffset()) })}`),
  chart: (metric: Metric, s: Scope & { interval?: Interval; groupBy?: "app" | "country" | "product" }) => get<Chart>(`/charts/${metric}${qs(s)}`),
  mrrMovement: (s: Scope & { interval?: Interval }) => get<MrrMovement>(`/mrr-movement${qs(s)}`),
  breakdown: (s: Scope & { metric: Metric; by: "app" | "country" | "product"; limit?: number }) => get<Breakdown>(`/breakdown${qs(s)}`),
  transactions: (q: TransactionQuery) => get<Page<Transaction>>(`/transactions${qs({ ...q, refunded: q.refunded ? "true" : undefined, quick: q.quick ? "true" : undefined, cancellations: q.cancellations ? "true" : undefined })}`),
  customer: (id: string) => get<Customer>(`/customers/${encodeURIComponent(id)}`),
  setRefundConsent: (id: string, consent: boolean) => put<{ id: string; refundDataConsent: boolean }>(`/customers/${encodeURIComponent(id)}/refund-consent`, { consent }),
  atRisk: (s: Scope, limit = 200) => get<AtRisk>(`/at-risk${qs({ apps: s.apps, limit })}`),
  forecast: (s: Scope, days = 30) => get<Forecast>(`/forecast${qs({ apps: s.apps, days })}`),
  cohorts: (s: Scope, months = 12) => get<Cohorts>(`/cohorts${qs({ apps: s.apps, months })}`),
  attributed: (s: Scope & { includeTest?: boolean }) => get<AttributedRevenue>(`/revenue/attributed${qs({ ...s, includeTest: s.includeTest ? "true" : undefined })}`),
  adsNames: {
    list: () => get<AdsNames>("/attribution/names"),
    put: (names: AdsName[]) => put<AdsNamesUpdate>("/attribution/names", { names }),
  },
  ltv: (s: Scope & { by: LtvDimension; cohort: LtvCohortUnit; summary?: 1 }) => get<Ltv>(`/ltv${qs(s)}`),
  ltvSummary: (s: Scope & { by: LtvDimension }) => get<LtvSummary>(`/ltv/summary${qs(s)}`),
  reconciliation: (s: Scope) => get<ReconciliationResponse>(`/reconciliation${qs(s)}`),
  acquisition: {
    get: (s: Scope & { by?: AcquisitionDimension[]; currency?: string; limit?: number }) => get<Acquisition>(`/acquisition${qs(s)}`),
    campaigns: (s: Pick<Scope, "apps"> = {}) => get<{ currency: string; items: AcquisitionCampaign[] }>(`/acquisition/campaigns${qs({ apps: s.apps })}`),
    status: (s: Pick<Scope, "apps"> = {}) => get<{ items: AcquisitionStatus[] }>(`/acquisition/status${qs({ apps: s.apps })}`),
    request: (b: { appIds?: string[]; limit?: number; retry?: boolean } = {}) => post<AcquisitionRequestsResult>("/acquisition/requests", b),
    sync: (appIds?: string[]) => post<AcquisitionSyncResult>("/acquisition/sync", appIds?.length ? { appIds } : {}),
  },
  goals: {
    list: () => get<{ currency: string; items: GoalProgress[] }>("/goals"),
    create: (b: GoalInput) => post<{ id: string; currency: string; goal: GoalProgress }>("/goals", b),
    update: (id: string, b: GoalInput) => patch<{ id: string; currency: string; goal: GoalProgress }>(`/goals/${encodeURIComponent(id)}`, b),
    reorder: (ids: string[]) => post<{ ok: true; ids: string[] }>("/goals/reorder", { ids }),
    remove: (id: string) => del(`/goals/${encodeURIComponent(id)}`),
  },
  alerts: {
    list: () => get<{ items: Alert[] }>("/alerts"),
    resolve: (id: string) => post<{ ok: true }>(`/alerts/${id}/resolve`),
  },
  jobs: {
    list: () => get<{ items: Job[] }>("/jobs"),
    cancel: (id: string) => post<{ ok: true }>(`/jobs/${id}/cancel`),
  },
  imports: {
    apple: (appIds?: string[]) => post<{ jobs: { appId: string; id: string; reused: boolean }[] }>("/imports/apple", appIds?.length ? { appIds } : {}),
    revenuecat: (credentialId: string) => post<{ id: string; reused: boolean }>("/imports/revenuecat", { credentialId }),
    salesReports: (days: number) => post<{ id: string; reused: boolean }>("/imports/sales-reports", { days }),
    fx: (from: string) => post<{ id: string; reused: boolean }>("/imports/fx", { from }),
    acquisition: () => post<{ id: string; reused: boolean }>("/imports/acquisition"),
  },
};
