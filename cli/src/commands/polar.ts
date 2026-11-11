import type { Command, Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { readStdin } from "../io.js";
import { c, fmtWhen, println, printJson } from "../format.js";
import { resolveApp } from "../resolve.js";
import type { PolarSettings } from "../types.js";

const ACTIONS = [
  "status",
  "set-secret",
  "set-token",
  "map",
  "unmap",
  "sandbox",
  "sync",
] as const;

function printStatus(name: string, p: PolarSettings) {
  println(`${c.bold("Polar")}  ${name}`);
  const products = Object.entries(p.products);
  const rows: Array<[string, string]> = [
    ["Webhook URL", p.webhookUrl],
    [
      "Webhook secret",
      p.connected
        ? c.green("set")
        : c.yellow("not set: set-secret - (or set-token -)"),
    ],
    [
      "Access token",
      p.hasAccessToken
        ? c.green("set")
        : c.gray("none (needed for set-token / sync)"),
    ],
    ["Environment", p.sandbox ? c.yellow("sandbox") : "production"],
    [
      "Products",
      products.length
        ? products.map(([k, v]) => `${k} → ${v}`).join(", ")
        : c.gray("none mapped (Polar product ids kept)"),
    ],
    [
      "Last webhook",
      p.lastNotificationAt ? fmtWhen(p.lastNotificationAt) : "-",
    ],
    [
      "Last import",
      p.lastSync
        ? `${fmtWhen(p.lastSync.at)}, ${p.lastSync.orders} orders${p.lastSync.error ? c.red(` (${p.lastSync.error})`) : ""}`
        : "-",
    ],
  ];
  for (const [k, v] of rows) println(`${c.gray(k.padEnd(16))}${v}`);
  println(c.gray(`Webhook events: ${p.events.join(", ")}`));
}

async function appOf(ctx: Ctx, selector: string) {
  const app = resolveApp(selector, (await ctx.apps()).items);
  if (app.platform !== "web")
    throw new CliError(
      `${app.name} is not a web app: Polar settings are for web apps (revflare apps add-web <name>)`,
    );
  return app;
}

async function secretArg(
  ctx: Ctx,
  arg: string | undefined,
  what: string,
): Promise<string> {
  if (!arg)
    throw new UsageError(
      `Usage: revflare polar <app> ${what} <value|->  (- reads stdin)`,
    );
  const v =
    arg === "-"
      ? ((await (ctx.deps.readStdin ?? readStdin)(false)) ?? "")
      : arg;
  if (!v.trim()) throw new UsageError("The value is empty");
  return v.trim();
}

export const polar: Command = {
  name: "polar",
  args: "<app> [status|set-secret <secret|->|set-token <token|->|map <polar-id>=<product-id>...|unmap <polar-id>...|sandbox on|off|sync]",
  summary:
    "A web app's Polar setup (web checkout): webhook URL and secret, access token, product map, sandbox, order import.",
  description:
    "Polar sales reach Revflare through webhooks (order.paid, order.refunded, subscription.*) at the app's webhook URL and\n" +
    "count in revenue, MRR and the overview like store sales (store polar). Setup steps: docs/polar.md. Actions:\n" +
    "  status (default)                 webhook URL, secret / token set, products, last webhook / import\n" +
    "  set-secret <secret|->            the endpoint's signing secret from Polar → Settings → Webhooks (- reads stdin)\n" +
    "  set-token <token|->              an organization access token (webhooks:write, orders:read): Revflare creates the\n" +
    "                                   webhook endpoint itself and can import past orders\n" +
    "  map <polar-id>=<product-id>...   Revflare product id of Polar products (the id the website's events use)\n" +
    "  unmap <polar-id>...              forget mappings\n" +
    "  sandbox on|off                   Polar sandbox (sales stored as Sandbox)\n" +
    "  sync                             import past orders with the access token",
  min: 1,
  max: 12,
  examples: [
    "revflare polar app_123",
    "echo $POLAR_TOKEN | revflare polar app_123 set-token -",
    "revflare polar app_123 set-secret -",
    "revflare polar app_123 map 9f1c...=full_version",
    "revflare polar app_123 sync",
  ],
  async run(ctx, { positionals }) {
    const [selector, action = "status", ...args] = positionals;
    if (!(ACTIONS as readonly string[]).includes(action))
      throw new UsageError(
        `Unknown action "${action}": use ${ACTIONS.join(", ")}`,
      );
    const app = await appOf(ctx, selector);
    const base = `/apps/${encodeURIComponent(app.id)}/polar`;
    const show = (p: PolarSettings, saved = true) => {
      if (ctx.json) return printJson(p);
      if (saved) println(c.green("Saved."));
      printStatus(app.name, p);
    };
    if (action === "status")
      return show(await ctx.api.get<PolarSettings>(base), false);
    if (action === "set-secret")
      return show(
        await ctx.api.put<PolarSettings>(base, {
          webhookSecret: await secretArg(ctx, args[0], "set-secret"),
        }),
      );
    if (action === "set-token")
      return show(
        await ctx.api.put<PolarSettings>(base, {
          accessToken: await secretArg(ctx, args[0], "set-token"),
        }),
      );
    if (action === "sandbox") {
      if (args[0] !== "on" && args[0] !== "off")
        throw new UsageError("Usage: revflare polar <app> sandbox on|off");
      return show(
        await ctx.api.put<PolarSettings>(base, { sandbox: args[0] === "on" }),
      );
    }
    if (action === "map" || action === "unmap") {
      if (!args.length)
        throw new UsageError(
          action === "map"
            ? "Usage: revflare polar <app> map <polar-id>=<product-id>..."
            : "Usage: revflare polar <app> unmap <polar-id>...",
        );
      const current = (await ctx.api.get<PolarSettings>(base)).products;
      const products = { ...current };
      for (const a of args) {
        if (action === "unmap") delete products[a];
        else {
          const [k, v] = a.split("=");
          if (!k || !v)
            throw new UsageError(`Not <polar-id>=<product-id>: ${a}`);
          products[k] = v;
        }
      }
      return show(await ctx.api.put<PolarSettings>(base, { products }));
    }
    const r = await ctx.api.post<{
      orders: number;
      stored: number;
      error?: string;
    }>(`${base}/sync`, {});
    if (ctx.json) return printJson(r);
    println(
      `${r.orders} orders read, ${r.stored} new sales stored${r.error ? c.red(` · ${r.error}`) : ""}`,
    );
  },
};
