import { readFileSync } from "node:fs";
import type { Command, Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { readStdin } from "../io.js";
import { c, fmtDate, fmtMoney, fmtNum, fmtPct, fmtStatus, printJson, println, table, truncate } from "../format.js";
import { resolveApp } from "../resolve.js";
import type { Experiment, ExperimentLift, ExperimentResults } from "../types.js";

const ACTIONS = ["list", "show", "create", "start", "stop", "rollout", "archive", "results"] as const;
type Action = (typeof ACTIONS)[number];

const METRIC_LABELS: Record<string, string> = { trial_started: "trial start rate", paid: "paid conversion rate", revenue_per_install: "revenue per install" };

async function readJson(ctx: Ctx, source: string): Promise<unknown> {
  let text: string | null;
  if (source === "-") {
    text = await (ctx.deps.readStdin ?? readStdin)(false);
    if (!text?.trim()) throw new UsageError("create --file -: nothing on stdin");
  } else {
    try {
      text = readFileSync(source, "utf8");
    } catch (err) {
      throw new CliError(`Cannot read ${source}: ${(err as Error).message}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`${source === "-" ? "stdin" : source} is not valid JSON: ${(err as Error).message}`);
  }
}

/** "+12.3% (−2.1% to +27.0%)". */
export function fmtLift(l: ExperimentLift | null | undefined): string {
  if (!l) return "-";
  const p = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
  return `${p(l.expected)} ${c.gray(`(${p(l.low)} to ${p(l.high)})`)}`;
}

const show = (v: unknown) => truncate(JSON.stringify(v), 40);

function printExperiment(x: Experiment) {
  println(`${c.bold(x.name)}  ${c.gray(x.id)}  ${fmtStatus(x.status)}${x.rolledOutVariant ? ` ${c.gray(`(variant ${x.rolledOutVariant})`)}` : ""}`);
  if (x.hypothesis) println(c.gray(x.hypothesis));
  println(
    `Parameters ${x.keys.join(", ")}  ·  primary metric ${METRIC_LABELS[x.primaryMetric] ?? x.primaryMetric}  ·  traffic ${x.traffic}%${x.targeting ? ` of "${x.targeting}"` : ""}`,
  );
  if (x.startedAt) println(`Started ${fmtDate(x.startedAt)}${x.stoppedAt ? `, stopped ${fmtDate(x.stoppedAt)}` : x.endsAt ? `, stops by ${fmtDate(x.endsAt)}` : ""}`);
  println("");
  println(
    table(
      [{ header: "VARIANT" }, { header: "NAME" }, { header: "WEIGHT", align: "right" }, { header: "VALUES", flex: true }],
      x.variants.map((v) => [v.id, v.name, `${+v.weight.toFixed(2)}%`, x.keys.map((k) => `${k}=${k in v.values ? show(v.values[k]) : c.gray("(current)")}`).join(", ")]),
    ),
  );
}

function printResults(name: string, r: ExperimentResults) {
  const m = r.primaryMetric;
  println(`${c.bold(name)}  ${fmtStatus(r.status)}  ${c.gray(`${r.daysRunning} days · primary: ${METRIC_LABELS[m] ?? m}${r.frozen ? " · final" : ""}`)}`);
  if (r.exposureSource === "none" && !r.variants.some((v) => v.exposed)) {
    for (const why of r.reasons) println(c.gray(why));
    return;
  }
  const best = (v: ExperimentResults["variants"][number]) => (m === "revenue_per_install" ? null : v.probabilityBest[m]);
  const lift = (v: ExperimentResults["variants"][number]) => (m === "revenue_per_install" ? null : v.lift[m]);
  println(
    table(
      [
        { header: "VARIANT" },
        { header: "EXPOSED", align: "right" },
        { header: "TRIAL %", align: "right" },
        { header: "PAID %", align: "right" },
        { header: "REV/INSTALL", align: "right" },
        { header: "P(BEST)", align: "right" },
        { header: "LIFT VS CONTROL (95%)", flex: true },
      ],
      r.variants.map((v) => [
        `${v.variant} ${c.gray(v.name)}`,
        fmtNum(v.exposed),
        fmtPct(v.trialRate),
        fmtPct(v.paidRate),
        v.revenuePerInstall === null ? "-" : fmtMoney(v.revenuePerInstall, r.currency),
        r.enoughData && best(v) !== null ? fmtPct(best(v), 1) : c.gray("-"),
        r.enoughData ? fmtLift(lift(v)) : c.gray("-"),
      ]),
    ),
  );
  if (!r.enoughData) println(`${c.yellow("Not enough data yet:")} ${r.reasons.join(" ")}`);
  else if (r.confident) println(`${c.green("Confident:")} variant ${r.confident.variant} is best with ${fmtPct(r.confident.probability, 1)} probability.`);
  else if (m === "revenue_per_install") println(c.gray("Revenue per install is a point estimate (no probability)."));
  else println(c.gray("No variant is ahead with 95% probability yet."));
  if (r.approximate) println(c.yellow("Approximate:"));
  for (const n of r.notes) println(c.gray(`- ${n}`));
}

export const experiments: Command = {
  name: "experiments",
  args: "<app> [list|show <id>|create --file <f>|start <id>|stop <id>|rollout <id> <variant>|archive <id>|results <id> [--refresh]]",
  summary: "A/B experiments on remote config parameters: variants, assignment, results (exposures, trials, paid, revenue per install).",
  description:
    "An experiment gives each variant (a = control, b, c...) its own values for some remote config parameters; RevflareKit\n" +
    "assigns devices (stable per install) and logs experiment_exposure events. Results compare exposed installs' trials,\n" +
    "paid conversions and revenue per install (Bayesian probability to be best, lift vs control) once the guardrails\n" +
    "are met (7 days, 100 exposed installs per variant, 10 conversions). Actions:\n" +
    "  (none) / list                       the app's experiments\n" +
    "  show <id>                           one experiment: parameters, variants and their values\n" +
    "  create --file <file.json|->         create a draft: { name, keys, variants: [{ name?, weight?, values }], targeting?,\n" +
    "                                      traffic?, primaryMetric?: trial_started | paid | revenue_per_install, hypothesis? }\n" +
    "  start <id>                          start a draft (devices get the variants' values within about a minute)\n" +
    "  stop <id>                           stop measuring (devices keep their variant until rollout or archive)\n" +
    "  rollout <id> <variant>              the variant's values become the parameters' defaults; the experiment ends\n" +
    "  archive <id>                        end without changing the defaults\n" +
    "  results <id> [--refresh]            per variant: exposed, trial %, paid %, revenue per install, P(best), lift\n" +
    "                                      (stored results, recomputed every few hours; --refresh: now, once an hour)\n" +
    "Changes need the manage permission.",
  options: {
    file: { type: "string", arg: "<file.json|->", description: "create: the experiment as JSON (- reads stdin)" },
    refresh: { type: "boolean", description: "results: recompute now (at most once an hour per experiment) instead of the stored results" },
  },
  min: 1,
  max: 4,
  examples: [
    "revflare experiments com.example.app",
    "revflare experiments com.example.app create --file paywall-test.json",
    "revflare experiments com.example.app start exp_0123456789ab",
    "revflare experiments com.example.app results exp_0123456789ab",
    "revflare experiments com.example.app rollout exp_0123456789ab b",
  ],
  async run(ctx, { positionals, values }) {
    const [selector, rawAction, ...rest] = positionals as [string, string | undefined, ...string[]];
    const action = (rawAction ?? "list") as Action;
    if (!ACTIONS.includes(action)) throw new UsageError(`Unknown action "${rawAction}": use ${ACTIONS.join(", ")}`);
    const app = resolveApp(selector, (await ctx.apps()).items);
    const base = `/apps/${encodeURIComponent(app.id)}/experiments`;
    const need = (n: number, usage: string) => {
      if (rest.length !== n) throw new UsageError(`Usage: revflare experiments ${selector} ${usage}`);
    };
    const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

    if (action === "list") {
      need(0, "[list]");
      const r = await ctx.api.get<{ items: Experiment[] }>(base);
      if (ctx.json) return printJson(r);
      if (!r.items.length) return println(c.gray(`No experiments in ${app.name} yet: revflare experiments ${selector} create --file experiment.json (or the web app: app → Experiments).`));
      println(
        table(
          [{ header: "ID" }, { header: "NAME", max: 30 }, { header: "STATUS" }, { header: "PARAMETERS", max: 30 }, { header: "VARIANTS", align: "right" }, { header: "METRIC" }, { header: "STARTED" }],
          r.items.map((x) => [x.id, x.name, fmtStatus(x.status) + (x.rolledOutVariant ? c.gray(` (${x.rolledOutVariant})`) : ""), x.keys.join(", "), x.variants.length, x.primaryMetric, x.startedAt ? fmtDate(x.startedAt) : "-"]),
        ),
      );
      return;
    }
    if (action === "create") {
      need(0, "create --file <file.json|->");
      const file = typeof values.file === "string" ? values.file : null;
      if (!file) throw new UsageError("create needs --file <file.json|-> (the experiment as JSON)");
      const x = await ctx.api.post<Experiment>(base, await readJson(ctx, file));
      if (ctx.json) return printJson(x);
      println(`${c.green("Created")} draft ${x.id}. Start it with: revflare experiments ${selector} start ${x.id}`);
      println("");
      printExperiment(x);
      return;
    }
    if (action === "rollout") {
      need(2, "rollout <id> <variant>");
      const x = await ctx.api.post<Experiment>(`${one(rest[0])}/rollout`, { variant: rest[1] });
      if (ctx.json) return printJson(x);
      const v = x.variants.find((y) => y.id === rest[1]);
      println(`${c.green("Rolled out")} variant ${rest[1]}${v ? ` (${v.name})` : ""}: ${Object.entries(v?.values ?? {}).map(([k, val]) => `${k}=${show(val)}`).join(", ") || "the current values stay"} are now the defaults.`);
      return;
    }
    need(1, `${action} <id>`);
    const id = rest[0];
    if (action === "show") {
      const x = await ctx.api.get<Experiment>(one(id));
      if (ctx.json) return printJson(x);
      return printExperiment(x);
    }
    if (action === "results") {
      // --refresh: recompute now (at most once an hour per experiment); else the stored results (the server
      // recomputes running experiments every few hours).
      const r = values.refresh ? await ctx.api.post<ExperimentResults>(`${one(id)}/results/refresh`) : await ctx.api.get<ExperimentResults>(`${one(id)}/results`);
      if (ctx.json) return printJson(r);
      return printResults(id, r);
    }
    const x = await ctx.api.post<Experiment>(`${one(id)}/${action}`);
    if (ctx.json) return printJson(x);
    const done = { start: "Started", stop: "Stopped (devices keep their variant until rollout or archive)", archive: "Archived" } as Record<string, string>;
    println(`${c.green(done[action] ?? action)}: ${x.name} ${c.gray(x.id)}`);
  },
};
