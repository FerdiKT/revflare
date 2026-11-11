import { readFile } from "node:fs/promises";
import type { Command, Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { readStdin } from "../io.js";
import { c, fmtDate, fmtWhen, println, printJson } from "../format.js";
import { resolveApp } from "../resolve.js";
import type { GooglePlaySettings } from "../types.js";

const ACTIONS = ["status", "set-credential", "set-push-account", "test", "voided"] as const;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function printStatus(name: string, g: GooglePlaySettings) {
  println(`${c.bold("Google Play")}  ${name}  ${g.packageName}`);
  const cred = g.credential;
  const rows: Array<[string, string]> = [
    ["Service account", cred ? `${cred.clientEmail ?? cred.name}${cred.projectId ? c.gray(` (${cred.projectId})`) : ""}${cred.appSpecific ? "" : c.gray(" · workspace key")}` : c.yellow("not set")],
    ["RTDN push URL", g.rtdnUrl],
    ["Push auth", g.pushServiceAccount ? `OIDC, ${g.pushServiceAccount}` : c.gray("off (the URL's secret key only)")],
    ["Last notification", g.lastNotificationAt ? fmtWhen(g.lastNotificationAt) : "-"],
    ["Last check", g.lastCheck ? (g.lastCheck.ok ? c.green(`ok ${fmtDate(g.lastCheck.at)}`) : c.red(`${g.lastCheck.error ?? "failed"} (${fmtDate(g.lastCheck.at)})`)) : "-"],
    ["Refunds poll", g.voidedCheckedAt ? fmtWhen(g.voidedCheckedAt) : "-"],
  ];
  for (const [k, v] of rows) println(`${c.gray(k.padEnd(19))}${v}`);
}

async function appOf(ctx: Ctx, selector: string) {
  const app = resolveApp(selector, (await ctx.apps()).items);
  if (app.platform !== "android") throw new CliError(`${app.name} is an App Store app: Google Play settings are for Android apps (revflare apps add-android <name> <package>)`);
  return app;
}

export const googlePlay: Command = {
  name: "google-play",
  args: "<app> [status|set-credential <file|->|set-push-account <email|none>|test|voided]",
  summary: "An Android app's Google Play setup: service account key, Pub/Sub push authentication, RTDN URL, check, refunds poll.",
  description:
    "Google Play sales reach Revflare through real-time developer notifications (Pub/Sub push to the RTDN URL), completed\n" +
    "with the Play Developer API (service account with \"View financial data\"). Setup steps: docs/google-play.md. Actions:\n" +
    "  status (default)              key in use, RTDN URL, push authentication, last notification / check / refunds poll\n" +
    "  set-credential <file|->        the service account JSON key file (- reads stdin); becomes the app's key\n" +
    "  set-push-account <email|none>  service account of the Pub/Sub push subscription (its OIDC token is then verified)\n" +
    "  test                          read-only check that the key can read the app's orders\n" +
    "  voided                        poll voided purchases (refunds) now instead of the daily run",
  min: 1,
  max: 3,
  examples: [
    "revflare google-play com.example.app",
    "revflare google-play android:com.example.app set-credential ./service-account.json",
    "revflare google-play com.example.app set-push-account rtdn-push@example-project.iam.gserviceaccount.com",
    "revflare google-play com.example.app test",
  ],
  async run(ctx, { positionals }) {
    const [selector, action = "status", arg] = positionals;
    if (!(ACTIONS as readonly string[]).includes(action)) throw new UsageError(`Unknown action "${action}": use ${ACTIONS.join(", ")}`);
    if ((action === "set-credential" || action === "set-push-account") !== (arg !== undefined)) {
      throw new UsageError(action === "set-credential" ? "Usage: revflare google-play <app> set-credential <file|->" : action === "set-push-account" ? "Usage: revflare google-play <app> set-push-account <email|none>" : `${action} takes no argument`);
    }
    const app = await appOf(ctx, selector);
    const base = `/apps/${encodeURIComponent(app.id)}/google-play`;
    if (action === "set-credential") {
      const json = arg === "-" ? ((await (ctx.deps.readStdin ?? readStdin)(false)) ?? "") : await readFile(arg!, "utf8").catch(() => {
        throw new CliError(`Cannot read ${arg}`);
      });
      if (!json.trim()) throw new UsageError("The service account key is empty");
      const g = await ctx.api.put<GooglePlaySettings>(base, { serviceAccount: json.trim() });
      if (ctx.json) return printJson(g);
      println(c.green("Saved."));
      printStatus(app.name, g);
      println("", c.gray(`Check it: revflare google-play ${selector} test`));
      return;
    }
    if (action === "set-push-account") {
      const none = ["none", "off", ""].includes(arg!.toLowerCase());
      if (!none && !EMAIL_RE.test(arg!)) throw new UsageError(`Not a service account email: ${arg}`);
      const g = await ctx.api.put<GooglePlaySettings>(base, { pushServiceAccount: none ? null : arg });
      if (ctx.json) return printJson(g);
      println(c.green("Saved."));
      return printStatus(app.name, g);
    }
    if (action === "test") {
      const r = await ctx.api.post<{ ok: boolean; error?: string }>(`${base}/test`);
      if (ctx.json) return printJson(r);
      if (!r.ok) throw new CliError(`Check failed: ${r.error ?? "unknown error"}`);
      return println(c.green("OK: the service account can read this app's orders."));
    }
    if (action === "voided") {
      const r = await ctx.api.post<{ apps: number; requests: number; refunded: number; errors: string[]; budget?: boolean }>(`${base}/voided`);
      if (ctx.json) return printJson(r);
      if (r.budget) return println(c.yellow("Today's background budget is used up: the poll runs after 00:00 UTC."));
      if (r.errors.length) throw new CliError(r.errors.join("\n"));
      return println(`${r.refunded} refund${r.refunded === 1 ? "" : "s"} recorded.`);
    }
    const g = await ctx.api.get<GooglePlaySettings>(base);
    if (ctx.json) return printJson(g);
    printStatus(app.name, g);
    if (!g.credential) println("", c.gray(`Set it up: revflare google-play ${selector} set-credential <service-account.json>`));
  },
};
