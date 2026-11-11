// Promotional offers of an app (docs/offers.md): allowlist and strict mode, import from App Store Connect, signature
// log, lapsed subscribers, promotional / win-back redemption stats. RevflareKit signs at POST /sdk/v1/offers/sign.
import { Hono } from "hono";
import type { LapsedSegment, OfferEntry, OfferImportResult, OfferStats } from "../../shared/types";
import { AppStoreConnectApi } from "../apple/connect";
import { requirePermission, wsId, type AppEnv, type Ctx } from "../lib/auth";
import { getCredential } from "../lib/credentials";
import { FxCache, dayOf } from "../lib/money";
import { range } from "./metrics";
import {
  forgetOfferContext,
  lapsedSubscribers,
  mergeOffers,
  offerSettingsView,
  offerSignatureLog,
  offerStats,
  parseOfferUpdate,
  saveOfferSettings,
} from "../lib/offers";
import { errorMessage, now, parseJson } from "../lib/util";

export const offerRoutes = new Hono<AppEnv>();

type AppRow = { id: string; workspace_id: string; bundle_id: string | null; sdk_key: string | null; apple_app_id: string | null; platform: string };

async function appOf(c: Ctx) {
  return c.var.db
    .prepare("SELECT id, workspace_id, bundle_id, sdk_key, apple_app_id, platform FROM apps WHERE id = ? AND workspace_id = ?")
    .bind(c.req.param("id"), wsId(c))
    .first<AppRow>();
}

const rateOf = (c: Ctx) => new FxCache(c.var.db).perUsd(c.var.workspace!.currency, dayOf(now()));
const r2 = (n: number) => Math.round(n * 100) / 100;

offerRoutes.get("/apps/:id/offers", requirePermission("read"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  return c.json(await offerSettingsView(c.var.db, app));
});

/** Partial update: { offers?: [{ productId, offerId, label?, kind? }], strict? }. `offers` replaces the whole list. */
offerRoutes.put("/apps/:id/offers", requirePermission("manage"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "ios") return c.json({ error: "Promotional offers are App Store only: not available for Android (Google Play) or web (Polar) apps" }, 400);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected a JSON object" }, 400);
  const update = parseOfferUpdate(body);
  if ("error" in update) return c.json({ error: update.error }, 400);
  await saveOfferSettings(c.var.db, app.id, update);
  forgetOfferContext(app.sdk_key);
  return c.json(await offerSettingsView(c.var.db, app));
});

/** Adds the promotional and win-back offers of the app's subscriptions found in App Store Connect (App Store Connect API key). */
offerRoutes.post("/apps/:id/offers/import", requirePermission("manage"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "ios") return c.json({ error: "Promotional offers are App Store only: not available for Android (Google Play) or web (Polar) apps" }, 400);
  if (!app.apple_app_id) return c.json({ error: "The app has no App Store id: import it from App Store Connect first" }, 409);
  const cred = await getCredential(c.env, c.var.db, app.workspace_id, "appstore_connect");
  if (!cred) return c.json({ error: "Add an App Store Connect API key first", code: "not_configured" }, 409);
  const errors: string[] = [];
  let found: OfferEntry[] = [];
  try {
    const r = await new AppStoreConnectApi(cred).listSubscriptionOffers(app.apple_app_id);
    found = r.offers.map((o) => ({ productId: o.productId, offerId: o.offerId, label: o.name, kind: o.kind }));
    if (r.truncated) errors.push("Only the first 15 subscriptions were checked: add the other offers by hand");
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 502);
  }
  const current = await c.var.db.prepare("SELECT offers FROM offer_settings WHERE app_id = ?").bind(app.id).first<{ offers: string }>();
  const merged = mergeOffers(parseJson<OfferEntry[]>(current?.offers, []), found);
  await saveOfferSettings(c.var.db, app.id, { offers: merged.offers });
  forgetOfferContext(app.sdk_key);
  const result: OfferImportResult = { added: merged.added, found: found.length, settings: await offerSettingsView(c.var.db, app), errors };
  return c.json(result);
});

offerRoutes.get("/apps/:id/offers/log", requirePermission("read"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  return c.json({ items: await offerSignatureLog(c.var.db, app.id, Number(c.req.query("limit")) || 100) });
});

offerRoutes.get("/apps/:id/offers/stats", requirePermission("read"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  const { from, to } = range(c, 90);
  const r = await offerStats(c.env, { workspaceId: app.workspace_id, appId: app.id, from, to });
  const rate = await rateOf(c);
  const body: OfferStats = {
    ...r,
    currency: c.var.workspace!.currency,
    totals: { redemptions: r.totals.redemptions, revenue: r2(r.totals.revenue * rate), proceeds: r2(r.totals.proceeds * rate) },
    items: r.items.map((i) => ({ ...i, revenue: r2(i.revenue * rate), proceeds: r2(i.proceeds * rate) })),
  };
  return c.json(body);
});

/** Subscriptions expired in the last `days` (1 to 730, default 90) without auto-renew. */
offerRoutes.get("/apps/:id/lapsed", requirePermission("read"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  const days = Math.min(Math.max(Math.floor(Number(c.req.query("days") ?? 90)) || 90, 1), 730);
  const to = now();
  const r = await lapsedSubscribers(c.env, { workspaceId: app.workspace_id, appId: app.id, days, day: dayOf(to) });
  const rate = await rateOf(c);
  const body: LapsedSegment = { ...r, to, currency: c.var.workspace!.currency, items: r.items.map((i) => ({ ...i, totalPaid: r2(i.totalPaid * rate) })) };
  return c.json(body);
});
