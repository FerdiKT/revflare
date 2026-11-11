import { Hono } from "hono";
import { FUNNEL_BREAKDOWNS, GOAL_METRICS, GOAL_PERIODS, GOAL_SCOPES, INSTALL_SOURCES, METRICS, SDK_ENVIRONMENTS } from "../../shared/types";
import { principal, type AppEnv } from "../lib/auth";
import { getDb } from "../lib/db";

/**
 * Minimal MCP server (Streamable HTTP, JSON responses) so AI agents can read revenue. Authenticate with an API key
 * (`Authorization: Bearer rf_...`), bound to one workspace. Every tool is a thin wrapper over the REST API, called
 * in-process with the same key, so workspace scoping and permission checks are the REST API's.
 */
export function mcpRoutes(api: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> }) {
  const mcp = new Hono<AppEnv>();

  const call = async (c: any, method: string, path: string, body?: unknown): Promise<any> => {
    const req = new Request(new URL(`/api/v1${path}`, c.req.url), {
      method,
      headers: { authorization: c.req.header("authorization") ?? "", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await api.fetch(req, c.env, c.executionCtx);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
    return data;
  };

  const seg = (v: unknown) => {
    const s = String(v ?? "");
    if (!s || s === "." || s === "..") throw new Error(`Invalid id: ${s}`);
    return encodeURIComponent(s);
  };

  const query = (a: Record<string, unknown>, keys: string[]) => {
    const q = new URLSearchParams();
    for (const k of keys) {
      const v = a[k];
      if (v === undefined || v === null || v === "") continue;
      q.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const s = q.toString();
    return s ? `?${s}` : "";
  };

  const rangeProps = {
    range: { type: "string", description: "7d, 28d, 30d, 90d, 12m, mtd, ytd or all (default 30d). Ignored when from is set." },
    from: { type: "string", description: "YYYY-MM-DD (inclusive)" },
    to: { type: "string", description: "YYYY-MM-DD (inclusive, default today)" },
    apps: { type: "array", items: { type: "string" }, description: "App ids (list_apps) to limit to; all apps when omitted." },
  };

  const GOAL_PROPS = {
          name: { type: "string", description: "Optional name (≤ 60 characters); empty string clears it" },
          metric: { type: "string", enum: [...GOAL_METRICS], description: "revenue / proceeds / mrr are money (workspace currency); the others counts. sales = new subscriptions + renewals + one-time purchases." },
          target: { type: "number", description: "Target in the workspace currency (money) or a count" },
          period: { type: "string", enum: [...GOAL_PERIODS], description: "Rolling week (Mon–Sun) / month / quarter / year, or custom (needs startDate and endDate). Default month." },
          startDate: { type: "string", description: "Custom period: first day YYYY-MM-DD" },
          endDate: { type: "string", description: "Custom period: last day YYYY-MM-DD (inclusive)" },
          scope: { type: "string", enum: [...GOAL_SCOPES], description: "all apps, include = only appIds, exclude = every app but appIds (apps added later count)" },
          appIds: { type: "array", items: { type: "string" }, description: "App ids (list_apps) for include / exclude" },
          notify: { type: "boolean", description: "Push to the iOS app when reached (once per period)" },
          archived: { type: "boolean", description: "Hide the goal (kept)" },
        };

  const tools: Record<string, { description: string; inputSchema: object; run: (c: any, a: any) => Promise<unknown> }> = {
    get_overview: {
      description:
        "Dashboard summary in the workspace currency: today's revenue and sales, MRR, 28-day revenue and proceeds with change vs the previous 28 days, active subscriptions and trials, MRR movement, revenue at risk, 30-day renewal forecast, goals (non-archived, with progress; list_goals for details), record days and top apps.",
      inputSchema: { type: "object", properties: { apps: rangeProps.apps } },
      run: (c, a) => call(c, "GET", `/overview${query(a, ["apps"])}`),
    },
    list_apps: {
      description:
        "Apps with their ids, platform (ios = App Store, android = Google Play, web = website selling through Polar), bundle ids (Android: package names), MRR, 28-day revenue, active subscriptions and where their store notifications go (iOS: App Store Server Notifications; Android: googlePlay setup status; web: polar webhook status). Optional platform filter.",
      inputSchema: { type: "object", properties: { platform: { type: "string", enum: ["ios", "android", "web"] } } },
      run: async (c, a) =>
        ((await call(c, "GET", "/apps")).items as any[]).filter((x) => !a?.platform || x.platform === a.platform).map((x) => ({
          id: x.id,
          name: x.name,
          platform: x.platform,
          store: x.platform === "android" ? "Google Play" : x.platform === "web" ? "Polar" : "App Store",
          bundleId: x.bundleId,
          appleAppId: x.appleAppId,
          mrr: x.mrr,
          revenue28d: x.revenue28d,
          activeSubscriptions: x.activeSubscriptions,
          activeTrials: x.activeTrials,
          notifications: x.platform !== "ios" ? undefined : x.notificationUrlStatus,
          googlePlay: x.googlePlay ?? undefined,
          polar: x.polar ?? undefined,
          archived: x.archived || undefined,
        })),
    },
    get_chart: {
      description: `Time series of one metric. Metrics: ${METRICS.join(", ")}. Optional groupBy app, country or product. Money is in the workspace currency; rates are fractions (0.05 = 5%).`,
      inputSchema: {
        type: "object",
        properties: {
          metric: { type: "string", enum: [...METRICS] },
          interval: { type: "string", enum: ["day", "week", "month"] },
          groupBy: { type: "string", enum: ["app", "country", "product"] },
          ...rangeProps,
        },
        required: ["metric"],
      },
      run: (c, a) => call(c, "GET", `/charts/${seg(a.metric)}${query(a, ["range", "from", "to", "apps", "interval", "groupBy"])}`),
    },
    get_breakdown: {
      description: "Top apps, countries or products for a metric over a period (with share of total). Stock metrics (mrr, active_subscriptions) use the current snapshot.",
      inputSchema: {
        type: "object",
        properties: { metric: { type: "string", enum: [...METRICS] }, by: { type: "string", enum: ["app", "country", "product"] }, limit: { type: "number" }, ...rangeProps },
        required: ["by"],
      },
      run: (c, a) => call(c, "GET", `/breakdown${query(a, ["metric", "by", "limit", "range", "from", "to", "apps"])}`),
    },
    get_mrr_movement: {
      description: "MRR movement per interval: new, expansion, contraction, churn, reactivation, net and ending MRR.",
      inputSchema: { type: "object", properties: { interval: { type: "string", enum: ["day", "week", "month"] }, ...rangeProps } },
      run: (c, a) => call(c, "GET", `/mrr-movement${query(a, ["range", "from", "to", "apps", "interval"])}`),
    },
    list_transactions: {
      description:
        `Latest transactions (purchases, renewals, trials, conversions, refunds), newest first, each with store (app_store | play_store | polar) and attribution (source ${INSTALL_SOURCES.join(" | ")}, test, Apple Ads campaign / ad group / keyword ids and names); subscription rows carry autoRenew (a trial with autoRenew false that has not expired = cancelled trial). Pass nextCursor back as cursor for more. ` +
        "Rows carry sinceInstallMs (customer's first purchase / trial: ms since the RevflareKit install), cancelledAfterMs (ms from the purchase to auto-renew being turned off in its period) and quick (either within 5 minutes). " +
        "quick: only those quick rows; cancellations: the cancellations stream instead (rows of kind cancellation = auto-renew turned off, purchasedAt = when, sincePurchaseMs, purchaseKind, customerId). " +
        "With source or quick, a page looks at 500 rows at most: it can hold fewer items (even none) while nextCursor continues.",
      inputSchema: {
        type: "object",
        properties: {
          apps: rangeProps.apps,
          kinds: { type: "array", items: { type: "string", enum: ["trial", "conversion", "new", "renewal", "one_time"] } },
          country: { type: "string", description: "Alpha-2 code" },
          refunded: { type: "boolean" },
          q: { type: "string", description: "Transaction id, original transaction id or customer id" },
          source: { type: "string", enum: [...INSTALL_SOURCES], description: "Acquisition of the purchase's RevflareKit install (unknown: no install linked; google_ads / referral: Android install referrer)" },
          quick: { type: "boolean", description: "Only buyers within 5 minutes of the install and cancellations within 5 minutes of the purchase" },
          cancellations: { type: "boolean", description: "The cancellations (auto-renew turned off) instead of the sales" },
          limit: { type: "number" },
          cursor: { type: "string" },
        },
      },
      run: (c, a) => call(c, "GET", `/transactions${query(a, ["apps", "kinds", "country", "refunded", "q", "source", "quick", "cancellations", "limit", "cursor"])}`),
    },
    get_customer: {
      description:
        "One customer: firstSeenAt / lastSeenAt (ms, with firstSeenSource install | purchase and lastSeenSource app | purchase | notification), installedAt (RevflareKit install), timing (installToPurchaseMs, purchaseToCancelMs, purchaseToRefundMs, quickPurchase / quickCancel: within 5 minutes), " +
        "subscriptions (autoRenew false on a running one = cancelled, ends at expiresAt; autoRenewOffAt = when it was turned off, cancelledAfterMs = how long after the purchase), all transactions, total spent, attribution (Apple Ads campaign / ad group / keyword, organic or unknown) and events: the store notification history (type / subtype / at, newest first).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (c, a) => call(c, "GET", `/customers/${seg(a.id)}`),
    },
    get_at_risk: {
      description: "Revenue at risk: subscriptions in billing retry or grace period and those with auto-renew turned off, with the MRR involved.",
      inputSchema: { type: "object", properties: { apps: rangeProps.apps, limit: { type: "number" } } },
      run: (c, a) => call(c, "GET", `/at-risk${query(a, ["apps", "limit"])}`),
    },
    get_forecast: {
      description: "Expected renewal revenue for the next N days (default 30) from subscriptions due to renew, weighted by observed renewal rates.",
      inputSchema: { type: "object", properties: { days: { type: "number" }, apps: rangeProps.apps } },
      run: (c, a) => call(c, "GET", `/forecast${query(a, ["days", "apps"])}`),
    },
    get_cohorts: {
      description: "Monthly cohorts by first payment: customers, revenue per month since, cumulative LTV per customer and retained payers.",
      inputSchema: { type: "object", properties: { months: { type: "number" }, apps: rangeProps.apps } },
      run: (c, a) => call(c, "GET", `/cohorts${query(a, ["months", "apps"])}`),
    },
    get_reconciliation: {
      description: "Apple Sales and Trends numbers next to Revflare's per day and app (units, proceeds) to spot missing sales.",
      inputSchema: { type: "object", properties: rangeProps },
      run: (c, a) => call(c, "GET", `/reconciliation${query(a, ["range", "from", "to", "apps"])}`),
    },
    get_daily_revenue: {
      description: "Daily revenue per app (App Store id, bundle id): revenue, proceeds, transactions, trials, new customers, payers, refunds, MRR. For ROAS against ad spend.",
      inputSchema: { type: "object", properties: { ...rangeProps, appleAppIds: { type: "array", items: { type: "string" } }, currency: { type: "string" } } },
      run: (c, a) => call(c, "GET", `/revenue/daily${query(a, ["range", "from", "to", "appleAppIds", "currency"])}`),
    },
    get_attributed_revenue: {
      description:
        "Apple Ads revenue from RevflareKit attribution: per day, app, campaign, ad group and keyword (ids and names, null names: unknown) with revenue, proceeds, transactions, trials, installs, payers, plus coverage (installs reporting / attributed / testInstalls). " +
        "Apple's test attribution (AdServices test payload, campaign 1234567890), sandbox / Xcode builds and test devices are left out unless includeTest (rows then flagged test).",
      inputSchema: {
        type: "object",
        properties: {
          ...rangeProps,
          appleAppIds: { type: "array", items: { type: "string" } },
          currency: { type: "string" },
          includeTest: { type: "boolean", description: "Count test data (test attribution, sandbox / Xcode builds, test devices)" },
        },
      },
      run: (c, a) => call(c, "GET", `/revenue/attributed${query(a, ["range", "from", "to", "apps", "appleAppIds", "currency", "includeTest"])}`),
    },
    get_ads_names: {
      description: "Apple Ads campaign / ad group / keyword names Revflare knows (kind, id, name), set by Adsflare or imported with the CLI / web app.",
      inputSchema: { type: "object", properties: {} },
      run: (c) => call(c, "GET", "/attribution/names"),
    },
    get_ltv: {
      description:
        "LTV by acquisition source (RevflareKit installs): install cohorts (day / week / month of install) × group (by: source = apple_ads | organic, campaign, adgroup, keyword, country) with installs, payers, trials and revenue / proceeds per install at D0 (first 24 h), D7, D30, D90, D180 and to date. " +
        "Refunds excluded (prorated refunds in part). Horizons a cohort has not reached yet are null with immature: true. coverage.share = paying customers linked to a reporting install; " +
        "installs whose purchases all started more than 48 h before the install (users who had the app before) are left out (coverage.preexisting). Cohorts are UTC days, values cached for the UTC day. " +
        "summary: true → per group only, pooled over the installs old enough for each horizon (payback / ROAS inputs). Ids are Apple Ads ids.",
      inputSchema: {
        type: "object",
        properties: {
          ...rangeProps,
          by: { type: "string", enum: ["source", "campaign", "adgroup", "keyword", "country"] },
          cohort: { type: "string", enum: ["day", "week", "month"] },
          summary: { type: "boolean" },
          appleAppIds: { type: "array", items: { type: "string" } },
          currency: { type: "string" },
        },
      },
      run: (c, a) =>
        a.summary
          ? call(c, "GET", `/ltv/summary${query(a, ["range", "from", "to", "apps", "appleAppIds", "by", "currency"])}`)
          : call(c, "GET", `/ltv${query(a, ["range", "from", "to", "apps", "appleAppIds", "by", "cohort", "currency"])}`),
    },
    get_acquisition: {
      description:
        "App Store acquisition from Apple's App Analytics reports: impressions, product page views, first-time downloads, redownloads, conversion rate (downloads / unique page views) and App Store purchases / proceeds, " +
        "grouped by source type (App Store search, App Store browse, Web referrer, App referrer, ...), referrer (app or website), campaign token (ct= in App Store links), day and/or app. " +
        "Referrer and campaign groups come from Apple's Detailed reports, where Apple leaves out rows with fewer than 5 users, so they sum to less than the totals. firstDay null = no reports imported yet (Apple needs 1–2 days after the request).",
      inputSchema: {
        type: "object",
        properties: {
          ...rangeProps,
          by: { type: "array", items: { type: "string", enum: ["source", "referrer", "campaign", "day", "app"] }, description: "Dimensions to group by (default source)." },
          currency: { type: "string" },
          limit: { type: "number" },
        },
      },
      run: (c, a) => call(c, "GET", `/acquisition${query(a, ["range", "from", "to", "apps", "by", "currency", "limit"])}`),
    },
    list_acquisition_campaigns: {
      description: "Campaign tokens (ct= in App Store campaign links) Apple reported, per app, with first/last day seen, impressions, page views, downloads, purchases and proceeds (all time).",
      inputSchema: { type: "object", properties: { apps: rangeProps.apps } },
      run: (c, a) => call(c, "GET", `/acquisition/campaigns${query(a, ["apps"])}`),
    },
    get_acquisition_status: {
      description: "State of each app's App Analytics report request (none, requested, producing, stopped, failed), last processing date and day range imported, errors.",
      inputSchema: { type: "object", properties: { apps: rangeProps.apps } },
      run: (c, a) => call(c, "GET", `/acquisition/status${query(a, ["apps"])}`),
    },
    get_google_play: {
      description:
        "An Android app's Google Play setup: package name, the RTDN push URL (Pub/Sub push endpoint), the push service account (OIDC check), the service account key in use (client email, project), " +
        "last notification, last check (ok or the Play API error) and the last voided purchases poll. Android apps only (list_apps platform android).",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/google-play`),
    },
    get_polar: {
      description:
        "A web app's Polar setup (web checkout, merchant of record): the webhook URL to add in Polar, whether a webhook secret / access token is stored, sandbox, the Polar product id → Revflare product id map, " +
        "last webhook and last order import. Web apps only (list_apps platform web). Polar sales are transactions with store polar; they count in revenue, MRR and the overview like store sales.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/polar`),
    },
    get_meta_integration: {
      description:
        "An app's Meta Ads integration (purchases sent to Meta's Conversions API as app events): enabled, dataset id, whether an access token is set (never the token), test event code, " +
        "Sandbox / no-ATT switches, per-event toggles and Meta event names (trial_started, initial_purchase, trial_converted, renewal, non_subscription_purchase), " +
        "counts of pending / sent / skipped / failed events, last sent time and last error.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/integrations/meta`),
    },
    get_meta_delivery_log: {
      description:
        "Last deliveries of an app's Meta Ads integration, newest first: event type and name, event_id, transaction id, status (sent / skipped / failed), Meta's HTTP status and response (with fbtrace_id) or the skip reason (no install linked, ATT not authorized, Sandbox, older than 7 days, ...).",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" }, limit: { type: "number", description: "At most 100 (default)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/integrations/meta/log${query(a, ["limit"])}`),
    },
    get_refund_requests: {
      description:
        "An app's answers to Apple's refund requests (CONSUMPTION_REQUEST → Send Consumption Information): settings (enabled, consent attestation with who / when, refund preference policy none / decline / decline_if_delivered_after_days / grant_prorated / grant_full, source app | workspace defaults, " +
        "sampleContentProvided, consumed percentage, deliveryStatus), where the app's notifications go, counts (pending / sent / skipped / failed / expired) and the last requests, newest first " +
        "(transaction, product, Apple's consumptionRequestReason, status, the body sent, Apple's HTTP status and answer, skip / failure reason). Forwarded and polled (inside Apple's 12 hours) requests are answered too; unanswered production ones raise refund_request_unanswered alerts. " +
        "Read-only: change settings with the CLI (revflare refunds <app> set, or revflare refunds defaults set for every app) or the web app.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" }, limit: { type: "number", description: "Log rows, at most 100 (default 20)" } }, required: ["app"] },
      run: async (c, a) => {
        const base = `/apps/${seg(a.app)}/integrations/refunds`;
        const [settings, log] = await Promise.all([call(c, "GET", base), call(c, "GET", `${base}/log${query({ limit: a.limit ?? 20 }, ["limit"])}`)]);
        return { ...settings, requests: log.items };
      },
    },
    get_offerings: {
      description:
        "An app's offerings and placements (paywalls RevflareKit loads remotely): each offering's identifier, display name, metadata JSON and ordered packages (package identifier such as $annual / $monthly → App Store product id), " +
        "which offering is current, placements (paywall location → offering, null = the current one), the config version and `preview` (the exact JSON the SDK gets). Read-only: change them with the CLI (revflare offerings) or the web app.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/offerings`),
    },
    get_entitlements: {
      description:
        "An app's server-driven entitlements (entitlement → product ids; RevflareKit 1.9+ merges them with the app's own map, union per entitlement, so a new product unlocks an entitlement without an app update) " +
        "and the durations of its non-renewing products (passes: unit day / week / month / year × count; RevflareKit expires them, repeat purchases stack; Revflare stores purchase + duration as the transaction's expiry), " +
        "plus `preview` (the fields the SDK gets inside GET /sdk/v1/offerings). Change them with set_entitlements.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/entitlements`),
    },
    set_entitlements: {
      description:
        "Changes an app's server-driven entitlements or non-renewing durations (needs an API key with the manage permission). action: set (entitlement's products = productIds, creates it), " +
        "add_products, remove_products, delete (the entitlement), set_duration (productId + unit + count; recomputes the expiry of the product's stored transactions), remove_duration (productId). " +
        "Durations are refused (400) for products known to be non-consumable or auto-renewable; never set one on a lifetime product (on Google Play one-time products are ambiguous). " +
        "Returns the new config, warnings (unknown products, durations on products that take none), updatedTransactions and truncated (more recomputed in the background).",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App id (list_apps)" },
          action: { type: "string", enum: ["set", "add_products", "remove_products", "delete", "set_duration", "remove_duration"] },
          entitlement: { type: "string", description: "Entitlement identifier, e.g. pro (set / add_products / remove_products / delete)" },
          productIds: { type: "array", items: { type: "string" }, description: "Product ids (set / add_products / remove_products)" },
          productId: { type: "string", description: "Non-renewing product id (set_duration / remove_duration)" },
          unit: { type: "string", enum: ["day", "week", "month", "year"], description: "set_duration" },
          count: { type: "number", description: "set_duration: whole number of units (1-1000)" },
        },
        required: ["app", "action"],
      },
      run: async (c, a) => {
        const base = `/apps/${seg(a.app)}`;
        const ent = () => `${base}/entitlements/${seg(a.entitlement)}`;
        const ids = Array.isArray(a.productIds) ? (a.productIds as unknown[]).map(String) : [];
        switch (a.action) {
          case "set":
            // Never clear an entitlement because productIds was left out (an empty list must be explicit).
            if (!Array.isArray(a.productIds)) throw new Error("productIds is required for set (pass [] to empty the entitlement)");
            return call(c, "PUT", ent(), { productIds: ids });
          case "add_products":
            return call(c, "POST", `${ent()}/products`, { productIds: ids });
          case "remove_products": {
            if (!ids.length) throw new Error("productIds is required");
            let r: unknown = null;
            for (const p of ids) r = await call(c, "DELETE", `${ent()}/products/${seg(p)}`);
            return r;
          }
          case "delete":
            return call(c, "DELETE", ent());
          case "set_duration":
            return call(c, "PUT", `${base}/durations/${seg(a.productId)}`, { unit: a.unit, count: a.count });
          case "remove_duration":
            return call(c, "DELETE", `${base}/durations/${seg(a.productId)}`);
          default:
            throw new Error(`Unknown action: ${String(a.action)}`);
        }
      },
    },
    get_offers: {
      description:
        "An app's promotional offers (RevflareKit asks Revflare to sign them with the In-App Purchase key): the allowlist (productId, offerId, label, kind promotional | win_back; only promotional ones are signed, win-back needs no signature), " +
        "strict mode (sign only for installs linked to a subscription of the product's group), whether an In-App Purchase key and a bundle id are set, the last signature requests (status signed / not_allowed / not_configured / not_subscribed) " +
        "and promotional (offerType 2) / win-back (4) redemptions per offer for the range (count, customers, revenue, proceeds). Read-only: change it with the CLI (revflare offers) or the web app.",
      inputSchema: {
        type: "object",
        properties: { app: { type: "string", description: "App id (list_apps)" }, range: { type: "string", description: "Redemption stats range: 7d, 30d, 90d (default), 12m, ytd, all" }, limit: { type: "number", description: "Log rows (default 20)" } },
        required: ["app"],
      },
      run: async (c, a) => {
        const base = `/apps/${seg(a.app)}/offers`;
        const [settings, log, stats] = await Promise.all([
          call(c, "GET", base),
          call(c, "GET", `${base}/log${query({ limit: a.limit ?? 20 }, ["limit"])}`),
          call(c, "GET", `${base}/stats${query({ range: a.range ?? "90d" }, ["range"])}`),
        ]);
        return { ...settings, signatures: log.items, redemptions: stats };
      },
    },
    get_lapsed_subscribers: {
      description:
        "An app's lapsed subscribers: subscriptions that expired in the last `days` (default 90) with auto-renew off (grace period and billing retry excluded: those are still subscribers), counts by product and the most recent 200 " +
        "(customer id, product, expiredAt, country, the customer's total paid in the workspace currency). The audience for promotional and win-back offers.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" }, days: { type: "number", description: "Window in days, 1 to 730 (default 90)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/lapsed${query(a, ["days"])}`),
    },
    get_remote_config: {
      description:
        "An app's remote config (like Firebase Remote Config; RevflareKit reads it at launch): conditions in priority order (name, rules ANDed: country / ip_country / storefront / language / locale lists, app_version / app_build / os_version / sdk_version comparisons, " +
        `source in [${INSTALL_SOURCES.join(", ")}], apple_ads_campaign / apple_ads_ad_group / apple_ads_keyword id lists, environment in [${SDK_ENVIRONMENTS.join(", ")}], ` +
        "percent rollout from <= bucket < to, install_id testers; unsupported = imported from Firebase, never matches) and typed parameters (key, type string|number|boolean|json, defaultValue or useInAppDefault, conditionalValues per condition), " +
        "version, updatedAt and warnings. Read-only: change it with the CLI (revflare config) or the web app.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/config`),
    },
    evaluate_remote_config: {
      description:
        "The remote config values a device would get (preview): give any of storefront (country, alpha-2), ipCountry, appVersion, appBuild, osVersion, locale (e.g. zh_CN), installId (percent rollouts, testers), sdkVersion, " +
        `source (${INSTALL_SOURCES.join(" | ")}), campaign / adGroup / keyword (Apple Ads ids), environment (${SDK_ENVIRONMENTS.join(" | ")}; default production). ` +
        "Returns values (keys using the in-app default are omitted), matched conditions, the country used, version, and per parameter which condition its value came from (null = default).",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App id (list_apps)" },
          storefront: { type: "string" },
          ipCountry: { type: "string" },
          appVersion: { type: "string" },
          appBuild: { type: "string" },
          osVersion: { type: "string" },
          locale: { type: "string" },
          installId: { type: "string" },
          sdkVersion: { type: "string" },
          source: { type: "string", enum: [...INSTALL_SOURCES] },
          campaign: { type: "string", description: "Apple Ads campaign id" },
          adGroup: { type: "string", description: "Apple Ads ad group id" },
          keyword: { type: "string", description: "Apple Ads keyword id" },
          environment: { type: "string", enum: [...SDK_ENVIRONMENTS] },
        },
        required: ["app"],
      },
      run: (c, a) => {
        const { app, ...device } = a as Record<string, unknown>;
        return call(c, "POST", `/apps/${seg(app)}/config/evaluate`, device);
      },
    },
    get_event_summary: {
      description:
        "An app's events from RevflareKit (Revflare.track, stored in Workers Analytics Engine): top events with counts and unique installs, total events and installs, and per-day counts (UTC days) for the last N days. " +
        "Each event has source: exact (a key event stored exactly in the database: exact count and unique installs) or sampled (Analytics Engine); both by UTC day of reception. notes says why exact counts were not used or that the daily breakdown is incomplete. " +
        "approximate = Analytics Engine sampled the data (counts are weighted, unique installs are lower bounds). Errors with code analytics_not_configured mean CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN are not set. " +
        "Production data from other devices than the app's test devices unless includeTest (sandbox / Xcode builds and test devices too).",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App id (list_apps)" },
          range: { type: "string", description: "1d to 92d (default 7d)" },
          includeTest: { type: "boolean", description: "Count test data (sandbox / Xcode builds, test devices)" },
        },
        required: ["app"],
      },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/events/summary${query(a, ["range", "includeTest"])}`),
    },
    get_key_events: {
      description:
        "An app's key-event settings: events stored exactly in the database besides Analytics Engine (which samples), read by funnels, experiment exposures, alerts, the digest and the events page. " +
        "builtin (first_open, purchase_*, restore_*, paywall_view, paywall_close, onboarding_*, experiment_exposure), the app's extra patterns (exact names or one leading / trailing *), dailyCap (in effect; dailyCapIsDefault / defaultDailyCap: the instance's default, min(50,000, backgroundWritesPerDay / writesPerEvent / 2); over it: sampled for the rest of the day, key_events_capped alert), " +
        "retentionDays, since (first UTC day stored exactly: earlier ranges are sampled) and today { count, capped }. Read-only: change them with the CLI (revflare events <app> key-events) or the web app.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/key-events`),
    },
    get_test_devices: {
      description:
        "An app's test devices: RevflareKit install ids (at most 50) left out of events, funnels, experiments, insights, LTV, attributed revenue and Meta sending, like sandbox / Xcode builds. " +
        "Read-only: change them with the CLI (revflare apps <app> test-devices add|rm) or the web app.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/test-devices`),
    },
    list_funnels: {
      description:
        "An app's funnels: id, name, ordered steps (event steps with optional property filters, revenue steps trial_started / paid / any_purchase from Revflare's own sales), conversion window (seconds), whether steps must happen in order, and alerts { enabled, sensitivity: high | normal | low } (daily funnel anomaly / release regression checks).",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/funnels`),
    },
    get_funnel_report: {
      description:
        "Where users drop off in a funnel: per step the installs that reached it, conversion from the previous and the first step (fractions), drop-off count and median seconds from the previous step, for installs entering (first step) between from and to. " +
        "Optional breakdown by the first step's app_version, os_version, country, locale or a promoted property (placement, offering, product, step, screen, variant): top 10 values. approximate + notes explain sampling, caps or inferred times; source is exact when every event step came from stored key events (sampled: Analytics Engine, a note says when exact data starts after the range start). " +
        "Production data from other devices than the app's test devices unless includeTest.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App id (list_apps)" },
          funnel: { type: "string", description: "Funnel id (list_funnels)" },
          range: { type: "string", description: "Entry days, e.g. 7d, 30d (default), 90d. Ignored when from is set." },
          from: { type: "string", description: "YYYY-MM-DD (inclusive)" },
          to: { type: "string", description: "YYYY-MM-DD (inclusive, default today)" },
          breakdown: { type: "string", enum: [...FUNNEL_BREAKDOWNS] },
          includeTest: { type: "boolean", description: "Count test data (sandbox / Xcode builds, test devices)" },
        },
        required: ["app", "funnel"],
      },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/funnels/${seg(a.funnel)}/report${query(a, ["range", "from", "to", "breakdown", "includeTest"])}`),
    },
    list_experiments: {
      description:
        "An app's A/B experiments on remote config parameters (newest first): id, name, hypothesis, keys (parameters the variants set), variants [{ id a..e (a = control), name, weight %, values }], " +
        "targeting (a remote config condition, null = everyone), traffic (% of matching devices enrolled), primaryMetric (trial_started | paid | revenue_per_install), " +
        "status (draft | running | stopped | rolled_out | archived), startedAt, stoppedAt, endsAt (auto-stop after 90 days), rolledOutVariant. Read-only: manage them with the CLI (revflare experiments) or the web app.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App id (list_apps)" } }, required: ["app"] },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/experiments`),
    },
    get_experiment_results: {
      description:
        "Results of an experiment: per variant exposed installs (sent experiment_exposure since the start), trials and trialRate, paid conversions and paidRate (first paid period or one-time purchase begun after the first exposure, refunds subtracted), " +
        "revenue / proceeds of what was bought after the first exposure (renewals included) and per exposed install (workspace currency), probabilityBest (Bayesian, Beta posteriors) and lift vs the control with a 95% credible interval for trial_started and paid. " +
        "enoughData = guardrails met (7 days, 100 exposed installs per variant, 10 conversions on the primary metric); reasons says what is missing — do not call a winner before. " +
        "confident = P(best) >= 95% on the primary metric. approximate / notes: sampling or caps. Stored results, recomputed by the server every few hours (generatedAt); final (frozen) after the stop.",
      inputSchema: {
        type: "object",
        properties: { app: { type: "string", description: "App id (list_apps)" }, experiment: { type: "string", description: "Experiment id (list_experiments)" } },
        required: ["app", "experiment"],
      },
      run: (c, a) => call(c, "GET", `/apps/${seg(a.app)}/experiments/${seg(a.experiment)}/results`),
    },
    list_goals: {
      description:
        "Goals with progress in the workspace currency: name/label, metric, period (week, month, quarter, year, custom dates), app scope (all, include, exclude + appIds), target, current, progress, " +
        "pace (on_track, behind, reached, missed, upcoming), expected by now, delta (ahead > 0 / behind < 0), projected end-of-period value, requiredPerDay, daysLeft, reachedAt, previous period's value and whether it hit, archived, notify.",
      inputSchema: { type: "object", properties: { includeArchived: { type: "boolean", description: "Also archived goals (default false)" } } },
      run: async (c, a) => {
        const r = await call(c, "GET", "/goals");
        return a.includeArchived ? r : { ...r, items: r.items.filter((g: { archived: boolean }) => !g.archived) };
      },
    },
    create_goal: {
      description: "Creates a goal (needs an API key with the manage permission). Returns the goal with its progress.",
      inputSchema: { type: "object", properties: GOAL_PROPS, required: ["metric", "target"] },
      run: (c, a) => call(c, "POST", "/goals", a),
    },
    update_goal: {
      description: "Changes a goal (any of its fields; archived: true hides it). Needs the manage permission.",
      inputSchema: { type: "object", properties: { goal: { type: "string", description: "Goal id (list_goals)" }, ...GOAL_PROPS }, required: ["goal"] },
      run: (c, a) => {
        const { goal, ...body } = a;
        return call(c, "PATCH", `/goals/${seg(goal)}`, body);
      },
    },
    list_alerts: {
      description:
        "Recent alerts (newest first, open and resolved): kind notifications_silent (App Store notifications stopped), sync_failing, revenue_drop, refund_spike, " +
        "events_silent (an app stopped sending RevflareKit events), funnel_anomaly (yesterday's step-to-step conversion of a funnel dropped significantly against the 14 days before and the same weekday) and " +
        "release_regression (the newest app version converts significantly worse than the previous one at a funnel step), experiment_result (an experiment reached a confident result on its primary metric), key_events_capped (an app reached its daily key-event cap or the background budget, or a key-event write failed: the rest of that day is sampled). " +
        "funnelId (with appId) names the funnel for get_funnel_report, experimentId the experiment for get_experiment_results.",
      inputSchema: { type: "object", properties: {} },
      run: (c) => call(c, "GET", "/alerts"),
    },
  };

  mcp.get("/", (c) => c.json({ error: "Use POST (MCP Streamable HTTP)" }, 405));

  mcp.post("/", async (c) => {
    c.set("db", getDb(c.env));
    const p = await principal(c);
    if (!p || p.kind !== "api_key") return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: use an API key (rf_...)" } }, 401);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const handle = async (msg: any) => {
      if (!msg || typeof msg !== "object") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
      const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
      if (msg.id === undefined || msg.method === undefined) return null;
      switch (msg.method) {
        case "initialize":
          return reply({
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "revflare", version: "1.0.0" },
            instructions:
              "Read in-app purchase and subscription revenue (App Store) for one Revflare workspace. Money is in the workspace's reporting currency; " +
              "'revenue' is what customers paid (net of refunds), 'proceeds' is what the developer gets after Apple's commission and VAT. " +
              "Start with get_overview, list_apps for app ids, get_chart for time series, get_breakdown for top apps/countries/products, " +
              "get_acquisition for where App Store visitors and downloads come from (source type, referrer, campaign), " +
              "get_event_summary / list_funnels / get_funnel_report for in-app events and where users drop off, list_experiments / get_experiment_results for A/B tests.",
          });
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
        case "tools/call": {
          const tool = tools[msg.params?.name];
          if (!tool) return fail(-32602, `Unknown tool ${msg.params?.name}`);
          try {
            const result = await tool.run(c, msg.params.arguments ?? {});
            return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
          } catch (err) {
            return reply({ content: [{ type: "text", text: (err as Error).message }], isError: true });
          }
        }
        default:
          return fail(-32601, `Method not found: ${msg.method}`);
      }
    };
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map(handle))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handle(payload);
    return out ? c.json(out) : c.body(null, 202);
  });

  return mcp;
}
