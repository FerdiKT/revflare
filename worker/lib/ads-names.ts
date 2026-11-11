// Apple Ads names (campaign / ad group / keyword) per workspace: Revflare only learns ids from Apple's attribution API;
// names come from PUT /attribution/names (Adsflare fills them automatically, the CLI and the web app import them). Reads
// resolve them by primary key wherever Apple Ads ids are shown (feed, customer, attributed revenue, remote config
// pickers); clients show "#<id>" for ids without a name.
//
// Also: the acquisition of a purchase / customer (AdsAttribution), joined from install_links → attributions → names.

import { ADS_NAME_KINDS, ADS_NAMES_LIMIT, TEST_ATTRIBUTION_CAMPAIGN_ID, type AdsAttribution, type AdsName, type AdsNameKind, type AdsNamesUpdate } from "../../shared/types";
import { defineDbFunction, type Db } from "./db";
import { installSource } from "./test-data";
import { now } from "./util";

/** Ids per lookup statement (plus the workspace and the kind: ≤ 100 bound parameters). */
const LOOKUP_CHUNK = 90;
/** Rows per upsert statement (5 parameters each). */
const UPSERT_CHUNK = 20;
const NAME_MAX = 200;
const ID_RE = /^\d{1,20}$/;

/** Apple's AdServices test payload: campaign 1234567890 (ad group 1234567890, keyword 12323222). */
export const isTestAttribution = (campaignId: string | number | null | undefined) => campaignId !== null && campaignId !== undefined && String(campaignId) === TEST_ATTRIBUTION_CAMPAIGN_ID;

export const isAdsNameKind = (v: unknown): v is AdsNameKind => typeof v === "string" && (ADS_NAME_KINDS as readonly string[]).includes(v);

/** Names keyed `${kind}:${id}`. */
export type NameMap = Map<string, string>;
export const nameKey = (kind: AdsNameKind, id: string) => `${kind}:${id}`;

/** Names of these ids (batched, ≤ 92 parameters per statement). Ids that are not Apple Ads ids are skipped. */
export async function lookupNames(db: Db, workspaceId: string, ids: Partial<Record<AdsNameKind, Iterable<string | null | undefined>>>): Promise<NameMap> {
  const out: NameMap = new Map();
  const stmts = [];
  for (const kind of ADS_NAME_KINDS) {
    const list = [...new Set([...(ids[kind] ?? [])].filter((x): x is string => typeof x === "string" && ID_RE.test(x)))];
    for (let i = 0; i < list.length; i += LOOKUP_CHUNK) {
      const chunk = list.slice(i, i + LOOKUP_CHUNK);
      stmts.push(
        db
          .prepare(`SELECT kind, id, name FROM ads_names WHERE workspace_id = ? AND kind = ? AND id IN (${chunk.map(() => "?").join(",")})`)
          .bind(workspaceId, kind, ...chunk),
      );
    }
  }
  if (!stmts.length) return out;
  for (const r of await db.batch<{ kind: AdsNameKind; id: string; name: string }>(stmts)) for (const n of r.results ?? []) out.set(nameKey(n.kind, n.id), n.name);
  return out;
}

/** GET /attribution/names: every name of the workspace (campaigns, then ad groups, then keywords). */
export const listAdsNames = defineDbFunction("listAdsNames", async (db, args: { workspaceId: string }): Promise<{ names: AdsName[] }> => {
  const { results } = await db.prepare("SELECT kind, id, name FROM ads_names WHERE workspace_id = ?").bind(args.workspaceId).all<AdsName>();
  const order = (k: AdsNameKind) => ADS_NAME_KINDS.indexOf(k);
  return { names: results.sort((a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
});

/** Validates a PUT body: `{ names: [{ kind, id, name }] }`, at most ADS_NAMES_LIMIT; the last entry of an id wins. */
export function parseAdsNames(body: unknown): AdsName[] | { error: string } {
  const list = (body as { names?: unknown } | null)?.names;
  if (!Array.isArray(list)) return { error: "names must be a list of { kind, id, name }" };
  if (list.length > ADS_NAMES_LIMIT) return { error: `At most ${ADS_NAMES_LIMIT} names per request` };
  const out = new Map<string, AdsName>();
  for (const raw of list) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind.trim().toLowerCase().replace(/[\s_-]/g, "") : e.kind;
    if (!isAdsNameKind(kind)) return { error: `kind must be one of: ${ADS_NAME_KINDS.join(", ")} (got ${JSON.stringify(e.kind)})` };
    const id = typeof e.id === "number" && Number.isSafeInteger(e.id) ? String(e.id) : typeof e.id === "string" ? e.id.trim() : "";
    if (!ID_RE.test(id)) return { error: `${JSON.stringify(e.id)} is not an Apple Ads id (digits)` };
    if (e.name !== undefined && e.name !== null && typeof e.name !== "string") return { error: `name of ${kind} ${id} must be a string` };
    const name = typeof e.name === "string" ? e.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
    out.set(nameKey(kind, id), { kind, id, name });
  }
  return [...out.values()];
}

/**
 * PUT /attribution/names: upserts names (an empty name deletes). Reads the stored names of these ids first and writes
 * only rows that change (Adsflare re-sends the same names on every sync); statements stay under 100 parameters.
 */
export const putAdsNames = defineDbFunction("putAdsNames", async (db, args: { workspaceId: string; names: AdsName[] }): Promise<AdsNamesUpdate> => {
  const ids: Record<AdsNameKind, string[]> = { campaign: [], adgroup: [], keyword: [] };
  for (const n of args.names) ids[n.kind].push(n.id);
  const stored = await lookupNames(db, args.workspaceId, ids);
  const upserts = args.names.filter((n) => n.name && stored.get(nameKey(n.kind, n.id)) !== n.name);
  const deletes = args.names.filter((n) => !n.name && stored.has(nameKey(n.kind, n.id)));
  const t = now();
  const stmts = [];
  for (let i = 0; i < upserts.length; i += UPSERT_CHUNK) {
    const chunk = upserts.slice(i, i + UPSERT_CHUNK);
    stmts.push(
      db
        .prepare(
          `INSERT INTO ads_names (workspace_id, kind, id, name, updated_at) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}
           ON CONFLICT (workspace_id, kind, id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
        )
        .bind(...chunk.flatMap((n) => [args.workspaceId, n.kind, n.id, n.name, t])),
    );
  }
  for (const kind of ADS_NAME_KINDS) {
    const list = deletes.filter((n) => n.kind === kind).map((n) => n.id);
    for (let i = 0; i < list.length; i += LOOKUP_CHUNK) {
      const chunk = list.slice(i, i + LOOKUP_CHUNK);
      stmts.push(db.prepare(`DELETE FROM ads_names WHERE workspace_id = ? AND kind = ? AND id IN (${chunk.map(() => "?").join(",")})`).bind(args.workspaceId, kind, ...chunk));
    }
  }
  if (stmts.length) {
    await db.batch(stmts);
    // Cached reads that show names (remote config pickers) refresh.
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`data_version:${args.workspaceId}`, String(t)).run();
  }
  return { updated: upserts.length, deleted: deletes.length };
});

// Acquisition of purchases and customers ------------------------------------------------------------------------

/**
 * Joins from a transaction (alias `t`) to its install's attribution (`at`) and names (`nc`, `ng`, `nk`): install_links
 * by (app_id, original_transaction_id), else appAccountToken = install id; then primary-key probes only.
 */
export const TX_INSTALL_JOINS = `LEFT JOIN install_links l ON l.app_id = t.app_id AND l.original_transaction_id = t.original_transaction_id
  LEFT JOIN attributions at ON at.app_id = t.app_id AND at.install_id = COALESCE(l.install_id, lower(t.app_account_token))`;

export const TX_ATTRIBUTION_JOINS = `${TX_INSTALL_JOINS}
  LEFT JOIN ads_names nc ON nc.workspace_id = t.workspace_id AND nc.kind = 'campaign' AND nc.id = at.campaign_id AND at.attributed = 1
  LEFT JOIN ads_names ng ON ng.workspace_id = t.workspace_id AND ng.kind = 'adgroup' AND ng.id = at.ad_group_id AND at.attributed = 1
  LEFT JOIN ads_names nk ON nk.workspace_id = t.workspace_id AND nk.kind = 'keyword' AND nk.id = at.keyword_id AND at.attributed = 1`;

export const TX_ATTRIBUTION_COLUMNS = `at.install_id AS at_install, at.status AS at_status, at.attributed AS at_attributed, at.test_attribution AS at_test, at.referrer_source AS at_referrer,
  at.campaign_id AS at_campaign, at.ad_group_id AS at_ad_group, at.keyword_id AS at_keyword, nc.name AS at_campaign_name, ng.name AS at_ad_group_name, nk.name AS at_keyword_name`;

/** SQL: the acquisition source of the transaction's install (same rule as installSource) over TX_INSTALL_JOINS. */
export const TX_SOURCE_SQL = `CASE WHEN at.install_id IS NULL THEN 'unknown' WHEN at.attributed = 1 THEN 'apple_ads' WHEN at.referrer_source IN ('google_ads', 'referral') THEN at.referrer_source WHEN at.status = 'pending' THEN 'unknown' ELSE 'organic' END`;

export interface AttributionCols {
  at_install: string | null;
  at_status: string | null;
  at_attributed: number | null;
  at_test: number | null;
  /** Android installs: google_ads | referral | organic (Play Install Referrer). */
  at_referrer?: string | null;
  at_campaign: string | null;
  at_ad_group: string | null;
  at_keyword: string | null;
  at_campaign_name: string | null;
  at_ad_group_name: string | null;
  at_keyword_name: string | null;
}

export function toAdsAttribution(r: AttributionCols): AdsAttribution {
  const source = r.at_install ? installSource({ status: r.at_status, attributed: r.at_attributed, referrer_source: r.at_referrer }) : "unknown";
  const ads = source === "apple_ads";
  return {
    source,
    test: ads && !!r.at_test,
    campaignId: ads ? r.at_campaign : null,
    campaignName: ads ? r.at_campaign_name : null,
    adGroupId: ads ? r.at_ad_group : null,
    adGroupName: ads ? r.at_ad_group_name : null,
    keywordId: ads ? r.at_keyword : null,
    keywordName: ads ? r.at_keyword_name : null,
  };
}

/** The acquisition of a customer: the install of their first transaction whose install has an attribution row (index on customer_id, then primary-key probes). */
export async function customerAttribution(db: Db, customerId: string): Promise<AdsAttribution> {
  const row = await db
    .prepare(
      `SELECT ${TX_ATTRIBUTION_COLUMNS} FROM transactions t ${TX_ATTRIBUTION_JOINS}
       WHERE t.customer_id = ? AND at.install_id IS NOT NULL ORDER BY t.purchased_at, t.id LIMIT 1`,
    )
    .bind(customerId)
    .first<AttributionCols>();
  return toAdsAttribution(row ?? ({ at_install: null } as AttributionCols));
}

/** "Apple Ads · <ad group name or #id>" (the campaign when there is no ad group) for a push, or null (not Apple Ads, or test attribution). */
export function adsPushLabel(a: AdsAttribution | null): string | null {
  if (!a || a.source !== "apple_ads" || a.test) return null;
  const what = a.adGroupId ? (a.adGroupName ?? `#${a.adGroupId}`) : a.campaignId ? (a.campaignName ?? `#${a.campaignId}`) : null;
  return what ? `Apple Ads · ${what}` : "Apple Ads";
}

/** The acquisition of one purchase (by its original transaction id; appAccountToken links are in install_links too). */
export async function purchaseAttribution(db: Db, appId: string, originalTransactionId: string, appAccountToken?: string | null): Promise<AdsAttribution | null> {
  const row = await db
    .prepare(
      `SELECT ${TX_ATTRIBUTION_COLUMNS} FROM (SELECT ? AS app_id, ? AS original_transaction_id, ? AS app_account_token, (SELECT workspace_id FROM apps WHERE id = ?) AS workspace_id) t
       ${TX_ATTRIBUTION_JOINS}`,
    )
    .bind(appId, originalTransactionId, appAccountToken ?? null, appId)
    .first<AttributionCols>();
  return row?.at_install ? toAdsAttribution(row) : null;
}
