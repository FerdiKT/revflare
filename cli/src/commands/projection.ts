import { str } from "../args.js";
import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { c, fmtDate, fmtMoney, fmtPct, println, printJson, table } from "../format.js";
import type { Projection, ProjectionBand, ProjectionHorizon, ProjectionSummary } from "../types.js";
import { APP_OPTION, CURRENCY_OPTION, scopeQuery } from "./common.js";

const HORIZONS: ProjectionHorizon[] = ["d30", "d90", "d365"];
const STAGE_LABELS: Record<string, string> = { trial: "trial → paid", intro: "intro → full price", r1: "1st renewal", r2: "2nd renewal", r3: "3rd+ renewal" };

/** "$1,234 ($1,100 – $1,380)". */
export function fmtBand(b: ProjectionBand, currency: string): string {
  return `${fmtMoney(b.expected, currency)} ${c.gray(`(${fmtMoney(b.low, currency)} – ${fmtMoney(b.high, currency)})`)}`;
}

const signedPct = (x: number | null) => (x === null ? "-" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`);

export const projection: Command = {
  name: "projection",
  summary: "Revenue projection for the next 30 / 90 / 365 days: renewals of today's subscriptions, new subscribers, one-time purchases, MRR, bands and backtest.",
  description:
    "Expected proceeds (after refunds and Apple's commission, in the workspace currency) of today's subscriptions — each one's\n" +
    "renewals chained with the measured renewal rate of its app, billing period and renewal order (trial conversion, 1st, 2nd,\n" +
    "3rd+), auto-renew off / billing retry weighted apart — plus new subscribers and one-time purchases at the last 28 days'\n" +
    "pace. Bands: 5th–95th percentile of draws of the measured rates. Segments with fewer than 30 renewals lean on the\n" +
    "portfolio. Backtest: the model run as of 30 and 60 days ago against what happened. Computed once a day per scope.",
  options: {
    ...APP_OPTION,
    ...CURRENCY_OPTION,
    summary: { type: "boolean", description: "Only the overview line: next 30 days and the change since yesterday" },
    segments: { type: "boolean", description: "Every renewal-rate segment (default: only the ones with little data)" },
    upcoming: { type: "string", arg: "<n>", description: "Upcoming long renewals listed (default 10)" },
  },
  max: 0,
  examples: ["revflare projection", "revflare projection --app com.example.app", "revflare projection --summary --json"],
  async run(ctx, { values }) {
    const q = await scopeQuery(ctx, values);
    if (values.summary) {
      const s = await ctx.api.get<ProjectionSummary>("/projection/summary", q);
      if (ctx.json) return printJson(s);
      const change = s.next30Change === null ? "" : c.gray(` (${s.next30Change >= 0 ? "+" : "−"}${fmtMoney(Math.abs(s.next30Change), s.currency)} since yesterday)`);
      return println(`Next 30 days: ${fmtBand(s.next30Band, s.currency)} expected proceeds${change}`);
    }
    const p = await ctx.api.get<Projection>("/projection", q);
    if (ctx.json) return printJson(p);
    const m = (n: number) => fmtMoney(n, p.currency);
    println(`${c.bold("Revenue projection")}  ${c.gray(`from ${p.from} · proceeds after refunds and commission, ${p.currency} · bands 5–95%`)}`);
    println(
      table(
        [
          { header: "HORIZON" },
          { header: "EXISTING SUBSCRIBERS", align: "right" },
          { header: "WITH NEW + ONE-TIME", align: "right" },
          { header: "RENEWALS", align: "right" },
          { header: "NEW SUBS", align: "right" },
          { header: "ONE-TIME", align: "right" },
          { header: "GROSS", align: "right" },
          { header: "MRR AT END", align: "right" },
        ],
        HORIZONS.map((h) => {
          const t = p.totals[h];
          return [`${h.slice(1)} days`, fmtBand(t.existing, p.currency), fmtBand(t.withNew, p.currency), m(t.components.renewals), m(t.components.newSubscribers), m(t.components.oneTime), m(t.withNewGross), m(t.mrrWithNew.expected)];
        }),
      ),
    );
    const i = p.inputs;
    println(
      c.gray(
        `MRR now ${m(p.summary.mrrNow)} · ${i.activeSubscriptions} active subscriptions (${i.trials} trials, ${i.autoRenewOff} auto-renew off, ${i.billingRetry} billing retry, ${i.grace} grace) · ` +
          `${i.newStartsPerDay.toFixed(1)} new subscriptions a day · ${m(i.oneTimePerDay)} one-time a day`,
      ),
    );
    if (p.backtest.length) {
      println("");
      println(c.bold("Backtest") + c.gray(` (mean absolute error: ${p.backtestError.withNew === null ? "-" : fmtPct(p.backtestError.withNew, 1)} with new subscribers, ${p.backtestError.existing === null ? "-" : fmtPct(p.backtestError.existing, 1)} existing only)`));
      println(
        table(
          [{ header: "AS OF" }, { header: "DAYS", align: "right" }, { header: "PREDICTED", align: "right" }, { header: "ACTUAL", align: "right" }, { header: "ERROR", align: "right" }, { header: "EXISTING PREDICTED", align: "right" }, { header: "ACTUAL", align: "right" }, { header: "ERROR", align: "right" }],
          p.backtest.map((b) => [
            b.asOf,
            b.days,
            fmtBand(b.withNew.predicted, p.currency),
            m(b.withNew.actual),
            signedPct(b.withNew.error) + (b.withNew.inBand ? "" : c.yellow(" ✗")),
            fmtBand(b.existing.predicted, p.currency),
            m(b.existing.actual),
            signedPct(b.existing.error) + (b.existing.inBand ? "" : c.yellow(" ✗")),
          ]),
        ),
      );
    }
    if (p.apps.length > 1) {
      println("");
      println(
        table(
          [{ header: "APP", max: 32 }, { header: "MRR NOW", align: "right" }, { header: "30 DAYS", align: "right" }, { header: "90 DAYS", align: "right" }, { header: "365 DAYS", align: "right" }],
          p.apps.slice(0, 15).map((a) => [a.name, m(a.mrrNow), m(a.totals.d30.withNew.expected), m(a.totals.d90.withNew.expected), m(a.totals.d365.withNew.expected)]),
        ),
      );
    }
    const n = values.upcoming === undefined ? 10 : Number(str(values.upcoming));
    if (!Number.isInteger(n) || n < 0) throw new UsageError("--upcoming must be a whole number");
    if (p.upcoming.count && n) {
      println("");
      println(c.bold("Upcoming long renewals") + c.gray(` (next 90 days: ${p.upcoming.count}, ${m(p.upcoming.price)} full price, ${m(p.upcoming.expectedProceeds)} expected proceeds)`));
      println(
        table(
          [{ header: "DATE" }, { header: "APP", max: 24 }, { header: "PRODUCT", max: 32 }, { header: "PRICE", align: "right" }, { header: "P(RENEW)", align: "right" }, { header: "EXPECTED", align: "right" }, { header: "STATUS" }],
          p.upcoming.items.slice(0, n).map((u) => [fmtDate(u.date).slice(0, 10), u.appName ?? u.appId, u.productId, m(u.price), fmtPct(u.probability, 0), m(u.expectedProceeds), u.status === "on" ? "auto-renew" : c.yellow(u.status)]),
        ),
      );
    }
    const segs = values.segments ? p.segments : p.segments.filter((s) => s.lowData);
    if (segs.length) {
      println("");
      println(c.bold(values.segments ? "Renewal rates" : "Segments with little data") + c.gray(" (fewer than 30 renewals: rate leans on the portfolio)"));
      println(
        table(
          [{ header: "APP", max: 24 }, { header: "PERIOD" }, { header: "STAGE" }, { header: "RENEWED", align: "right" }, { header: "OBSERVED", align: "right" }, { header: "RATE USED", align: "right" }, { header: "95%" }, { header: "SOURCE" }],
          segs.slice(0, values.segments ? 200 : 20).map((s) => [
            s.appName ?? s.appId,
            s.period,
            STAGE_LABELS[s.stage] ?? s.stage,
            `${s.renewed}/${s.observed}`,
            s.observedRate === null ? "-" : fmtPct(s.observedRate, 1),
            fmtPct(s.rate, 1),
            c.gray(`${fmtPct(s.low, 0)}–${fmtPct(s.high, 0)}`),
            s.lowData ? c.yellow(s.source) : s.source,
          ]),
        ),
      );
    }
    for (const note of p.notes) println(c.gray(`- ${note}`));
  },
};
