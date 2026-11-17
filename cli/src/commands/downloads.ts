// App Store downloads (Apple's Sales and Trends reports): first downloads, redownloads and updates per app, day,
// country and device, with what they turned into (trials, payers, revenue per download, Apple Ads share).

import { list, str } from "../args.js";
import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { c, fmtChange, fmtMoney, fmtNum, fmtPct, println, printJson, sparkline, table, type Column } from "../format.js";
import type { DownloadCounts, Downloads, DownloadWindow } from "../types.js";
import { APP_OPTION, CURRENCY_OPTION, positiveInt, RANGE_OPTIONS, rangeQuery, scopeQuery } from "./common.js";

export type DownloadsBy = "app" | "day" | "country" | "type" | "device";
const BY: Record<string, DownloadsBy> = { app: "app", apps: "app", day: "day", days: "day", country: "country", countries: "country", type: "type", types: "type", kind: "type", device: "device", devices: "device" };

export function parseDownloadsBy(s: string | undefined): DownloadsBy {
  if (!s) return "app";
  const b = BY[s.trim().toLowerCase()];
  if (!b) throw new UsageError(`Invalid --by "${s}": use app, day, country, type or device`);
  return b;
}

/** "1,234 (+12.3%)" for a 7 / 28 / 90-day window. */
export const windowCell = (w: DownloadWindow | undefined) => (w ? `${fmtNum(w.downloads)}${w.change === null ? "" : ` ${fmtChange(w.change)}`}` : "-");

const COUNT_COLUMNS: Column[] = [
  { header: "DOWNLOADS", align: "right" },
  { header: "PAID", align: "right" },
  { header: "REDOWNLOADS", align: "right" },
  { header: "UPDATES", align: "right" },
];
const counts = (r: DownloadCounts) => [fmtNum(r.downloads), r.paidDownloads ? fmtNum(r.paidDownloads) : c.gray("0"), fmtNum(r.redownloads), fmtNum(r.updates)];

export function downloadsReport(d: Downloads, by: DownloadsBy, limit?: number): string {
  const m = (n: number) => fmtMoney(n, d.currency);
  const t = d.totals;
  const lines: string[] = [];
  lines.push(`${c.bold("App Store downloads")}  ${d.from} → ${d.to}  ${c.gray(`Apple Sales and Trends, ${d.currency}`)}`);
  const prev = d.previous.downloads ? ` ${fmtChange(t.downloads / d.previous.downloads - 1)} vs previous` : "";
  lines.push(
    `${fmtNum(t.downloads)} first downloads${prev} (${fmtNum(t.paidDownloads)} paid) · ${fmtNum(t.redownloads)} redownloads · ${fmtNum(t.updates)} updates`,
  );
  lines.push(
    `→ ${fmtNum(t.trialsStarted)} trials (${fmtPct(t.downloadToTrial)}) · ${fmtNum(t.newPayers)} new payers (${fmtPct(t.downloadToPaid)}) · ${m(t.revenue)} revenue · RPD ${t.revenuePerDownload === null ? "-" : fmtMoney(t.revenuePerDownload, d.currency)}` +
      (t.appleAdsShare === null ? "" : ` · Apple Ads ${fmtNum(t.appleAdsDownloads)} (${fmtPct(t.appleAdsShare, 1)} of SDK apps' downloads)`),
  );
  lines.push(c.gray(`Windows to ${d.lastDay ?? "-"}: ${d.windows.map((w) => `${w.days}d ${windowCell(w)}`).join(" · ")}`));
  lines.push(`${c.gray("Daily")} ${sparkline(d.days.map((x) => x.downloads))}`);
  lines.push("");
  const cut = <T>(rows: T[]) => (limit ? rows.slice(0, limit) : rows);
  if (by === "app") {
    lines.push(
      table(
        [{ header: "APP", flex: true }, ...COUNT_COLUMNS, { header: "PREV", align: "right" }, { header: "7D", align: "right" }, { header: "28D", align: "right" }, { header: "90D", align: "right" }, { header: "→TRIAL", align: "right" }, { header: "→PAID", align: "right" }, { header: "RPD", align: "right" }, { header: "ADS", align: "right" }],
        cut(d.apps).map((a) => [
          a.appId ? a.name : c.gray(a.name),
          ...counts(a),
          fmtNum(a.previousDownloads),
          ...[7, 28, 90].map((n) => windowCell(a.windows.find((w) => w.days === n))),
          a.appId ? fmtPct(a.downloadToTrial, 1) : "-",
          a.appId ? fmtPct(a.downloadToPaid, 1) : "-",
          a.revenuePerDownload === null || !a.appId ? "-" : fmtMoney(a.revenuePerDownload, d.currency),
          a.appleAdsShare === null ? "-" : fmtPct(a.appleAdsShare, 0),
        ]),
      ),
    );
    if (d.apps.some((a) => !a.appId)) lines.push(c.gray("Gray: apps of the developer account that are not in Revflare (no conversions)."));
  } else if (by === "day") {
    lines.push(
      table(
        [{ header: "DAY" }, ...COUNT_COLUMNS, { header: "TRIALS", align: "right" }, { header: "PAYERS", align: "right" }, { header: "REVENUE", align: "right" }, { header: "RPD", align: "right" }, { header: "ADS", align: "right" }],
        cut([...d.days].reverse()).map((x) => [x.day, ...counts(x), fmtNum(x.trialsStarted), fmtNum(x.newPayers), m(x.revenue), x.revenuePerDownload === null ? "-" : fmtMoney(x.revenuePerDownload, d.currency), fmtNum(x.appleAdsDownloads)]),
      ),
    );
  } else if (by === "country") {
    const total = t.downloads || 1;
    lines.push(
      table(
        [{ header: "COUNTRY" }, ...COUNT_COLUMNS, { header: "SHARE", align: "right" }],
        cut(d.countries).map((x) => [x.country || "-", ...counts(x), fmtPct(x.downloads / total, 1)]),
      ),
    );
  } else if (by === "device") {
    lines.push(table([{ header: "DEVICE" }, ...COUNT_COLUMNS], cut(d.devices).map((x) => [x.device, ...counts(x)])));
  } else {
    const p = d.previous;
    lines.push(
      table(
        [{ header: "TYPE" }, { header: "UNITS", align: "right" }, { header: "PREVIOUS", align: "right" }, { header: "CHANGE", align: "right" }],
        (
          [
            ["First downloads", t.downloads, p.downloads],
            ["  free", t.downloads - t.paidDownloads, p.downloads - p.paidDownloads],
            ["  paid", t.paidDownloads, p.paidDownloads],
            ["Redownloads", t.redownloads, p.redownloads],
            ["Updates", t.updates, p.updates],
          ] as const
        ).map(([label, cur, before]) => [label, fmtNum(cur), fmtNum(before), before ? fmtChange(cur / before - 1) : "-"]),
      ),
    );
  }
  return lines.join("\n");
}

const NO_DATA =
  "No App Store downloads yet. Revflare reads them from Apple's Sales and Trends reports with an App Store Connect key\n" +
  "that has the Sales (or Finance / Admin) role and the vendor number. Import the last 90 days: revflare downloads sync";

export const downloadsCmd: Command = {
  name: "downloads",
  summary: "App Store downloads (Sales and Trends): first downloads, redownloads, updates by app, day, country, type or device; download → trial / paid, RPD.",
  description:
    "From Apple's Sales and Trends daily reports (report days are Pacific time, about a day behind: a preset --range ends at\n" +
    "the newest report day). First downloads = Product Type 1* / F1 (free + paid), redownloads 3* / F3, updates 7* / F7.\n" +
    "Conversions come from Revflare's own sales: trials started, new payers (first payment), revenue per download (RPD),\n" +
    "and Apple Ads installs RevflareKit attributed (ADS: share of the downloads of apps with RevflareKit installs).\n" +
    "Apps of the developer account that are not in Revflare count in the totals.",
  options: {
    ...RANGE_OPTIONS,
    by: { type: "string", short: "b", arg: "<app|day|country|type|device>", description: "Table to show (default app)" },
    ...APP_OPTION,
    ...CURRENCY_OPTION,
    limit: { type: "string", short: "l", arg: "<n>", description: "At most n rows" },
  },
  max: 1,
  examples: ["revflare downloads", "revflare downloads com.example.app --range 90d --by country", "revflare downloads --by day --range 7d", "revflare downloads --by device --json"],
  async run(ctx, { values, positionals }) {
    const by = parseDownloadsBy(str(values.by));
    const limit = positiveInt(str(values.limit), "limit");
    const extra = positionals[0] ? [positionals[0]] : [];
    const scope = await scopeQuery(ctx, { ...values, app: [...list(values.app), ...extra] });
    const q: Record<string, string | undefined> = { ...rangeQuery(values), ...scope };
    if (!q.range && !q.from) q.range = "28d";
    const d = await ctx.api.get<Downloads>("/downloads", q);
    if (ctx.json) return printJson(d);
    if (d.firstDay === null) return println(NO_DATA);
    println(downloadsReport(d, by, limit));
  },
};

export const downloadsSync: Command = {
  name: "downloads sync",
  summary: "Import the Sales and Trends days Revflare does not have yet (default the last 90 days) in the background.",
  options: { days: { type: "string", short: "d", arg: "<n>", description: "Days back (default 90, at most 365)" } },
  max: 0,
  async run(ctx, { values }) {
    const r = await ctx.api.post<{ id: string; reused: boolean }>("/downloads/sync", { days: positiveInt(str(values.days), "days", 90) });
    if (ctx.json) return printJson(r);
    println(`${c.green("✓")} Job ${r.id} ${r.reused ? "already running" : "started"}. Follow it: revflare jobs show ${r.id}`);
  },
};

