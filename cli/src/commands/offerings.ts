import { readFileSync } from "node:fs";
import type { Command, Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { readStdin } from "../io.js";
import { c, println, printJson, table, truncate } from "../format.js";
import { resolveApp } from "../resolve.js";
import type { OfferingsChange, OfferingsConfig, OfferingsInput } from "../types.js";

const ACTIONS = ["show", "export", "apply", "current", "placements"] as const;

/** The config in the shape PUT /apps/:id/offerings takes (what `export` prints and `apply` sends back). */
export function exportConfig(r: OfferingsConfig): OfferingsInput & { placements: Record<string, string | null> } {
  return {
    currentOfferingId: r.currentOfferingId,
    offerings: r.offerings.map((o) => ({ identifier: o.identifier, displayName: o.displayName, metadata: o.metadata, packages: o.packages })),
    placements: Object.fromEntries(r.placements.map((p) => [p.identifier, p.offeringId])),
  };
}

const json = (v: unknown) => (v && typeof v === "object" && Object.keys(v).length ? JSON.stringify(v) : "-");

function printWarnings(r: OfferingsChange) {
  for (const w of r.warnings) println(`${c.yellow("warning:")} ${w}`);
}

function printList(name: string, r: OfferingsConfig) {
  println(`${c.bold("Offerings")}  ${name}  ${c.gray(`version ${r.version}`)}`);
  if (!r.offerings.length) println(c.gray("No offerings yet: create them in the web app (app → Offerings) or with revflare offerings <app> apply <file.json>."));
  else
    println(
      table(
        [{ header: "OFFERING" }, { header: "NAME" }, { header: "CURRENT" }, { header: "PACKAGES", flex: true }],
        r.offerings.map((o) => [o.identifier, o.displayName, o.isCurrent ? c.green("● current") : "", o.packages.map((p) => `${p.identifier} ${c.gray(p.productId)}`).join(", ") || c.gray("none")]),
      ),
    );
  println("");
  printPlacements(r);
}

function printPlacements(r: OfferingsConfig) {
  if (!r.placements.length) return println(c.gray("No placements: paywalls without a placement use the current offering."));
  println(
    table(
      [{ header: "PLACEMENT" }, { header: "OFFERING" }],
      r.placements.map((p) => [p.identifier, p.offeringId ?? c.gray(`current${r.currentOfferingId ? ` (${r.currentOfferingId})` : " (none)"}`)]),
    ),
  );
}

async function readConfig(ctx: Ctx, source: string): Promise<unknown> {
  let text: string | null;
  if (source === "-") {
    text = await (ctx.deps.readStdin ?? readStdin)(false);
    if (!text?.trim()) throw new UsageError("apply -: nothing on stdin");
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

export const offerings: Command = {
  name: "offerings",
  args: "<app> [show|export|apply|current|placements]",
  summary: "Offerings and placements (paywalls RevflareKit loads remotely): list, show, export / apply as JSON, current offering, placements.",
  description:
    "Offerings are sets of packages ($annual, $monthly, ... → App Store product ids) with free-form metadata for the paywall;\n" +
    "one of them is current. Placements are paywall locations in the app, each showing an offering or the current one.\n" +
    "RevflareKit loads them at launch (GET /sdk/v1/offerings), so products change without an app update. Actions:\n" +
    "  (none)                         list offerings, the current one and placements\n" +
    "  show <offering>                one offering: metadata and packages\n" +
    "  export                         the whole config as JSON (edit it, then apply it)\n" +
    "  apply <file.json|->            replace the whole config (needs manage; prints warnings, e.g. unknown products)\n" +
    "  current <offering>             make an offering current\n" +
    "  placements                     list placements\n" +
    "  placements set <p> <offering>  point a placement at an offering (current = the current offering)\n" +
    "  placements rm <p>              remove a placement",
  min: 1,
  max: 5,
  examples: [
    "revflare offerings com.example.app",
    "revflare offerings com.example.app show default",
    "revflare offerings com.example.app export > offerings.json",
    "revflare offerings com.example.app apply offerings.json",
    "revflare offerings com.example.app current black_friday",
    "revflare offerings com.example.app placements set onboarding black_friday",
    "revflare offerings com.example.app placements set settings current",
    "revflare offerings com.example.app placements rm settings",
  ],
  async run(ctx, { positionals }) {
    const [selector, action, ...rest] = positionals as [string, (typeof ACTIONS)[number] | undefined, ...string[]];
    if (action && !ACTIONS.includes(action)) throw new UsageError(`Unknown action "${action}": use ${ACTIONS.join(", ")} (or none for the list)`);
    const expect = (n: number, usage: string) => {
      if (rest.length !== n) throw new UsageError(`Usage: revflare offerings ${selector} ${usage}`);
    };
    const app = resolveApp(selector, (await ctx.apps()).items);
    const id = encodeURIComponent(app.id);
    const base = `/apps/${id}/offerings`;

    if (action === "apply") {
      expect(1, "apply <file.json|->");
      const body = await readConfig(ctx, rest[0]);
      const r = await ctx.api.put<OfferingsChange>(base, body);
      if (ctx.json) return printJson(r);
      println(`${c.green("Applied.")} ${r.offerings.length} offering${r.offerings.length === 1 ? "" : "s"}, current: ${r.currentOfferingId ?? "none"}, ${r.placements.length} placement${r.placements.length === 1 ? "" : "s"} ${c.gray(`(version ${r.version})`)}`);
      printWarnings(r);
      return;
    }
    if (action === "current") {
      expect(1, "current <offering>");
      const r = await ctx.api.post<OfferingsChange>(`${base}/${encodeURIComponent(rest[0])}/current`);
      if (ctx.json) return printJson(r);
      println(`${c.green(rest[0])} is now the current offering ${c.gray(`(version ${r.version})`)}`);
      printWarnings(r);
      return;
    }
    if (action === "placements" && rest.length) {
      const [verb, placement, target] = rest;
      if (verb === "set") {
        expect(3, "placements set <placement> <offering|current>");
        const offeringId = target === "current" ? null : target;
        const r = await ctx.api.put<OfferingsChange>(`/apps/${id}/placements/${encodeURIComponent(placement)}`, { offeringId });
        if (ctx.json) return printJson(r);
        println(`${c.green(placement)} → ${offeringId ?? `the current offering (${r.currentOfferingId ?? "none"})`} ${c.gray(`(version ${r.version})`)}`);
        return;
      }
      if (verb === "rm") {
        expect(2, "placements rm <placement>");
        const r = await ctx.api.delete<OfferingsChange>(`/apps/${id}/placements/${encodeURIComponent(placement)}`);
        if (ctx.json) return printJson(r);
        println(`Placement ${placement} removed ${c.gray(`(version ${r.version})`)}`);
        return;
      }
      throw new UsageError(`Usage: revflare offerings ${selector} placements [set <placement> <offering|current>|rm <placement>]`);
    }

    const r = await ctx.api.get<OfferingsConfig>(base);
    if (action === "export") {
      expect(0, "export");
      return printJson(exportConfig(r));
    }
    if (action === "placements") {
      if (ctx.json) return printJson(r.placements);
      return printPlacements(r);
    }
    if (action === "show") {
      expect(1, "show <offering>");
      const o = r.offerings.find((x) => x.identifier === rest[0]);
      if (!o) throw new CliError(`No offering "${rest[0]}" in ${app.name}: ${r.offerings.map((x) => x.identifier).join(", ") || "it has none"}`);
      if (ctx.json) return printJson(o);
      println(`${c.bold(o.identifier)}  ${o.displayName}${o.isCurrent ? `  ${c.green("● current")}` : ""}`);
      const used = r.placements.filter((p) => p.offeringId === o.identifier || (p.offeringId === null && o.isCurrent)).map((p) => p.identifier);
      println(`${c.gray("Metadata".padEnd(12))}${json(o.metadata)}`);
      println(`${c.gray("Placements".padEnd(12))}${used.join(", ") || "-"}`);
      println("");
      if (!o.packages.length) return println(c.gray("No packages."));
      println(
        table(
          [{ header: "PACKAGE" }, { header: "PRODUCT" }, { header: "METADATA", flex: true }],
          o.packages.map((p) => [p.identifier, p.productId, truncate(json(p.metadata), 200)]),
        ),
      );
      return;
    }
    if (ctx.json) return printJson(r);
    printList(app.name, r);
  },
};
