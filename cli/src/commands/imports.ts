import { list, str } from "../args.js";
import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { c, println, printJson } from "../format.js";
import { resolveApps } from "../resolve.js";
import { positiveInt } from "./common.js";

const started = (r: { id: string; reused: boolean }) => `${c.green("✓")} Job ${r.id} ${r.reused ? "already running" : "started"}. Follow it: revflare jobs show ${r.id}`;

export const importApple: Command = {
  name: "import apple",
  summary: "Backfill from Apple: 180 days of notifications + every customer's transaction history (one job per app).",
  options: { app: { type: "string", short: "a", multiple: true, arg: "<id|bundle>", description: "Only these apps (default: every active app)" } },
  max: 0,
  examples: ["revflare import apple", "revflare import apple --app com.example.app"],
  async run(ctx, { values }) {
    const sel = list(values.app);
    const appIds = sel.length ? resolveApps(sel, (await ctx.apps()).items).map((a) => a.id) : undefined;
    const r = await ctx.api.post<{ jobs: { appId: string; id: string; reused: boolean }[] }>("/imports/apple", { appIds });
    if (ctx.json) return printJson(r);
    if (!r.jobs.length) return println(c.yellow("No app to import (apps need a bundle id and must not be archived)."));
    for (const j of r.jobs) println(`${c.gray(j.appId)} ${started(j)}`);
  },
};

export const importFx: Command = {
  name: "import fx",
  summary: "Backfill daily exchange rates (needed to convert old sales to USD and the workspace currency).",
  options: { from: { type: "string", arg: "<YYYY-MM-DD>", description: "First day (default 2019-01-01)" } },
  max: 0,
  async run(ctx, { values }) {
    const from = str(values.from);
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new UsageError("--from must be YYYY-MM-DD");
    const r = await ctx.api.post<{ id: string; reused: boolean }>("/imports/fx", { from });
    if (ctx.json) return printJson(r);
    println(started(r));
  },
};

export const importSalesReports: Command = {
  name: "import sales-reports",
  summary: "Download App Store Sales and Trends reports (for `reconciliation` against Apple's numbers).",
  options: { days: { type: "string", short: "d", arg: "<n>", description: "Days back (default 30)" } },
  max: 0,
  async run(ctx, { values }) {
    const r = await ctx.api.post<{ id: string; reused: boolean }>("/imports/sales-reports", { days: positiveInt(str(values.days), "days", 30) });
    if (ctx.json) return printJson(r);
    println(started(r));
  },
};

export const importRevenuecat: Command = {
  name: "import revenuecat",
  summary: "Find a RevenueCat project's App Store transaction ids server-side (secret key credential); Apple fills them in.",
  description: "Needs a RevenueCat credential (POST /credentials { kind: \"revenuecat\", apiKey: \"sk_...\", projectId }). For the\nhistory charts (revenue, MRR, actives... before Revflare's own data) use `revflare import revenuecat-charts`.",
  options: { credential: { type: "string", arg: "<id>", description: "RevenueCat credential id (required)" } },
  max: 0,
  async run(ctx, { values }) {
    const credentialId = str(values.credential);
    if (!credentialId) throw new UsageError("--credential <id> is required");
    const r = await ctx.api.post<{ id: string; reused: boolean }>("/imports/revenuecat", { credentialId });
    if (ctx.json) return printJson(r);
    println(started(r));
  },
};
