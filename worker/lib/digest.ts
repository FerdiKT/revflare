// The daily digest of a workspace and UTC day, stored in settings `digest:<workspace>:<day>` (JSON, kept 8 days) by the
// insights cron (worker/lib/insights.ts) in two passes: the ledger part in the first tick after 00:00 UTC (no Analytics
// Engine query; `eventsPending` when event metrics will follow), the event metrics from 00:30 UTC. Read by the 09:00
// summary push (one extra line) and the optional daily email (users who turned on `dailyDigestEmail`, only when Email
// Sending is configured, after both passes).
//
// Per app, for the day: revenue, proceeds, new paid subscriptions, trials started, trial conversions (daily_metrics,
// cheap) and, when app events are configured, installs (`first_open`) and paywall views (`paywall_view`) from one
// Analytics Engine query per workspace (up to 50 apps, 8 days: yesterday plus the 7-day average). Days are UTC days,
// event metrics included. Top movers: the apps whose revenue or installs moved most against their 7-day average.

import type { Db } from "./db";
import { emailLayout, escapeHtml } from "./email";
import { addDays } from "./money";
import { formatMoney } from "./push";
import { num } from "./wae";

export interface DigestApp {
  appId: string;
  name: string;
  revenueUsd: number;
  proceedsUsd: number;
  newSubscriptions: number;
  trialsStarted: number;
  trialConversions: number;
  /** Average revenue a day over the 7 days before. */
  avgRevenueUsd: number;
  /** null: no app events for this app (or analytics not configured). */
  installs: number | null;
  avgInstalls: number | null;
  paywallViews: number | null;
}

export interface DigestMover {
  appId: string;
  name: string;
  metric: "revenue" | "installs";
  value: number;
  average: number;
  /** Relative change against the 7-day average (0.25 = +25 %). */
  change: number;
}

export interface Digest {
  workspaceId: string;
  day: string;
  apps: DigestApp[];
  totals: {
    revenueUsd: number;
    proceedsUsd: number;
    newSubscriptions: number;
    trialsStarted: number;
    trialConversions: number;
    avgRevenueUsd: number;
    installs: number | null;
    avgInstalls: number | null;
    paywallViews: number | null;
  };
  movers: DigestMover[];
  /** Event metrics are included (analytics configured and queried). */
  events: boolean;
  /** Ledger part only so far: a later cron tick adds the event metrics. */
  eventsPending?: boolean;
  computedAt: number;
}

export interface LedgerRow {
  app_id: string;
  rev: number | null;
  proceeds: number | null;
  new_subs: number | null;
  trials: number | null;
  conversions: number | null;
  prev_rev: number | null;
}

/** Per app → per day → event name → count (weighted by the sample interval). */
export type DigestEvents = Map<string, Map<string, Record<string, number>>>;

export const digestKey = (workspaceId: string, day: string) => `digest:${workspaceId}:${day}`;

/** Analytics Engine digest rows (wae.ts digestSql) → DigestEvents. */
export function digestEventsOf(rows: Record<string, unknown>[]): DigestEvents {
  const out: DigestEvents = new Map();
  for (const r of rows) {
    const app = String(r.app ?? "");
    const day = String(r.day ?? "").slice(0, 10);
    const name = String(r.name ?? "");
    if (!app || !day || !name) continue;
    let days = out.get(app);
    if (!days) out.set(app, (days = new Map()));
    const d = days.get(day) ?? {};
    d[name] = (d[name] ?? 0) + Math.round(num(r.events));
    days.set(day, d);
  }
  return out;
}

const MIN_AVG_REVENUE = 10;
const MIN_AVG_INSTALLS = 20;

/** Pure: the digest of one workspace and day. `events` null: no event metrics. */
export function assembleDigest(input: {
  workspaceId: string;
  day: string;
  apps: { id: string; name: string }[];
  ledger: LedgerRow[];
  events: DigestEvents | null;
  /** Apps whose events were queried (others get null event metrics). */
  eventApps: string[];
  at: number;
  /** Ledger-only pass: event metrics follow. */
  eventsPending?: boolean;
}): Digest {
  const ledger = new Map(input.ledger.map((r) => [r.app_id, r]));
  const prevDays = Array.from({ length: 7 }, (_, i) => addDays(input.day, -(i + 1)));
  const apps: DigestApp[] = [];
  for (const a of input.apps) {
    const l = ledger.get(a.id);
    const queried = !!input.events && input.eventApps.includes(a.id);
    const ev = input.events?.get(a.id);
    const installs = queried ? (ev?.get(input.day)?.first_open ?? 0) : null;
    const avgInstalls = queried ? prevDays.reduce((s, d) => s + (ev?.get(d)?.first_open ?? 0), 0) / 7 : null;
    const paywallViews = queried ? (ev?.get(input.day)?.paywall_view ?? 0) : null;
    const app: DigestApp = {
      appId: a.id,
      name: a.name,
      revenueUsd: l?.rev ?? 0,
      proceedsUsd: l?.proceeds ?? 0,
      newSubscriptions: l?.new_subs ?? 0,
      trialsStarted: l?.trials ?? 0,
      trialConversions: l?.conversions ?? 0,
      avgRevenueUsd: (l?.prev_rev ?? 0) / 7,
      installs,
      avgInstalls,
      paywallViews,
    };
    const empty = !app.revenueUsd && !app.avgRevenueUsd && !app.newSubscriptions && !app.trialsStarted && !app.installs && !app.avgInstalls && !app.paywallViews;
    if (!empty) apps.push(app);
  }
  apps.sort((a, b) => b.revenueUsd - a.revenueUsd || (b.installs ?? 0) - (a.installs ?? 0) || a.name.localeCompare(b.name));
  const sum = (f: (a: DigestApp) => number) => apps.reduce((s, a) => s + f(a), 0);
  const withEvents = apps.filter((a) => a.installs !== null);
  const anyEvents = !!input.events && input.eventApps.length > 0;
  const movers: DigestMover[] = [];
  for (const a of apps) {
    if (a.avgRevenueUsd >= MIN_AVG_REVENUE)
      movers.push({ appId: a.appId, name: a.name, metric: "revenue", value: a.revenueUsd, average: a.avgRevenueUsd, change: a.revenueUsd / a.avgRevenueUsd - 1 });
    if (a.installs !== null && a.avgInstalls !== null && a.avgInstalls >= MIN_AVG_INSTALLS)
      movers.push({ appId: a.appId, name: a.name, metric: "installs", value: a.installs, average: a.avgInstalls, change: a.installs / a.avgInstalls - 1 });
  }
  movers.sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
  return {
    workspaceId: input.workspaceId,
    day: input.day,
    apps,
    totals: {
      revenueUsd: sum((a) => a.revenueUsd),
      proceedsUsd: sum((a) => a.proceedsUsd),
      newSubscriptions: sum((a) => a.newSubscriptions),
      trialsStarted: sum((a) => a.trialsStarted),
      trialConversions: sum((a) => a.trialConversions),
      avgRevenueUsd: sum((a) => a.avgRevenueUsd),
      installs: anyEvents ? withEvents.reduce((s, a) => s + (a.installs ?? 0), 0) : null,
      avgInstalls: anyEvents ? withEvents.reduce((s, a) => s + (a.avgInstalls ?? 0), 0) : null,
      paywallViews: anyEvents ? withEvents.reduce((s, a) => s + (a.paywallViews ?? 0), 0) : null,
    },
    movers: movers.filter((m) => Math.abs(m.change) >= 0.1).slice(0, 3),
    events: anyEvents,
    ...(input.eventsPending ? { eventsPending: true } : {}),
    computedAt: input.at,
  };
}

export async function readDigest(db: Db, workspaceId: string, day: string): Promise<Digest | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(digestKey(workspaceId, day)).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as Digest;
  } catch {
    return null;
  }
}

/** "1.2K" (locale-aware compact number). */
export function compactNumber(n: number, locale = "en"): string {
  try {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(Math.round(n));
  } catch {
    return String(Math.round(n));
  }
}

/** "+8%" / "−12%" against an average, "" when there is none. */
export function changeLabel(value: number, average: number | null): string {
  if (!average) return "";
  const c = Math.round((value / average - 1) * 100);
  return `${c >= 0 ? "+" : "−"}${Math.abs(c)}%`;
}

/** "Oct 21: " (locale-aware), the summary line's label when its digest is not of the day the summary covers. */
export function dayLabel(day: string, locale = "en"): string {
  const d = new Date(`${day}T00:00:00Z`);
  try {
    return `${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(d)}: `;
  } catch {
    return `${day}: `;
  }
}

/**
 * The summary push's extra line: installs (change vs the 7-day average) and trials, from the first of `digests` (newest
 * first: the summary's day, then older ones) that has event metrics. A device whose "yesterday" has no digest with
 * events yet (time zones east of UTC, the event pass still pending) gets the latest one, labelled with its UTC day.
 * null when none has event metrics.
 */
export function digestPushLine(digests: (Digest | null)[], day: string, locale = "en"): { installs: string; change: string; trials: string; label: string } | null {
  const d = digests.find((x) => !!x?.events && x.totals.installs !== null);
  if (!d || d.totals.installs === null) return null;
  const change = changeLabel(d.totals.installs, d.totals.avgInstalls);
  return {
    installs: compactNumber(d.totals.installs, locale),
    change: change ? ` (${change})` : "",
    trials: String(d.totals.trialsStarted),
    label: d.day === day ? "" : dayLabel(d.day, locale),
  };
}

// --- Email -----------------------------------------------------------------------------------------------------------

export interface DigestSection {
  workspaceName: string;
  currency: string;
  /** Workspace currency per USD. */
  rate: number;
  digest: Digest;
}

/** Subject, plain text and HTML of a user's daily digest (one section per workspace). */
export function digestEmail(day: string, sections: DigestSection[], link: string) {
  const subject = `Revflare daily digest · ${day}`;
  const money = (s: DigestSection, usd: number) => formatMoney(usd * s.rate, s.currency);
  const text: string[] = [`Revflare daily digest for ${day} (UTC)`, ""];
  const html: string[] = [];
  const cell = "padding:4px 8px;font-size:13px;border-bottom:1px solid #f4f4f5";
  const th = "padding:4px 8px;font-size:11px;color:#71717a;text-align:left;font-weight:600";
  for (const s of sections) {
    const t = s.digest.totals;
    const events = s.digest.events && t.installs !== null;
    const line = [
      `Revenue ${money(s, t.revenueUsd)}${t.avgRevenueUsd ? ` (${changeLabel(t.revenueUsd, t.avgRevenueUsd)} vs 7-day avg)` : ""}`,
      `proceeds ${money(s, t.proceedsUsd)}`,
      `new subscriptions ${t.newSubscriptions}`,
      `trials ${t.trialsStarted}`,
      `trial conversions ${t.trialConversions}`,
      ...(events ? [`installs ${t.installs}${t.avgInstalls ? ` (${changeLabel(t.installs!, t.avgInstalls)})` : ""}`, `paywall views ${t.paywallViews ?? 0}`] : []),
    ];
    text.push(s.workspaceName, line.join(", "));
    for (const a of s.digest.apps)
      text.push(
        `  ${a.name}: ${money(s, a.revenueUsd)} revenue, ${money(s, a.proceedsUsd)} proceeds, ${a.newSubscriptions} new subs, ${a.trialsStarted} trials${a.installs !== null ? `, ${a.installs} installs, ${a.paywallViews ?? 0} paywall views` : ""}`,
      );
    if (s.digest.movers.length) {
      text.push("  Top movers:");
      for (const m of s.digest.movers)
        text.push(`  - ${m.name}: ${m.metric === "revenue" ? money(s, m.value) : m.value} ${m.metric} (${changeLabel(m.value, m.average)} vs 7-day avg)`);
    }
    text.push("");

    const rows = s.digest.apps
      .map(
        (a) =>
          `<tr><td style="${cell}">${escapeHtml(a.name)}</td><td style="${cell}">${escapeHtml(money(s, a.revenueUsd))}</td><td style="${cell}">${escapeHtml(money(s, a.proceedsUsd))}</td><td style="${cell}">${a.newSubscriptions}</td><td style="${cell}">${a.trialsStarted}</td>${events ? `<td style="${cell}">${a.installs ?? "–"}</td><td style="${cell}">${a.paywallViews ?? "–"}</td>` : ""}</tr>`,
      )
      .join("");
    const movers = s.digest.movers.length
      ? `<tr><td style="padding-top:12px;font-size:13px"><b>Top movers</b><br>${s.digest.movers
          .map((m) => `${escapeHtml(m.name)}: ${escapeHtml(m.metric === "revenue" ? money(s, m.value) : String(m.value))} ${m.metric} (${escapeHtml(changeLabel(m.value, m.average))} vs 7-day avg)`)
          .join("<br>")}</td></tr>`
      : "";
    html.push(`<tr><td style="padding-top:20px;font-size:15px;font-weight:600">${escapeHtml(s.workspaceName)}</td></tr>
<tr><td style="padding-top:4px;font-size:13px;color:#52525b">${escapeHtml(line.join(" · "))}</td></tr>
<tr><td style="padding-top:8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><th style="${th}">App</th><th style="${th}">Revenue</th><th style="${th}">Proceeds</th><th style="${th}">New subs</th><th style="${th}">Trials</th>${events ? `<th style="${th}">Installs</th><th style="${th}">Paywall views</th>` : ""}</tr>${rows}</table></td></tr>${movers}`);
  }
  text.push(`Open Revflare: ${link}`, "", "You get this email because you turned on the daily digest in Revflare (Settings → Account).");
  return {
    subject,
    text: text.join("\n"),
    html: emailLayout(
      `Yesterday (${escapeHtml(day)}, UTC)`,
      `${html.join("\n")}<tr><td style="padding:20px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#f95716;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:10px">Open Revflare</a></td></tr>`,
      "You get this email because you turned on the daily digest in Revflare (Settings → Account).",
      640,
    ),
  };
}
