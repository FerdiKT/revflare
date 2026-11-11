import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { c, println, printJson, table } from "../format.js";
import { resolveApp } from "../resolve.js";
import type { EntitlementsChange, EntitlementsConfig } from "../types.js";

const ACTIONS = ["list", "set", "add-product", "remove-product", "rm", "duration"] as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const formatDuration = (d: { unit: string; count: number }) => plural(d.count, d.unit);

function printConfig(name: string, r: EntitlementsConfig) {
  println(`${c.bold("Entitlements")}  ${name}`);
  if (!r.entitlements.length) println(c.gray("No server entitlements: RevflareKit uses the app's own map only. Add one with revflare entitlements <app> set pro <productIds…>."));
  else
    println(
      table(
        [{ header: "ENTITLEMENT" }, { header: "PRODUCTS", flex: true }],
        r.entitlements.map((e) => [e.identifier, e.productIds.join(", ") || c.gray("none")]),
      ),
    );
  println("");
  if (!r.durations.length) return println(c.gray("No non-renewing durations: passes without one count as lifetime in RevflareKit."));
  println(
    table(
      [{ header: "NON-RENEWING PRODUCT" }, { header: "DURATION" }],
      r.durations.map((d) => [d.productId, formatDuration(d)]),
    ),
  );
}

function printChange(r: EntitlementsChange, message: string) {
  println(c.green(message));
  if (r.updatedTransactions) println(c.gray(`Expiry recomputed on ${plural(r.updatedTransactions, "stored transaction")}.`));
  if (r.truncated) println(c.gray("More stored transactions are recomputed in the background."));
  for (const w of r.warnings) println(`${c.yellow("warning:")} ${w}`);
}

export const entitlements: Command = {
  name: "entitlements",
  args: "<app> [list|set|add-product|remove-product|rm|duration]",
  summary: "Server-driven entitlements and non-renewing durations RevflareKit 1.9+ merges with the app's own map (no app update).",
  description:
    "Entitlement → product ids, served to RevflareKit with the offerings (GET /sdk/v1/offerings) and merged with the app's own\n" +
    "map (union per entitlement), so a new product unlocks an entitlement without an app update. Non-renewing products\n" +
    "(passes) get a duration: RevflareKit expires them (repeat purchases stack) and Revflare stores purchase + duration as\n" +
    "the transaction's expiry (setting it later recomputes stored sales). Actions:\n" +
    "  (none) | list                             entitlements and durations\n" +
    "  set <entitlement> <productIds…>           set an entitlement's products (creates it)\n" +
    "  add-product <entitlement> <productIds…>   add products (creates the entitlement)\n" +
    "  remove-product <entitlement> <productIds…> remove products\n" +
    "  rm <entitlement>                          delete an entitlement\n" +
    "  duration <productId> <3d|1w|1m|1y|none>   set (or remove with none) a non-renewing product's duration",
  min: 1,
  max: 103,
  examples: [
    "revflare entitlements com.example.app",
    "revflare entitlements com.example.app set pro com.example.app.monthly com.example.app.annual",
    "revflare entitlements com.example.app add-product pro com.example.app.pass_3day",
    "revflare entitlements com.example.app duration com.example.app.pass_3day 3d",
    "revflare entitlements com.example.app duration com.example.app.pass_3day none",
    "revflare entitlements com.example.app remove-product pro com.example.app.pass_3day",
    "revflare entitlements com.example.app rm pro",
  ],
  async run(ctx, { positionals }) {
    const [selector, action = "list", ...rest] = positionals as [string, string | undefined, ...string[]];
    if (!(ACTIONS as readonly string[]).includes(action)) throw new UsageError(`Unknown action "${action}": use ${ACTIONS.join(", ")}`);
    const usage = (u: string) => new UsageError(`Usage: revflare entitlements ${selector} ${u}`);
    const app = resolveApp(selector, (await ctx.apps()).items);
    const id = encodeURIComponent(app.id);
    const base = `/apps/${id}/entitlements`;
    const seg = encodeURIComponent;

    if (action === "list") {
      if (rest.length) throw usage("list");
      const r = await ctx.api.get<EntitlementsConfig>(base);
      if (ctx.json) return printJson(r);
      return printConfig(app.name, r);
    }
    if (action === "set") {
      const [name, ...ids] = rest;
      if (!name) throw usage("set <entitlement> <productIds…>");
      const r = await ctx.api.put<EntitlementsChange>(`${base}/${seg(name)}`, { productIds: ids });
      if (ctx.json) return printJson(r);
      return printChange(r, `${name} → ${ids.join(", ") || "no products"}`);
    }
    if (action === "add-product") {
      const [name, ...ids] = rest;
      if (!name || !ids.length) throw usage("add-product <entitlement> <productIds…>");
      const r = await ctx.api.post<EntitlementsChange>(`${base}/${seg(name)}/products`, { productIds: ids });
      if (ctx.json) return printJson(r);
      return printChange(r, `${name} → ${r.entitlements.find((e) => e.identifier === name)?.productIds.join(", ")}`);
    }
    if (action === "remove-product") {
      const [name, ...ids] = rest;
      if (!name || !ids.length) throw usage("remove-product <entitlement> <productIds…>");
      let r: EntitlementsChange | null = null;
      for (const p of ids) r = await ctx.api.delete<EntitlementsChange>(`${base}/${seg(name)}/products/${seg(p)}`);
      if (ctx.json) return printJson(r);
      return printChange(r!, `${name} → ${r!.entitlements.find((e) => e.identifier === name)?.productIds.join(", ") || "no products"}`);
    }
    if (action === "rm") {
      if (rest.length !== 1) throw usage("rm <entitlement>");
      const r = await ctx.api.delete<EntitlementsChange>(`${base}/${seg(rest[0])}`);
      if (ctx.json) return printJson(r);
      return printChange(r, `Entitlement ${rest[0]} removed`);
    }
    // duration
    if (rest.length !== 2) throw usage("duration <productId> <3d|1w|1m|1y|none>");
    const [productId, spec] = rest;
    const path = `/apps/${id}/durations/${seg(productId)}`;
    if (["none", "off", "rm", "-"].includes(spec.toLowerCase())) {
      const r = await ctx.api.delete<EntitlementsChange>(path);
      if (ctx.json) return printJson(r);
      return printChange(r, `${productId}: no duration`);
    }
    const r = await ctx.api.put<EntitlementsChange>(path, { duration: spec });
    if (ctx.json) return printJson(r);
    const d = r.durations.find((x) => x.productId === productId);
    return printChange(r, `${productId}: ${d ? formatDuration(d) : spec}`);
  },
};
