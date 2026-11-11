import { readFileSync } from "node:fs";
import type { Command, Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { readStdin } from "../io.js";
import { c, println, printJson, table, truncate } from "../format.js";
import { resolveApp } from "../resolve.js";
import { INSTALL_SOURCES, SDK_ENVIRONMENTS, type AttributionOptions, type RemoteConfig, type RemoteConfigEvaluation, type RemoteConfigImport, type RemoteConfigInput, type RemoteConfigParameter, type RemoteConfigRule, type RemoteConfigValueType } from "../types.js";

const ACTIONS = ["export", "apply", "import-firebase", "eval", "attribution-options", "set", "rm"] as const;
const ADS_ID_RE = /^\d{1,20}$/;
const TYPES = ["string", "number", "boolean", "json"] as const;

/** The config in the shape PUT /apps/:id/config takes (what `export` prints and `apply` sends back). */
export function exportRemoteConfig(r: RemoteConfig): Required<Pick<RemoteConfigInput, "conditions">> & { parameters: RemoteConfigParameter[] } {
  return { conditions: r.conditions, parameters: r.parameters };
}

/** "country in CN, HK", "app_version >= 2.1", "percent 0–20" (rules are ANDed). */
export function describeRule(r: RemoteConfigRule): string {
  if (r.type === "percent") return `percent ${r.from}–${r.to}${r.seed ? ` (seed ${r.seed})` : ""}`;
  if ("values" in r) return `${r.type} in ${r.values.length > 6 ? `${r.values.slice(0, 6).join(", ")} +${r.values.length - 6}` : r.values.join(", ")}`;
  return `${r.type} ${r.op} ${r.value}`;
}

const inApp = (v: unknown) => !!v && typeof v === "object" && (v as { useInAppDefault?: unknown }).useInAppDefault === true;
const show = (v: unknown) => (inApp(v) ? "(in-app default)" : JSON.stringify(v));
const paramDefault = (p: RemoteConfigParameter) => (p.useInAppDefault ? "(in-app default)" : JSON.stringify(p.defaultValue));

function printWarnings(warnings: string[]) {
  for (const w of warnings) println(`${c.yellow("warning:")} ${w}`);
}

function printConfig(name: string, r: RemoteConfig) {
  println(`${c.bold("Remote config")}  ${name}  ${c.gray(`version ${r.version}`)}`);
  if (!r.parameters.length) println(c.gray("No parameters yet: add them in the web app (app → Remote config), with revflare config <app> set, apply or import-firebase."));
  else
    println(
      table(
        [{ header: "KEY" }, { header: "TYPE" }, { header: "DEFAULT", max: 40 }, { header: "CONDITIONAL VALUES", flex: true }],
        r.parameters.map((p) => [p.key, p.type, paramDefault(p), Object.entries(p.conditionalValues).map(([k, v]) => `${k}: ${truncate(show(v), 30)}`).join(", ") || c.gray("none")]),
      ),
    );
  if (r.conditions.length) {
    println("");
    println(
      table(
        [{ header: "#", align: "right" }, { header: "CONDITION" }, { header: "RULES (all must match)", flex: true }],
        r.conditions.map((cond, i) => [
          i + 1,
          cond.name,
          cond.unsupported ? c.yellow(`unsupported, never matches${cond.expression ? `: ${cond.expression}` : ""}`) : cond.rules.map(describeRule).join(" AND ") || c.gray("always"),
        ]),
      ),
    );
  }
  if (r.warnings.length) println("");
  printWarnings(r.warnings);
}

async function readJson(ctx: Ctx, source: string, action: string): Promise<unknown> {
  let text: string | null;
  if (source === "-") {
    text = await (ctx.deps.readStdin ?? readStdin)(false);
    if (!text?.trim()) throw new UsageError(`${action} -: nothing on stdin`);
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

/** A command-line value for a parameter type (json: parsed; number / boolean: checked). */
export function parseValue(type: RemoteConfigValueType, raw: string): unknown {
  if (type === "string") return raw;
  if (type === "json") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(`Not valid JSON: ${raw}`);
    }
  }
  if (type === "number") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) throw new UsageError(`Not a number: ${raw}`);
    return n;
  }
  const s = raw.toLowerCase();
  if (s === "true" || s === "false") return s === "true";
  throw new UsageError(`Not a boolean (true or false): ${raw}`);
}

export const remoteConfig: Command = {
  name: "config",
  args: "<app> [export|apply|import-firebase|eval|set|rm]",
  summary: "Remote config (like Firebase Remote Config): typed parameters with values per condition (country, language, app version, % rollout, acquisition source, build).",
  description:
    "Parameters (string, number, boolean or JSON) have a default value and values per condition; conditions are ordered\n" +
    "(the first matching one with a value wins) and AND their rules. RevflareKit fetches the device's values at launch\n" +
    "(GET /sdk/v1/config). Actions:\n" +
    "  (none)                              parameters and conditions\n" +
    "  export                              the whole config as JSON (edit it, then apply it)\n" +
    "  apply <file.json|->                 replace the whole config (needs manage)\n" +
    "  import-firebase <file.json|->       import a Firebase Remote Config template (firebase remoteconfig:get);\n" +
    "                                      --dry-run previews, --merge merges parameters by key instead of replacing\n" +
    "  eval                                the values a device gets: --country, --app-version, --locale, --install-id,\n" +
    "                                      --source apple_ads|organic|unknown, --campaign/--ad-group/--keyword <id>,\n" +
    "                                      --environment production|sandbox|xcode...\n" +
    "  attribution-options [--days N]      Apple Ads campaign / ad group / keyword ids seen in the app's installs\n" +
    "                                      (last 30 days by default), for apple_ads_* condition rules\n" +
    "  set <key> <value>                   set a parameter's default (or --condition <name> value); --type for new keys,\n" +
    "                                      --in-app-default instead of a value to omit it (the app's default applies)\n" +
    "  rm <key>                            remove a parameter (or only its --condition value)",
  options: {
    type: { type: "string", arg: "<type>", description: "set: string, number, boolean or json (new parameters; default string)" },
    condition: { type: "string", arg: "<name>", description: "set / rm: the value for this condition instead of the default" },
    description: { type: "string", arg: "<text>", description: "set: the parameter's description" },
    "in-app-default": { type: "boolean", description: "set: use the app's in-app default (no value)" },
    merge: { type: "boolean", description: "import-firebase: merge parameters by key (and conditions by name) instead of replacing" },
    "dry-run": { type: "boolean", description: "import-firebase: show the converted config and warnings without saving" },
    country: { type: "string", arg: "<CC>", description: "eval: App Store storefront country (alpha-2)" },
    "ip-country": { type: "string", arg: "<CC>", description: "eval: the request's country" },
    "app-version": { type: "string", arg: "<x.y.z>", description: "eval: app version" },
    "app-build": { type: "string", arg: "<n>", description: "eval: app build" },
    "os-version": { type: "string", arg: "<x.y>", description: "eval: iOS version" },
    locale: { type: "string", arg: "<locale>", description: "eval: device locale, e.g. zh_CN" },
    "install-id": { type: "string", arg: "<uuid>", description: "eval: RevflareKit install id (percent rollouts, testers)" },
    "sdk-version": { type: "string", arg: "<x.y.z>", description: "eval: RevflareKit version" },
    source: { type: "string", arg: "<source>", description: `eval: acquisition source (${INSTALL_SOURCES.join(", ")})` },
    campaign: { type: "string", arg: "<id>", description: "eval: Apple Ads campaign id" },
    "ad-group": { type: "string", arg: "<id>", description: "eval: Apple Ads ad group id" },
    keyword: { type: "string", arg: "<id>", description: "eval: Apple Ads keyword id" },
    environment: { type: "string", arg: "<env>", description: `eval: the build (${SDK_ENVIRONMENTS.join(", ")}; default production)` },
    days: { type: "string", arg: "<N>", description: "attribution-options: last N days, 1 to 90 (default 30)" },
  },
  min: 1,
  max: 4,
  examples: [
    "revflare config com.example.app",
    "revflare config com.example.app export > config.json",
    "revflare config com.example.app apply config.json",
    "firebase remoteconfig:get -o firebase.json && revflare config com.example.app import-firebase firebase.json --dry-run",
    "revflare config com.example.app eval --country CN --app-version 2.1 --locale zh_CN",
    "revflare config com.example.app eval --source apple_ads --campaign 1234567890 --environment sandbox",
    "revflare config com.example.app attribution-options --days 30",
    "revflare config com.example.app set onboarding_version v1 --condition china",
    "revflare config com.example.app set max_free_accounts 2 --type number",
    "revflare config com.example.app rm onboarding_version --condition china",
  ],
  async run(ctx, { positionals, values }) {
    const [selector, action, ...rest] = positionals as [string, (typeof ACTIONS)[number] | undefined, ...string[]];
    if (action && !ACTIONS.includes(action)) throw new UsageError(`Unknown action "${action}": use ${ACTIONS.join(", ")} (or none to show the config)`);
    const expect = (n: number, usage: string) => {
      if (rest.length !== n) throw new UsageError(`Usage: revflare config ${selector} ${usage}`);
    };
    const app = resolveApp(selector, (await ctx.apps()).items);
    const base = `/apps/${encodeURIComponent(app.id)}/config`;
    const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);

    if (action === "apply") {
      expect(1, "apply <file.json|->");
      const r = await ctx.api.put<RemoteConfig>(base, await readJson(ctx, rest[0], "apply"));
      if (ctx.json) return printJson(r);
      println(`${c.green("Applied.")} ${r.parameters.length} parameter${r.parameters.length === 1 ? "" : "s"}, ${r.conditions.length} condition${r.conditions.length === 1 ? "" : "s"} ${c.gray(`(version ${r.version})`)}`);
      printWarnings(r.warnings);
      return;
    }
    if (action === "import-firebase") {
      expect(1, "import-firebase <file.json|-> [--merge] [--dry-run]");
      const template = await readJson(ctx, rest[0], "import-firebase");
      const q = new URLSearchParams();
      if (values["dry-run"]) q.set("dryRun", "true");
      if (values.merge) q.set("merge", "true");
      const r = await ctx.api.post<RemoteConfigImport>(`${base}/import-firebase${q.size ? `?${q}` : ""}`, template);
      if (ctx.json) return printJson(r);
      const what = `${r.imported.parameters} parameter${r.imported.parameters === 1 ? "" : "s"} and ${r.imported.conditions} condition${r.imported.conditions === 1 ? "" : "s"}${r.imported.unsupportedConditions ? ` (${r.imported.unsupportedConditions} unsupported)` : ""}`;
      if (r.dryRun) {
        println(`${c.bold("Dry run")}: would ${r.merged ? "merge" : "import"} ${what}. Nothing was saved.`);
        println("");
        printConfig(app.name, r);
        return;
      }
      println(`${c.green(r.merged ? "Merged" : "Imported")} ${what} ${c.gray(`(version ${r.version})`)}`);
      printWarnings(r.warnings);
      return;
    }
    if (action === "eval") {
      expect(0, "eval [--country CC] [--app-version x.y] [--locale ll_CC] [--install-id uuid] ...");
      const body = {
        storefront: str("country"),
        ipCountry: str("ip-country"),
        appVersion: str("app-version"),
        appBuild: str("app-build"),
        osVersion: str("os-version"),
        locale: str("locale"),
        installId: str("install-id"),
        sdkVersion: str("sdk-version"),
        source: str("source"),
        campaign: str("campaign"),
        adGroup: str("ad-group"),
        keyword: str("keyword"),
        environment: str("environment"),
      };
      if (body.source && !(INSTALL_SOURCES as readonly string[]).includes(body.source)) throw new UsageError(`--source must be one of ${INSTALL_SOURCES.join(", ")}`);
      if (body.environment && !(SDK_ENVIRONMENTS as readonly string[]).includes(body.environment)) throw new UsageError(`--environment must be one of ${SDK_ENVIRONMENTS.join(", ")}`);
      for (const [flag, v] of [["campaign", body.campaign], ["ad-group", body.adGroup], ["keyword", body.keyword]] as const)
        if (v !== undefined && !ADS_ID_RE.test(v)) throw new UsageError(`--${flag} must be an Apple Ads id (digits)`);
      const r = await ctx.api.post<RemoteConfigEvaluation>(`${base}/evaluate`, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
      if (ctx.json) return printJson(r);
      println(`${c.bold("Country")} ${r.country ?? "unknown"}  ${c.bold("Conditions")} ${r.conditions.join(", ") || "none"}  ${c.gray(`version ${r.version}`)}`);
      const keys = Object.keys(r.parameters);
      if (!keys.length) return println(c.gray("No parameters."));
      println(
        table(
          [{ header: "KEY" }, { header: "VALUE", flex: true }, { header: "FROM" }],
          keys.map((k) => {
            const p = r.parameters[k];
            return [k, p.useInAppDefault ? c.gray("(in-app default)") : JSON.stringify(p.value), p.condition ?? c.gray("default")];
          }),
        ),
      );
      return;
    }
    if (action === "attribution-options") {
      expect(0, "attribution-options [--days N]");
      const days = str("days");
      const r = await ctx.api.get<AttributionOptions>(`${base}/attribution-options${days ? `?${new URLSearchParams({ days })}` : ""}`);
      if (ctx.json) return printJson(r);
      println(`${c.bold("Apple Ads ids")}  ${app.name}  ${c.gray(`installs of the last ${r.days} days`)}`);
      if (!r.campaigns.length) return println(c.gray("No Apple Ads installs reported by RevflareKit in this window."));
      const name = (n: string | null) => n ?? c.gray("-");
      println("");
      println(table([{ header: "CAMPAIGN" }, { header: "NAME", flex: true }, { header: "INSTALLS", align: "right" }], r.campaigns.map((x) => [x.id, name(x.name), x.installs])));
      if (r.adGroups.length) {
        println("");
        println(table([{ header: "AD GROUP" }, { header: "CAMPAIGN" }, { header: "NAME", flex: true }, { header: "INSTALLS", align: "right" }], r.adGroups.map((x) => [x.id, x.campaignId ?? "-", name(x.name), x.installs])));
      }
      if (r.keywords.length) {
        println("");
        println(table([{ header: "KEYWORD" }, { header: "AD GROUP" }, { header: "NAME", flex: true }, { header: "INSTALLS", align: "right" }], r.keywords.map((x) => [x.id, x.adGroupId ?? "-", name(x.name), x.installs])));
      }
      return;
    }
    if (action === "set" || action === "rm") {
      const key = rest[0];
      const cond = str("condition");
      const cur = await ctx.api.get<RemoteConfig>(base);
      const config = exportRemoteConfig(cur);
      const i = config.parameters.findIndex((p) => p.key === key);
      if (action === "rm") {
        expect(1, "rm <key> [--condition <name>]");
        if (i < 0) throw new CliError(`No parameter "${key}" in ${app.name}`);
        if (cond) {
          if (!(cond in config.parameters[i].conditionalValues)) throw new CliError(`Parameter "${key}" has no value for condition "${cond}"`);
          const { [cond]: _, ...restValues } = config.parameters[i].conditionalValues;
          config.parameters[i] = { ...config.parameters[i], conditionalValues: restValues };
        } else config.parameters.splice(i, 1);
      } else {
        const useDefault = !!values["in-app-default"];
        expect(useDefault ? 1 : 2, "set <key> <value> [--type string|number|boolean|json] [--condition <name>] [--in-app-default]");
        const typeFlag = str("type");
        if (typeFlag && !(TYPES as readonly string[]).includes(typeFlag)) throw new UsageError(`--type must be one of ${TYPES.join(", ")}`);
        const existing = i >= 0 ? config.parameters[i] : null;
        const type = (typeFlag ?? existing?.type ?? "string") as RemoteConfigValueType;
        if (existing && typeFlag && typeFlag !== existing.type && Object.keys(existing.conditionalValues).length)
          throw new CliError(`Parameter "${key}" is a ${existing.type} with conditional values: change its type in the web app or with export / apply`);
        const value = useDefault ? undefined : parseValue(type, rest[1]);
        if (cond && !existing) throw new CliError(`No parameter "${key}" yet: set its default first (revflare config ${selector} set ${key} <value> --type ...)`);
        if (cond && !cur.conditions.some((x) => x.name === cond)) throw new CliError(`No condition "${cond}" in ${app.name}: ${cur.conditions.map((x) => x.name).join(", ") || "it has none (add conditions in the web app or with apply)"}`);
        let p: RemoteConfigParameter = existing ? { ...existing, type } : { key, type, conditionalValues: {} };
        if (cond) p = { ...p, conditionalValues: { ...p.conditionalValues, [cond]: useDefault ? { useInAppDefault: true } : value } };
        else if (useDefault) {
          const { defaultValue: _, ...withoutDefault } = p;
          p = { ...withoutDefault, useInAppDefault: true };
        } else {
          const { useInAppDefault: _, ...withoutFlag } = p;
          p = { ...withoutFlag, defaultValue: value };
        }
        const description = str("description");
        if (description !== undefined) p.description = description;
        if (existing) config.parameters[i] = p;
        else config.parameters.push(p);
      }
      const r = await ctx.api.put<RemoteConfig>(base, config);
      if (ctx.json) return printJson(r);
      const target = cond ? `${key} [${cond}]` : key;
      println(action === "rm" ? `Removed ${target} ${c.gray(`(version ${r.version})`)}` : `${c.green(target)} = ${values["in-app-default"] ? "(in-app default)" : rest[1]} ${c.gray(`(version ${r.version})`)}`);
      printWarnings(r.warnings);
      return;
    }

    const r = await ctx.api.get<RemoteConfig>(base);
    if (action === "export") {
      expect(0, "export");
      return printJson(exportRemoteConfig(r));
    }
    expect(0, "");
    if (ctx.json) return printJson(r);
    printConfig(app.name, r);
  },
};
