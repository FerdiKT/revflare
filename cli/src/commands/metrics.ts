import { str } from "../args.js";
import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { bar, c, fmtChange, fmtDate, fmtMoney, fmtPct, fmtValue, println, printJson, sparkline, table, truncate } from "../format.js";
import type { AtRisk, Breakdown, Chart, Cohorts, Forecast, MrrMovement, Overview, RevenueDaily } from "../types.js";
import { APP_OPTION, CURRENCY_OPTION, INTERVAL_OPTION, RANGE_OPTIONS, intervalQuery, parseMetric, positiveInt, rangeQuery, scopeQuery } from "./common.js";

/** Metrics where a rise is bad news. */
const INVERTED = new Set(["churn_rate", "churned_subscriptions", "refunds", "refunds_amount", "refund_rate"]);

export const overview: Command = {
  name: "overview",
  summary: "Today, the KPIs (MRR, revenue, actives, trials, conversion, churn) with 28-day trends, movement, risk, goals.",
  options: { ...APP_OPTION, ...CURRENCY_OPTION },
  max: 0,
  examples: ["revflare overview", "revflare overview --app com.example.app --json"],
  async run(ctx, { values }) {
    const o = await ctx.api.get<Overview>("/overview", await scopeQuery(ctx, values));
    if (ctx.json) return printJson(o);
    const m = (n: number | null | undefined) => fmtMoney(n, o.currency);
    println(`${c.bold("Today")} ${c.gray(o.today.date)}  ${c.bold(m(o.today.revenue))} revenue, ${m(o.today.proceeds)} proceeds  ${c.gray(`${o.today.sales} sales · ${o.today.newSubscriptions} new subs · ${o.today.trialsStarted} trials · ${o.today.refunds} refunds`)}`);
    println(`${c.bold("Yesterday")}  ${m(o.yesterday.revenue)} revenue, ${m(o.yesterday.proceeds)} proceeds  ${c.gray(`${o.yesterday.sales} sales`)}`);
    println("");
    println(
      table(
        [{ header: "KPI" }, { header: "VALUE", align: "right" }, { header: "CHANGE", align: "right" }, { header: "TREND" }],
        o.kpis.map((k) => [k.label, fmtValue(k.value, k.format, o.currency), fmtChange(k.change, INVERTED.has(k.metric)), c.cyan(sparkline(k.spark))]),
      ),
    );
    const mv = o.mrrMovement;
    println("");
    println(
      `${c.bold("MRR movement (28d)")}  new ${c.green(m(mv.new))}  expansion ${c.green(m(mv.expansion))}  reactivation ${c.green(m(mv.reactivation))}  contraction ${c.red(m(-Math.abs(mv.contraction)))}  churn ${c.red(m(-Math.abs(mv.churn)))}  net ${c.bold(m(mv.net))}`,
    );
    println(`${c.bold("At risk")}  ${m(o.atRisk.mrr)} MRR in ${o.atRisk.subscriptions} subscriptions   ${c.bold("30-day forecast")}  ${m(o.forecast30)}`);
    const rec = o.records;
    if (rec.bestDay || rec.bestMonth) {
      println(
        `${c.bold("Records")}  ${rec.bestDay ? `best day ${m(rec.bestDay.revenue)} (${rec.bestDay.date})` : ""}${rec.bestMonth ? `  best month ${m(rec.bestMonth.revenue)} (${rec.bestMonth.date.slice(0, 7)})` : ""}${rec.todayIsRecord ? c.green("  today is a record!") : ""}`,
      );
    }
    if (o.goals.length) {
      println("", c.bold("Goals"));
      const gv = (g: (typeof o.goals)[number], n: number | null | undefined) => (g.format === "count" ? fmtValue(n === null || n === undefined ? n : Math.round(n), "count", o.currency) : m(n));
      println(
        table(
          [{ header: "GOAL", flex: true }, { header: "PERIOD" }, { header: "CURRENT", align: "right" }, { header: "TARGET", align: "right" }, { header: "PROGRESS" }, { header: "PACE" }, { header: "PROJECTED", align: "right" }],
          o.goals.map((g) => [
            g.label ?? `${g.metric}${g.appId ? c.gray(` (${g.appId})`) : ""}`,
            g.period === "custom" ? `${g.periodStart} → ${g.periodEnd}` : g.periodLabel,
            gv(g, g.current),
            gv(g, g.target),
            `${bar(Math.min(1, g.progress), 12)} ${fmtPct(g.progress, 0)}`,
            g.pace ? g.pace.replace("_", " ") : "",
            g.kind === "stock" || g.metric === "mrr" ? "" : gv(g, g.projected),
          ]),
        ),
      );
    }
    if (o.topApps.length) {
      println("", c.bold("Top apps (28d)"));
      println(
        table(
          [{ header: "APP", flex: true }, { header: "REVENUE 28D", align: "right" }, { header: "MRR", align: "right" }, { header: "CHANGE", align: "right" }],
          o.topApps.map((a) => [a.name, m(a.revenue28d), m(a.mrr), fmtChange(a.change)]),
        ),
      );
    }
    const open = o.alerts.filter((a) => !a.resolvedAt);
    if (open.length) {
      println("", c.bold("Open alerts"));
      for (const a of open) println(`  ${a.severity === "critical" ? c.red("●") : a.severity === "warning" ? c.yellow("●") : c.blue("●")} ${a.title} ${c.gray(fmtDate(a.createdAt))}`);
    }
  },
};

export const chart: Command = {
  name: "chart",
  args: "<metric>",
  summary: "A metric over time (revenue, proceeds, mrr, arr, active_subscriptions, trials_started, churn_rate...).",
  description:
    "Metrics: revenue, proceeds, mrr, mrr_proceeds, arr, active_subscriptions, active_trials, new_subscriptions, renewals,\n" +
    "one_time_purchases, trials_started, trial_conversions, trial_conversion_rate, refunds, refunds_amount, refund_rate,\n" +
    "churn_rate, churned_subscriptions, new_customers, arppu. Rates are fractions (shown as %). Days marked * come from\n" +
    "imported history (RevenueCat Charts) instead of Revflare's own transactions.",
  options: {
    ...RANGE_OPTIONS,
    ...INTERVAL_OPTION,
    "group-by": { type: "string", short: "g", arg: "<app|country|product>", description: "Split into series (top groups + other)" },
    ...APP_OPTION,
    ...CURRENCY_OPTION,
  },
  min: 1,
  max: 1,
  examples: ["revflare chart revenue --range 90d", "revflare chart mrr --range all --interval month", "revflare chart revenue --range 30d --group-by country", "revflare chart churn_rate --range 12m --app com.example.app"],
  async run(ctx, { values, positionals }) {
    const metric = parseMetric(positionals[0], "revenue");
    const groupBy = str(values["group-by"]);
    if (groupBy && !["app", "country", "product"].includes(groupBy)) throw new UsageError("--group-by must be app, country or product");
    const ch = await ctx.api.get<Chart>(`/charts/${metric}`, { ...rangeQuery(values), interval: intervalQuery(values), groupBy, ...(await scopeQuery(ctx, values)) });
    if (ctx.json) return printJson(ch);
    const v = (n: number) => fmtValue(n, ch.format, ch.currency, { compact: true });
    const imported = (d: string) => (ch.importedUntil && d <= ch.importedUntil ? c.gray("*") : "");
    println(`${c.bold(metric)}  ${ch.from} → ${ch.to}  ${c.gray(`by ${ch.interval}${ch.format === "money" ? `, ${ch.currency}` : ""}`)}`);
    if (ch.series?.length) {
      const series = ch.series.slice(0, 8);
      const byDate = series.map((s) => new Map(s.points.map((p) => [p.date, p.value])));
      println(
        table(
          [{ header: "DATE" }, ...series.map((s) => ({ header: truncate(s.label, 18), align: "right" as const })), { header: "TOTAL", align: "right" }],
          ch.points.map((p) => [p.date + imported(p.date), ...byDate.map((m) => v(m.get(p.date) ?? 0)), v(p.value)]),
        ),
      );
    } else {
      const max = Math.max(...ch.points.map((p) => Math.abs(p.value)), 0);
      println(table([{ header: "DATE" }, { header: "VALUE", align: "right" }, { header: "" }], ch.points.map((p) => [p.date + imported(p.date), v(p.value), max ? bar(Math.abs(p.value) / max, 30) : ""])));
    }
    const prev = ch.previousTotal;
    const change = prev ? (ch.total - prev) / Math.abs(prev) : null;
    println("");
    println(`${c.bold("Total")} ${fmtValue(ch.total, ch.format, ch.currency)}${prev !== null ? `  ${c.gray(`previous ${fmtValue(prev, ch.format, ch.currency)}`)} ${fmtChange(change, INVERTED.has(metric))}` : ""}`);
    if (ch.importedUntil) println(c.gray(`* includes imported history (RevenueCat) up to ${ch.importedUntil}`));
  },
};

export const breakdown: Command = {
  name: "breakdown",
  summary: "A metric split by app, country or product (stock metrics such as MRR use the current snapshot).",
  options: {
    by: { type: "string", short: "b", arg: "<app|country|product>", description: "Dimension (required)" },
    metric: { type: "string", short: "m", arg: "<metric>", description: "Metric (default revenue)" },
    limit: { type: "string", short: "n", arg: "<n>", description: "Rows (default 50)" },
    ...RANGE_OPTIONS,
    ...APP_OPTION,
    ...CURRENCY_OPTION,
  },
  max: 0,
  examples: ["revflare breakdown --by country --range 28d", "revflare breakdown --by app --metric mrr", "revflare breakdown --by product --metric new_subscriptions --range 90d"],
  async run(ctx, { values }) {
    const by = str(values.by);
    if (by !== "app" && by !== "country" && by !== "product") throw new UsageError("--by app|country|product is required");
    const metric = parseMetric(str(values.metric), "revenue");
    const b = await ctx.api.get<Breakdown>("/breakdown", { by, metric, limit: positiveInt(str(values.limit), "limit"), ...rangeQuery(values), ...(await scopeQuery(ctx, values)) });
    if (ctx.json) return printJson(b);
    const format = /revenue|proceeds|mrr|arr|amount|arppu/.test(metric) ? "money" : /rate/.test(metric) ? "percent" : "count";
    println(`${c.bold(metric)} by ${by}  ${b.from} → ${b.to}${format === "money" ? c.gray(`  ${b.currency}`) : ""}`);
    println(
      table(
        [{ header: by.toUpperCase(), flex: true }, { header: "VALUE", align: "right" }, { header: "SHARE", align: "right" }, { header: "" }],
        b.rows.map((r) => [by === "country" ? `${r.key}${r.label && r.label !== r.key ? ` ${c.gray(r.label)}` : ""}` : r.label || r.key, fmtValue(r.value, format, b.currency), fmtPct(r.share, 1), bar(r.share, 20)]),
      ),
    );
  },
};

export const mrrMovement: Command = {
  name: "mrr-movement",
  summary: "MRR movement per period: new, expansion, reactivation, contraction, churn, net and MRR.",
  options: { ...RANGE_OPTIONS, ...INTERVAL_OPTION, ...APP_OPTION, ...CURRENCY_OPTION },
  max: 0,
  examples: ["revflare mrr-movement", "revflare mrr-movement --range 90d --interval week"],
  async run(ctx, { values }) {
    const mv = await ctx.api.get<MrrMovement>("/mrr-movement", { ...rangeQuery(values), interval: intervalQuery(values), ...(await scopeQuery(ctx, values)) });
    if (ctx.json) return printJson(mv);
    const m = (n: number) => fmtMoney(n, mv.currency, { compact: true });
    println(c.gray(`by ${mv.interval}, ${mv.currency}`));
    println(
      table(
        ["DATE", "NEW", "EXPANSION", "REACTIVATION", "CONTRACTION", "CHURN", "NET", "MRR"].map((h, i) => ({ header: h, align: i ? ("right" as const) : ("left" as const) })),
        mv.points.map((p) => [p.date, m(p.new), m(p.expansion), m(p.reactivation), m(-Math.abs(p.contraction)), m(-Math.abs(p.churn)), p.net >= 0 ? c.green(m(p.net)) : c.red(m(p.net)), m(p.mrr)]),
      ),
    );
  },
};

export const atRisk: Command = {
  name: "at-risk",
  summary: "Subscriptions that will not renew unless something changes: billing retry, grace period, auto-renew off.",
  options: { limit: { type: "string", short: "n", arg: "<n>", description: "Subscriptions listed (default 100)" }, ...APP_OPTION, ...CURRENCY_OPTION },
  max: 0,
  async run(ctx, { values }) {
    const r = await ctx.api.get<AtRisk>("/at-risk", { limit: positiveInt(str(values.limit), "limit"), ...(await scopeQuery(ctx, values)) });
    if (ctx.json) return printJson(r);
    const m = (n: number) => fmtMoney(n, r.currency);
    println(`${c.bold(m(r.mrr))} MRR at risk`);
    for (const g of r.groups) println(`  ${g.label.padEnd(24)} ${m(g.mrr).padStart(12)}  ${c.gray(`${g.subscriptions} subscriptions`)}`);
    if (!r.items.length) return;
    println("");
    println(
      table(
        [{ header: "APP", flex: true }, { header: "PRODUCT", flex: true }, { header: "STATUS" }, { header: "AUTO-RENEW" }, { header: "MRR", align: "right" }, { header: "EXPIRES" }, { header: "COUNTRY" }, { header: "CUSTOMER" }],
        r.items.map((s) => [s.appName, s.productName ?? s.productId, s.status, s.autoRenew ? "on" : c.yellow("off"), m(s.mrr), fmtDate(s.expiresAt), s.country, s.customerId]),
      ),
    );
  },
};

export const forecast: Command = {
  name: "forecast",
  summary: "Expected renewal revenue for the next days (due renewals × observed renewal rate per period).",
  options: { days: { type: "string", short: "d", arg: "<n>", description: "Days ahead (default 30)" }, ...APP_OPTION, ...CURRENCY_OPTION },
  max: 0,
  async run(ctx, { values }) {
    const f = await ctx.api.get<Forecast>("/forecast", { days: positiveInt(str(values.days), "days"), ...(await scopeQuery(ctx, values)) });
    if (ctx.json) return printJson(f);
    const m = (n: number) => fmtMoney(n, f.currency);
    println(`${c.bold(m(f.expected))} expected from renewals in the next ${f.days} days`);
    const rates = Object.entries(f.renewalRates);
    if (rates.length) println(c.gray(`Renewal rates: ${rates.map(([p, r]) => `${p} ${fmtPct(r, 0)}`).join(", ")}`));
    println("");
    println(table([{ header: "DATE" }, { header: "DUE", align: "right" }, { header: "EXPECTED", align: "right" }], f.points.filter((p) => p.due || p.expected).map((p) => [p.date, m(p.due), m(p.expected)])));
  },
};

export const cohorts: Command = {
  name: "cohorts",
  summary: "Monthly cohorts by first payment: customers, retention per month and cumulative revenue per customer (LTV).",
  options: { months: { type: "string", short: "m", arg: "<n>", description: "Cohorts (default 12)" }, ltv: { type: "boolean", description: "Show LTV per month instead of retention" }, ...APP_OPTION, ...CURRENCY_OPTION },
  max: 0,
  async run(ctx, { values }) {
    const r = await ctx.api.get<Cohorts>("/cohorts", { months: positiveInt(str(values.months), "months"), ...(await scopeQuery(ctx, values)) });
    if (ctx.json) return printJson(r);
    const width = Math.min(Math.max(0, ...r.rows.map((x) => x.retained.length)), 13);
    const cols = Array.from({ length: width }, (_, i) => ({ header: `M${i}`, align: "right" as const }));
    println(c.gray(values.ltv ? `Cumulative revenue per customer (${r.currency})` : "Customers still paying, by month since the first payment"));
    println(
      table(
        [{ header: "COHORT" }, { header: "CUSTOMERS", align: "right" }, ...cols, { header: "LTV", align: "right" }],
        r.rows.map((row) => [
          row.cohort,
          row.customers,
          ...cols.map((_, i) => (i >= row.retained.length ? "" : values.ltv ? fmtMoney(row.ltv[i], r.currency) : fmtPct(row.customers ? row.retained[i] / row.customers : 0, 0))),
          fmtMoney(row.ltv[row.ltv.length - 1] ?? 0, r.currency),
        ]),
      ),
    );
  },
};

export const revenueDaily: Command = {
  name: "revenue-daily",
  summary: "Revenue per app and day (revenue, proceeds, transactions, trials, new customers, payers, refunds, MRR).",
  description: "The feed Adsflare uses for ROAS (GET /revenue/daily). Default currency USD; apps by App Store id with --apple-app-id.",
  options: {
    ...RANGE_OPTIONS,
    ...APP_OPTION,
    "apple-app-id": { type: "string", multiple: true, arg: "<id>", description: "Only these App Store ids (repeatable)" },
    ...CURRENCY_OPTION,
  },
  max: 0,
  examples: ["revflare revenue-daily --range 7d", "revflare revenue-daily --from 2026-09-01 --to 2026-09-30 --currency EUR --json"],
  async run(ctx, { values }) {
    const scope = await scopeQuery(ctx, values);
    let appleIds = ((values["apple-app-id"] as string[] | undefined) ?? []).flatMap((s) => s.split(","));
    if (scope.apps) {
      const apps = (await ctx.apps()).items.filter((a) => scope.apps!.split(",").includes(a.id));
      const missing = apps.filter((a) => !a.appleAppId);
      if (missing.length) throw new UsageError(`No App Store id for ${missing.map((a) => a.name).join(", ")}: revenue-daily filters by App Store id`);
      appleIds = [...appleIds, ...apps.map((a) => a.appleAppId!)];
    }
    const r = await ctx.api.get<RevenueDaily>("/revenue/daily", { ...rangeQuery(values), currency: scope.currency, appleAppIds: appleIds.length ? appleIds.join(",") : undefined });
    if (ctx.json) return printJson(r);
    const m = (n: number) => fmtMoney(n, r.currency);
    println(c.gray(`${r.from} → ${r.to}, ${r.currency}`));
    println(
      table(
        ["DATE", "APP", "REVENUE", "PROCEEDS", "TX", "TRIALS", "NEW CUST", "PAYERS", "REFUNDS", "MRR"].map((h, i) => ({ header: h, align: i > 1 ? ("right" as const) : ("left" as const), flex: i === 1 })),
        r.rows.map((x) => [x.date, x.name, m(x.revenue), m(x.proceeds), x.transactions, x.trials, x.newCustomers, x.payers, x.refunds, m(x.mrr)]),
      ),
    );
    const sum = (k: "revenue" | "proceeds") => r.rows.reduce((a, x) => a + x[k], 0);
    println(`${c.bold("Total")} ${m(sum("revenue"))} revenue, ${m(sum("proceeds"))} proceeds`);
  },
};
