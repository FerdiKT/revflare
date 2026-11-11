import { commandHelp, parseCommand, splitCommand } from "./args.js";
import { acquisition, acquisitionCampaigns, acquisitionImport, acquisitionRequests, acquisitionStatus } from "./commands/acquisition.js";
import { adminOverview, adminUsers, adminWorkspaces } from "./commands/admin.js";
import { app, apps } from "./commands/apps.js";
import { attribution, sdkKey } from "./commands/attribution.js";
import { ltv } from "./commands/ltv.js";
import { login, logout, mcp, version, whoami } from "./commands/auth.js";
import { importApple, importFx, importRevenuecat, importSalesReports } from "./commands/imports.js";
import { meta } from "./commands/meta.js";
import { googlePlay } from "./commands/google-play.js";
import { polar } from "./commands/polar.js";
import { refunds } from "./commands/refunds.js";
import { offers } from "./commands/offers.js";
import { offerings } from "./commands/offerings.js";
import { entitlements } from "./commands/entitlements.js";
import { remoteConfig } from "./commands/remote-config.js";
import { experiments } from "./commands/experiments.js";
import { events, funnels } from "./commands/events.js";
import { alerts, alertsResolve, goals, goalsAdd, goalsArchive, goalsEdit, goalsList, goalsRemove, goalsRemoveAlias, goalsReorder, goalsShow, jobs, jobsCancel, jobsShow } from "./commands/manage.js";
import { atRisk, breakdown, chart, cohorts, forecast, mrrMovement, overview, revenueDaily } from "./commands/metrics.js";
import { importRevenuecatCharts } from "./commands/rccharts.js";
import { skillInstall } from "./commands/skill.js";
import { customer, transactions } from "./commands/transactions.js";
import { invitations, invitationsRevoke, invite, usage } from "./commands/workspace.js";
import { Ctx, type Command, type Deps } from "./context.js";
import { ApiError, CliError, QuotaError, UsageError } from "./errors.js";
import { c, eprintln, println, setColor, truncate } from "./format.js";
import { VERSION } from "./version.js";

export const COMMANDS: Command[] = [
  login,
  logout,
  whoami,
  version,
  mcp,
  skillInstall,
  overview,
  apps,
  app,
  googlePlay,
  polar,
  chart,
  breakdown,
  mrrMovement,
  revenueDaily,
  transactions,
  customer,
  atRisk,
  forecast,
  cohorts,
  attribution,
  ltv,
  sdkKey,
  meta,
  refunds,
  offers,
  offerings,
  entitlements,
  remoteConfig,
  experiments,
  events,
  funnels,
  acquisition,
  acquisitionCampaigns,
  acquisitionStatus,
  acquisitionRequests,
  acquisitionImport,
  alerts,
  alertsResolve,
  goals,
  goalsList,
  goalsShow,
  goalsAdd,
  goalsEdit,
  goalsArchive,
  goalsReorder,
  goalsRemove,
  goalsRemoveAlias,
  jobs,
  jobsShow,
  jobsCancel,
  importApple,
  importFx,
  importSalesReports,
  importRevenuecat,
  importRevenuecatCharts,
  invite,
  invitations,
  invitationsRevoke,
  usage,
  adminOverview,
  adminUsers,
  adminWorkspaces,
];

const GROUPS: Array<[string, string[]]> = [
  ["Setup", ["login", "logout", "whoami", "version", "mcp", "skill install"]],
  ["Revenue", ["overview", "apps", "app", "chart", "breakdown", "mrr-movement", "revenue-daily"]],
  ["Google Play (Android)", ["google-play"]],
  ["Polar (web)", ["polar"]],
  ["Customers & sales", ["transactions", "customer", "at-risk", "forecast", "cohorts"]],
  ["Apple Ads", ["attribution", "ltv", "sdk-key"]],
  ["Meta Ads", ["meta"]],
  ["Paywalls & remote config", ["offerings", "entitlements", "config", "experiments"]],
  ["Events & funnels", ["events", "funnels"]],
  ["App Store acquisition", ["acquisition", "acquisition campaigns", "acquisition status", "acquisition requests", "acquisition import"]],
  ["Alerts & goals", ["alerts", "alerts resolve", "goals", "goals show", "goals add", "goals edit", "goals archive", "goals reorder", "goals rm"]],
  ["Workspace", ["invite", "invitations", "invitations revoke", "usage"]],
  ["Instance admin (revflare login --email)", ["admin overview", "admin users", "admin workspaces"]],
  ["Imports", ["import apple", "import fx", "import sales-reports", "import revenuecat", "import revenuecat-charts", "jobs", "jobs show", "jobs cancel"]],
];

export function mainHelp(): string {
  const byName = new Map(COMMANDS.map((c) => [c.name, c]));
  const w = Math.max(...COMMANDS.map((c) => (c.name + (c.args ? ` ${c.args}` : "")).length));
  const room = process.stdout.isTTY && process.stdout.columns ? Math.max(process.stdout.columns - w - 4, 30) : Infinity;
  const lines = [`revflare ${VERSION}: revenue, MRR, subscriptions and sales of your apps from your Revflare instance.`, "", "Usage: revflare <command> [options]"];
  for (const [title, names] of GROUPS) {
    lines.push("", `${title}:`);
    for (const n of names) {
      const cmd = byName.get(n)!;
      lines.push(`  ${(cmd.name + (cmd.args ? ` ${cmd.args}` : "")).padEnd(w)}  ${room === Infinity ? cmd.summary : truncate(cmd.summary, room)}`);
    }
  }
  lines.push(
    "",
    "Global options: --json (machine-readable output on every command), --profile <name>, --no-color, -h/--help, --version",
    "Environment: REVFLARE_URL, REVFLARE_API_KEY, REVFLARE_PROFILE, REVFLARE_CONFIG (config path), NO_COLOR",
    "Apps can be given by id, bundle id (Android: package name; ios:<id> / android:<id> when both share it), App Store id\nor name. Exit codes: 0 ok, 1 error, 2 usage error,\n" +
    "3 Cloudflare Free plan daily database limit or import budget reached (retry after 00:00 UTC).",
    "",
    "Examples:",
    "  revflare login --url https://revflare.example.com",
    "  revflare overview",
    "  revflare chart mrr --range 12m --interval month",
    "  revflare breakdown --by country --range 28d",
    "  revflare transactions --follow",
    "  revflare attribution --range 90d --by keyword",
    "  revflare ltv --by campaign --cohort month --range 12m",
    "  revflare acquisition --by campaign --range 90d",
    "  revflare meta com.example.app log",
    "  revflare google-play android:com.example.app test",
    "  revflare offerings com.example.app export > offerings.json",
    "  revflare config com.example.app eval --country CN --app-version 2.1",
    "  revflare funnels com.example.app show Onboarding --range 30d",
    "  revflare import revenuecat-charts --dry-run",
    "",
    "Help for a command: revflare <command> --help",
  );
  return lines.join("\n");
}

/** Run the CLI; returns the exit code. */
export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  if (argv.includes("--no-color")) setColor(false);
  if (argv[0] === "--version" || argv[0] === "-v") {
    println(VERSION);
    return 0;
  }
  const names = COMMANDS.map((c) => c.name);
  const { name, rest, words } = splitCommand(argv, names);
  if (words[0] === "help") {
    const sub = splitCommand(argv.slice(argv.indexOf("help") + 1), names);
    const cmd = COMMANDS.find((c) => c.name === sub.name);
    println(cmd ? commandHelp(cmd) : mainHelp());
    return 0;
  }
  if (!name) {
    if (!words.length) {
      println(mainHelp());
      return argv.some((a) => a === "-h" || a === "--help") || !argv.length ? 0 : 2;
    }
    const group = names.filter((n) => n.startsWith(`${words[0]} `));
    eprintln(`${c.red("error:")} unknown command "${words.join(" ")}"`);
    eprintln(group.length ? `Did you mean: ${group.map((g) => `revflare ${g}`).join(", ")}` : "Run revflare --help for the list of commands.");
    return 2;
  }
  const cmd = COMMANDS.find((c) => c.name === name)!;
  return execute(cmd, rest, deps);
}

async function execute(cmd: Command, rest: string[], deps: Deps): Promise<number> {
  try {
    const parsed = parseCommand(cmd, rest);
    if (parsed.values["no-color"]) setColor(false);
    if (parsed.values.help) {
      println(commandHelp(cmd));
      return 0;
    }
    process.exitCode = undefined;
    await cmd.run(new Ctx(parsed, deps), parsed);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      eprintln(`${c.red("error:")} ${err.message}`);
      eprintln(c.gray(`See: revflare ${cmd.name} --help`));
      return 2;
    }
    if (err instanceof QuotaError) {
      eprintln(`${c.red("error:")} ${err.message}`);
      return 3;
    }
    if (err instanceof ApiError || err instanceof CliError) {
      eprintln(`${c.red("error:")} ${err.message}`);
      return 1;
    }
    eprintln(`${c.red("error:")} ${(err as Error)?.stack ?? String(err)}`);
    return 1;
  }
}
