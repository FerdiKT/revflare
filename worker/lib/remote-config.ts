// Remote config per app (like Firebase Remote Config): typed parameters with a default value and values per condition;
// conditions are ordered (the first matching condition with a value for a parameter wins) and are an AND of rules
// (country, language, app version, percent rollout, testers...). See docs/remote-config.md.
//
// Storage: one `remote_configs` row per app with the whole config as JSON, the compiled form RevflareKit's endpoint
// evaluates (`sdk_json`) and the config `version`. Every change runs inside the database object (`changeRemoteConfig`):
// read the row, apply the change, validate the whole config, write the row back (synchronous between read and write,
// so concurrent edits cannot interleave).
//
// Reads by the SDK (GET /sdk/v1/config, hit on every app launch): the compiled config comes from the isolate's memory or
// the Cache API (worker/lib/sdk-cache.ts), and each device's values are resolved in the Worker: no database read per
// request.

import { COUNTRY_NAMES, toAlpha2 } from "../../shared/countries";
import {
  INSTALL_SOURCES,
  RC_CONDITION_COLORS,
  RC_CONDITION_NAME_RE,
  RC_LIMITS,
  RC_PARAMETER_KEY_RE,
  RC_VALUE_TYPES,
  RC_VERSION_OPS,
  type RemoteConfig,
  type RemoteConfigCondition,
  type RemoteConfigEvaluation,
  type RemoteConfigImport,
  type RemoteConfigParameter,
  type RemoteConfigRule,
  type RemoteConfigValueType,
  type RemoteConfigVersionOp,
  SDK_ENVIRONMENTS,
  type InstallSource,
  type SdkEnvironment,
  type SdkExperimentAssignment,
  type SdkRemoteConfig,
} from "../../shared/types";
import { isInstallSource, parseSdkEnvironment } from "./test-data";
import { defineDbFunction, type Db } from "./db";
import { shortHash } from "./offerings";
import { now, parseJson } from "./util";

export interface StoredRemoteConfig {
  conditions: RemoteConfigCondition[];
  parameters: RemoteConfigParameter[];
}

export const EMPTY_REMOTE_CONFIG: StoredRemoteConfig = { conditions: [], parameters: [] };

type Fail = { error: string };

const bytes = (s: string) => new TextEncoder().encode(s).length;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** `{ useInAppDefault: true }`: the key is left out of the device's values (the app's default applies). */
export const isInAppDefault = (v: unknown) => isObject(v) && v.useInAppDefault === true && Object.keys(v).length === 1;

const LIST_RULES = ["country", "ip_country", "storefront", "language", "locale", "install_id"] as const;
/** Acquisition rules: values from RevflareKit's attribution report (the device sends them as query parameters). */
const ADS_ID_RULES = ["apple_ads_campaign", "apple_ads_ad_group", "apple_ads_keyword"] as const;
const SET_RULES = { source: INSTALL_SOURCES, environment: SDK_ENVIRONMENTS } as const;
const VERSION_RULES = ["app_version", "app_build", "os_version", "sdk_version"] as const;
export const RULE_TYPES = [...LIST_RULES, "source", ...ADS_ID_RULES, "environment", ...VERSION_RULES, "percent"] as const;

const COUNTRY_RE = /^[A-Z]{2}$/;
const LOCALE_RE = /^[a-z]{2,3}(?:_[a-z0-9]{2,8})*$/;
const INSTALL_ID_RE = /^[a-z0-9-]{1,64}$/;
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,31}$/;
/** Apple Ads campaign / ad group / keyword ids. */
export const ADS_ID_RE = /^\d{1,20}$/;

/** "zh-Hans_CN" → "zh_hans_cn" (rules and devices compare locales this way). */
export const normLocale = (s: string) => s.trim().replace(/-/g, "_").toLowerCase();

// --- Validation -------------------------------------------------------------------------------------------------------

function parseRule(v: unknown, where: string): RemoteConfigRule | Fail {
  if (!isObject(v)) return { error: `${where}: each rule must be an object { type, ... }` };
  const type = v.type as string;
  if ((LIST_RULES as readonly string[]).includes(type)) {
    if (!Array.isArray(v.values) || !v.values.length) return { error: `${where}: rule "${type}" needs a non-empty list of values` };
    if (v.values.length > RC_LIMITS.valuesPerRule) return { error: `${where}: at most ${RC_LIMITS.valuesPerRule} values per rule` };
    const values: string[] = [];
    for (const raw of v.values) {
      if (typeof raw !== "string") return { error: `${where}: rule "${type}" values must be strings` };
      let x = raw.trim();
      if (type === "country" || type === "ip_country" || type === "storefront") {
        x = toAlpha2(x) ?? x.toUpperCase();
        if (!COUNTRY_RE.test(x)) return { error: `${where}: ${JSON.stringify(raw)} is not an ISO 3166 country code (e.g. US, CN)` };
      } else if (type === "language" || type === "locale") {
        x = normLocale(x);
        if (!LOCALE_RE.test(x)) return { error: `${where}: ${JSON.stringify(raw)} is not a ${type} (e.g. ${type === "language" ? "zh, en" : "en_US, zh_CN"})` };
      } else {
        x = x.toLowerCase();
        if (!INSTALL_ID_RE.test(x)) return { error: `${where}: ${JSON.stringify(raw)} is not an install id` };
      }
      if (!values.includes(x)) values.push(x);
    }
    return { type: type as (typeof LIST_RULES)[number], values };
  }
  if (type === "source" || type === "environment" || (ADS_ID_RULES as readonly string[]).includes(type)) {
    if (!Array.isArray(v.values) || !v.values.length) return { error: `${where}: rule "${type}" needs a non-empty list of values` };
    if (v.values.length > RC_LIMITS.valuesPerRule) return { error: `${where}: at most ${RC_LIMITS.valuesPerRule} values per rule` };
    const allowed: readonly string[] | null = type === "source" || type === "environment" ? SET_RULES[type] : null;
    const values: string[] = [];
    for (const raw of v.values) {
      const x = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : typeof raw === "string" ? raw.trim() : null;
      if (x === null) return { error: `${where}: rule "${type}" values must be strings` };
      if (allowed ? !allowed.includes(x.toLowerCase()) : !ADS_ID_RE.test(x))
        return { error: `${where}: ${JSON.stringify(raw)} is not ${allowed ? `one of ${allowed.join(", ")}` : "an Apple Ads id (digits)"}` };
      const value = allowed ? x.toLowerCase() : x;
      if (!values.includes(value)) values.push(value);
    }
    return { type, values } as RemoteConfigRule;
  }
  if ((VERSION_RULES as readonly string[]).includes(type)) {
    if (!(RC_VERSION_OPS as readonly string[]).includes(v.op as string)) return { error: `${where}: rule "${type}" needs op ${RC_VERSION_OPS.join(" ")}` };
    const value = typeof v.value === "number" ? String(v.value) : typeof v.value === "string" ? v.value.trim() : "";
    if (!VERSION_RE.test(value)) return { error: `${where}: rule "${type}" needs a version value such as 2.1.0` };
    return { type: type as (typeof VERSION_RULES)[number], op: v.op as RemoteConfigVersionOp, value };
  }
  if (type === "percent") {
    const from = v.from === undefined ? 0 : v.from;
    const to = v.to;
    if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 100 || from > to)
      return { error: `${where}: rule "percent" needs 0 <= from <= to <= 100 (matches from <= bucket < to)` };
    const rule: Extract<RemoteConfigRule, { type: "percent" }> = { type: "percent", from, to };
    if (v.seed !== undefined && v.seed !== null && v.seed !== "") {
      if (typeof v.seed !== "string" || v.seed.length > 64) return { error: `${where}: seed must be a string of at most 64 characters` };
      if (isExperimentSeed(v.seed)) return { error: `${where}: seed ${JSON.stringify(v.seed)} is reserved (it looks like an experiment id, whose buckets it would share)` };
      rule.seed = v.seed;
    }
    return rule;
  }
  return { error: `${where}: unknown rule type ${JSON.stringify(type ?? null)} (${RULE_TYPES.join(", ")})` };
}

function parseCondition(v: unknown): RemoteConfigCondition | Fail {
  if (!isObject(v)) return { error: "Each condition must be an object { name, color?, rules }" };
  const name = typeof v.name === "string" ? v.name.trim() : v.name;
  if (typeof name !== "string" || !RC_CONDITION_NAME_RE.test(name)) return { error: `Condition name ${JSON.stringify(v.name ?? null)} is not valid (letters, digits, space _ . -, at most 64 characters)` };
  // A percent rule's default seed is the condition's name: an experiment id there would share the experiment's buckets.
  if (isExperimentSeed(name)) return { error: `Condition name "${name}" is reserved (it looks like an experiment id): pick another one` };
  const where = `Condition "${name}"`;
  const c: RemoteConfigCondition = { name, rules: [] };
  if (v.color !== undefined && v.color !== null && v.color !== "") {
    const color = String(v.color).toLowerCase();
    if (!(RC_CONDITION_COLORS as readonly string[]).includes(color)) return { error: `${where}: color must be one of ${RC_CONDITION_COLORS.join(", ")}` };
    c.color = color as RemoteConfigCondition["color"];
  }
  if (v.rules !== undefined && v.rules !== null && !Array.isArray(v.rules)) return { error: `${where}: rules must be a list` };
  const rules = (v.rules ?? []) as unknown[];
  if (rules.length > RC_LIMITS.rulesPerCondition) return { error: `${where}: at most ${RC_LIMITS.rulesPerCondition} rules` };
  for (const r of rules) {
    const rule = parseRule(r, where);
    if ("error" in rule) return rule;
    c.rules.push(rule);
  }
  if (v.unsupported === true) c.unsupported = true;
  if (typeof v.expression === "string" && v.expression) c.expression = v.expression.slice(0, 2000);
  return c;
}

const TRUE_STRINGS = ["true", "1", "t", "yes", "y", "on"];
const FALSE_STRINGS = ["false", "0", "f", "no", "n", "off"];

/** A typed value (numbers and booleans also as strings, e.g. from the CLI). */
export function coerceValue(type: RemoteConfigValueType, v: unknown, where: string): { value: unknown } | Fail {
  if (v === undefined) return { error: `${where}: missing value` };
  let value = v;
  if (type === "string") {
    if (typeof v !== "string") return { error: `${where}: expected a string` };
  } else if (type === "number") {
    if (typeof v === "string" && v.trim() !== "") value = Number(v.trim());
    if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${where}: expected a finite number` };
  } else if (type === "boolean") {
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      value = TRUE_STRINGS.includes(s) ? true : FALSE_STRINGS.includes(s) ? false : v;
    }
    if (typeof value !== "boolean") return { error: `${where}: expected true or false` };
  }
  const json = JSON.stringify(value);
  if (json === undefined) return { error: `${where}: not a JSON value` };
  if (bytes(json) > RC_LIMITS.valueBytes) return { error: `${where}: larger than ${RC_LIMITS.valueBytes / 1024} KB` };
  return { value };
}

function parseParameter(v: unknown, key: unknown, conditions: Set<string>): RemoteConfigParameter | Fail {
  if (!isObject(v)) return { error: "Each parameter must be an object { key, type, defaultValue | useInAppDefault, conditionalValues?, description? }" };
  if (typeof key !== "string" || !RC_PARAMETER_KEY_RE.test(key)) return { error: `Parameter key ${JSON.stringify(key ?? null)} is not valid (letters, digits, _ . -, at most 128 characters)` };
  const where = `Parameter "${key}"`;
  const type = (v.type ?? "string") as RemoteConfigValueType;
  if (!RC_VALUE_TYPES.includes(type)) return { error: `${where}: type must be one of ${RC_VALUE_TYPES.join(", ")}` };
  const p: RemoteConfigParameter = { key, type, conditionalValues: {} };
  if (v.description !== undefined && v.description !== null && v.description !== "") {
    if (typeof v.description !== "string" || v.description.length > 1000) return { error: `${where}: description must be a string of at most 1000 characters` };
    p.description = v.description;
  }
  if (v.useInAppDefault === true || (v.defaultValue !== undefined && isInAppDefault(v.defaultValue))) p.useInAppDefault = true;
  else {
    const d = coerceValue(type, v.defaultValue, `${where}, default value`);
    if ("error" in d) return { error: v.defaultValue === undefined ? `${where}: needs a defaultValue (or useInAppDefault: true)` : d.error };
    p.defaultValue = d.value;
  }
  if (v.conditionalValues !== undefined && v.conditionalValues !== null && !isObject(v.conditionalValues)) return { error: `${where}: conditionalValues must be an object { condition: value }` };
  for (const [cond, raw] of Object.entries((v.conditionalValues ?? {}) as Record<string, unknown>)) {
    if (!conditions.has(cond)) return { error: `${where}: condition "${cond}" does not exist` };
    if (isInAppDefault(raw)) {
      p.conditionalValues[cond] = { useInAppDefault: true };
      continue;
    }
    const c = coerceValue(type, raw, `${where}, value for "${cond}"`);
    if ("error" in c) return c;
    p.conditionalValues[cond] = c.value;
  }
  return p;
}

/** Validates a whole config (PUT body, or the stored config after a change). Parameters as a list or a map key → parameter. */
export function parseRemoteConfig(body: unknown): StoredRemoteConfig | Fail {
  if (!isObject(body)) return { error: "Expected a JSON object { conditions?: [...], parameters: [...] }" };
  if (body.conditions !== undefined && body.conditions !== null && !Array.isArray(body.conditions)) return { error: "conditions must be a list (in priority order)" };
  const rawConditions = (body.conditions ?? []) as unknown[];
  if (rawConditions.length > RC_LIMITS.conditions) return { error: `At most ${RC_LIMITS.conditions} conditions per app` };
  const conditions: RemoteConfigCondition[] = [];
  for (const item of rawConditions) {
    const c = parseCondition(item);
    if ("error" in c) return c;
    if (conditions.some((x) => x.name === c.name)) return { error: `Condition "${c.name}" appears twice` };
    conditions.push(c);
  }
  const names = new Set(conditions.map((c) => c.name));
  const rawParams = body.parameters ?? [];
  let entries: [unknown, unknown][];
  if (Array.isArray(rawParams)) entries = rawParams.map((p) => [isObject(p) ? p.key : undefined, p]);
  else if (isObject(rawParams)) entries = Object.entries(rawParams).map(([k, p]) => [isObject(p) && p.key !== undefined ? p.key : k, p]);
  else return { error: "parameters must be a list of { key, ... } or a map { key: { ... } }" };
  if (entries.length > RC_LIMITS.parameters) return { error: `At most ${RC_LIMITS.parameters} parameters per app` };
  const parameters: RemoteConfigParameter[] = [];
  for (const [key, item] of entries) {
    const p = parseParameter(item, key, names);
    if ("error" in p) return p;
    if (parameters.some((x) => x.key === p.key)) return { error: `Parameter "${p.key}" appears twice` };
    parameters.push(p);
  }
  const config = { conditions, parameters };
  if (bytes(JSON.stringify(config)) > RC_LIMITS.configBytes) return { error: `The whole config is larger than ${RC_LIMITS.configBytes / 1024} KB` };
  return config;
}

export function configWarnings(config: StoredRemoteConfig): string[] {
  const out: string[] = [];
  const used = new Set(config.parameters.flatMap((p) => Object.keys(p.conditionalValues)));
  for (const c of config.conditions) {
    if (c.unsupported) out.push(`Condition "${c.name}" uses targeting Revflare cannot evaluate${c.expression ? ` (${c.expression})` : ""}: it never matches.`);
    else if (!used.has(c.name)) out.push(`Condition "${c.name}" is not used by any parameter.`);
  }
  return out;
}

export function configView(config: StoredRemoteConfig, updatedAt: number | null): RemoteConfig {
  return { conditions: config.conditions, parameters: config.parameters, version: shortHash(JSON.stringify(config)), updatedAt, warnings: configWarnings(config) };
}

// --- Compiled form and evaluation -------------------------------------------------------------------------------------

/**
 * What remote config needs of a running or stopped experiment (worker/lib/experiments.ts owns the rest): both serve
 * their assignments from the compiled payload until the experiment is rolled out or archived.
 */
export interface ActiveExperiment {
  id: string;
  keys: string[];
  /** Each key's parameter type when the experiment was saved (a config change may not change it). */
  types: Record<string, RemoteConfigValueType>;
  variants: { id: string; weight: number; values: Record<string, unknown> }[];
  targeting: string | null;
  traffic: number;
}

/** An experiment in the compiled payload: `cond` is the targeting condition's index. */
export interface CompiledExperiment {
  id: string;
  keys: string[];
  cond?: number;
  traffic: number;
  variants: { id: string; weight: number; values: Record<string, unknown> }[];
}

/** What the SDK endpoint keeps in memory: conditions in priority order, each parameter's values by condition index. */
export interface CompiledRemoteConfig {
  conditions: { name: string; rules: RemoteConfigRule[]; never?: true }[];
  parameters: { key: string; value?: unknown; inApp?: true; conditional: { i: number; value?: unknown; inApp?: true }[] }[];
  experiments?: CompiledExperiment[];
}

export function compile(config: StoredRemoteConfig, experiments: ActiveExperiment[] = []): CompiledRemoteConfig {
  const index = new Map(config.conditions.map((c, i) => [c.name, i]));
  const out: CompiledRemoteConfig = {
    conditions: config.conditions.map((c) => (c.unsupported ? { name: c.name, rules: c.rules, never: true as const } : { name: c.name, rules: c.rules })),
    parameters: config.parameters.map((p) => ({
      key: p.key,
      ...(p.useInAppDefault ? { inApp: true as const } : { value: p.defaultValue }),
      conditional: Object.entries(p.conditionalValues)
        .map(([name, v]) => ({ i: index.get(name)!, ...(isInAppDefault(v) ? { inApp: true as const } : { value: v }) }))
        .filter((x) => x.i !== undefined)
        .sort((a, b) => a.i - b.i),
    })),
  };
  const compiled: CompiledExperiment[] = [];
  for (const x of experiments) {
    const cond = x.targeting ? index.get(x.targeting) : undefined;
    // A targeting condition that no longer exists matches nobody (config changes refuse this, see experimentConflict).
    if (x.targeting && cond === undefined) continue;
    compiled.push({ id: x.id, keys: x.keys, ...(cond !== undefined ? { cond } : {}), traffic: x.traffic, variants: x.variants.map((v) => ({ id: v.id, weight: v.weight, values: v.values })) });
  }
  if (compiled.length) out.experiments = compiled;
  return out;
}

/** The device, as RevflareKit describes it (and the request's country). */
export interface DeviceContext {
  installId?: string | null;
  appVersion?: string | null;
  appBuild?: string | null;
  osVersion?: string | null;
  locale?: string | null;
  /** App Store storefront, alpha-2. */
  storefront?: string | null;
  /** The request's country (Cloudflare), alpha-2. */
  ipCountry?: string | null;
  sdkVersion?: string | null;
  /** Acquisition source from RevflareKit's attribution report (null: the device sent none: no source rule matches). */
  source?: InstallSource | null;
  /** Apple Ads ids of an attributed install. */
  campaign?: string | null;
  adGroup?: string | null;
  keyword?: string | null;
  /** The build; missing = production (older SDKs). */
  environment?: SdkEnvironment;
}

/** Alpha-2 country from a storefront / request country ("CHN" and "cn" work too); null if not a country. */
export function countryCode(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const c = toAlpha2(v.trim());
  return c && COUNTRY_NAMES[c] ? c : null;
}

/** Cleans query / body values into a DeviceContext (lengths capped, countries validated, invalid acquisition values ignored). */
export function deviceContext(q: Record<string, unknown>, ipCountry: unknown): DeviceContext {
  const str = (v: unknown, max = 64) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const adsId = (v: unknown) => (typeof v === "string" && ADS_ID_RE.test(v.trim()) ? v.trim() : null);
  return {
    source: isInstallSource(q.source) ? q.source : null,
    campaign: adsId(q.campaign),
    adGroup: adsId(q.adGroup),
    keyword: adsId(q.keyword),
    environment: parseSdkEnvironment(q.environment),
    installId: str(q.installId),
    appVersion: str(q.appVersion, 32),
    appBuild: str(q.appBuild, 32),
    osVersion: str(q.osVersion, 32),
    locale: str(q.locale),
    storefront: countryCode(q.storefront),
    ipCountry: countryCode(ipCountry),
    sdkVersion: str(q.sdkVersion ?? q.sdk, 32),
  };
}

/** Semantic comparison: numeric parts ("2.10" > "2.9"), missing parts are 0 ("2.1" == "2.1.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = parseInt(x, 10);
    const ny = parseInt(y, 10);
    const dx = Number.isNaN(nx) ? 0 : nx;
    const dy = Number.isNaN(ny) ? 0 : ny;
    if (dx !== dy) return dx < dy ? -1 : 1;
    if (x !== y && Number.isNaN(nx) !== Number.isNaN(ny)) return Number.isNaN(nx) ? -1 : 1;
  }
  return 0;
}

function versionMatches(device: string | null | undefined, op: RemoteConfigVersionOp, value: string): boolean {
  if (!device) return false;
  const c = compareVersions(device, value);
  switch (op) {
    case ">=":
      return c >= 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    case "==":
      return c === 0;
    case "!=":
      return c !== 0;
  }
}

/** Experiment ids (exp_…) seed their assignment buckets: condition names and percent seeds may not take that form. */
export const isExperimentSeed = (s: string) => /^exp_[a-z0-9]{1,40}$/.test(s);

/** Deterministic bucket in [0, 100) of an install for a seed: sha256(installId + seed), first 4 bytes. */
export async function percentBucket(installId: string, seed: string): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(installId.toLowerCase() + seed)));
  const n = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return (n / 2 ** 32) * 100;
}

/**
 * The variant of an install in an experiment, or null (not enrolled): one bucket b = percentBucket(installId,
 * experiment id) in [0, 100); enrolled when b < traffic, then b / traffic spread over the variants by weight.
 */
export async function assignVariant(installId: string, x: { id: string; traffic: number; variants: { id: string; weight: number }[] }): Promise<string | null> {
  if (!installId || !x.variants.length) return null;
  const b = await percentBucket(installId, x.id);
  if (b >= x.traffic) return null;
  const u = (b / x.traffic) * 100;
  let cum = 0;
  for (const v of x.variants) {
    cum += v.weight;
    if (u < cum) return v.id;
  }
  return x.variants[x.variants.length - 1].id;
}

function localeMatches(device: string | null | undefined, values: string[], languageOnly: boolean): boolean {
  if (!device) return false;
  const full = normLocale(device);
  const parts = full.split("_");
  const language = parts[0];
  const region = parts.length > 1 && /^[a-z]{2}$/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : null;
  const short = region ? `${language}_${region}` : language;
  // language: "zh" matches any zh locale, "zh_hans" matches zh-Hans_CN; locale: the whole identifier or language_REGION.
  return values.some((v) => v === full || v === short || (languageOnly && (v === language || full.startsWith(`${v}_`))));
}

async function ruleMatches(rule: RemoteConfigRule, d: DeviceContext, conditionName: string, buckets: Map<string, number>): Promise<boolean> {
  switch (rule.type) {
    case "country": {
      const c = d.storefront ?? d.ipCountry;
      return !!c && rule.values.includes(c);
    }
    case "ip_country":
      return !!d.ipCountry && rule.values.includes(d.ipCountry);
    case "storefront":
      return !!d.storefront && rule.values.includes(d.storefront);
    case "language":
      return localeMatches(d.locale, rule.values, true);
    case "locale":
      return localeMatches(d.locale, rule.values, false);
    case "install_id":
      return !!d.installId && rule.values.includes(d.installId.toLowerCase());
    case "app_version":
      return versionMatches(d.appVersion, rule.op, rule.value);
    case "app_build":
      return versionMatches(d.appBuild, rule.op, rule.value);
    case "os_version":
      return versionMatches(d.osVersion, rule.op, rule.value);
    case "sdk_version":
      return versionMatches(d.sdkVersion, rule.op, rule.value);
    case "source":
      return !!d.source && rule.values.includes(d.source);
    case "apple_ads_campaign":
      return !!d.campaign && rule.values.includes(d.campaign);
    case "apple_ads_ad_group":
      return !!d.adGroup && rule.values.includes(d.adGroup);
    case "apple_ads_keyword":
      return !!d.keyword && rule.values.includes(d.keyword);
    case "environment":
      return rule.values.includes(d.environment ?? "production");
    case "percent": {
      if (!d.installId) return false;
      const seed = rule.seed ?? conditionName;
      let b = buckets.get(seed);
      if (b === undefined) buckets.set(seed, (b = await percentBucket(d.installId, seed)));
      return b >= rule.from && b < rule.to;
    }
  }
}

/** Resolves a device's values. `version` is a hash of the response itself, so it changes only when the device's response does. */
export async function evaluate(config: CompiledRemoteConfig, d: DeviceContext): Promise<RemoteConfigEvaluation> {
  const buckets = new Map<string, number>();
  const matched: boolean[] = [];
  for (const c of config.conditions) {
    let ok = !c.never;
    for (const r of c.rules) {
      if (!ok) break;
      ok = await ruleMatches(r, d, c.name, buckets);
    }
    matched.push(ok);
  }
  const values: Record<string, unknown> = {};
  const parameters: RemoteConfigEvaluation["parameters"] = {};
  for (const p of config.parameters) {
    const hit = p.conditional.find((x) => matched[x.i]);
    const src = hit ?? p;
    const condition = hit ? config.conditions[hit.i].name : null;
    if (src.inApp) parameters[p.key] = { condition, useInAppDefault: true };
    else {
      values[p.key] = src.value;
      parameters[p.key] = { condition, useInAppDefault: false, value: src.value };
    }
  }
  // Experiments: enrolled devices get their variant's values for the experiment's keys (over conditions and defaults).
  const experiments: SdkExperimentAssignment[] = [];
  for (const x of config.experiments ?? []) {
    if (!d.installId) break;
    if (x.cond !== undefined && !matched[x.cond]) continue;
    const id = await assignVariant(d.installId, x);
    const variant = id ? x.variants.find((v) => v.id === id) : undefined;
    if (!variant) continue;
    for (const key of x.keys) {
      if (!(key in variant.values)) continue;
      values[key] = variant.values[key];
      parameters[key] = { condition: null, useInAppDefault: false, value: variant.values[key], experiment: x.id, variant: variant.id };
    }
    experiments.push({ id: x.id, variant: variant.id, keys: x.keys });
  }
  const conditions = config.conditions.filter((_, i) => matched[i]).map((c) => c.name);
  const country = d.storefront ?? d.ipCountry ?? null;
  // Without experiments the version is the one devices had before experiments existed.
  const version = shortHash(JSON.stringify(experiments.length ? ["rc1", values, conditions, country, experiments] : ["rc1", values, conditions, country]));
  return { version, values, conditions, country, ...(experiments.length ? { experiments } : {}), parameters };
}

/** The SDK body: { version, values, conditions, country } and `experiments` when the device is enrolled in any. */
export function sdkBody(e: RemoteConfigEvaluation): SdkRemoteConfig {
  return { version: e.version, values: e.values, conditions: e.conditions, country: e.country, ...(e.experiments?.length ? { experiments: e.experiments } : {}) };
}

// --- Firebase Remote Config import ------------------------------------------------------------------------------------

const FIREBASE_TYPES: Record<string, RemoteConfigValueType> = { STRING: "string", NUMBER: "number", BOOLEAN: "boolean", JSON: "json" };

/** Splits on && outside quotes, brackets and parentheses. */
function splitAnd(expr: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && expr.startsWith("&&", i)) {
      out.push(expr.slice(start, i));
      start = i + 2;
      i++;
    } else if (depth === 0 && (expr.startsWith("||", i) || ch === "!")) {
      if (!(ch === "!" && expr[i + 1] === "=")) return null;
    }
  }
  out.push(expr.slice(start));
  return out.map((s) => s.trim());
}

const unwrap = (s: string): string => {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    const inner = t.slice(1, -1);
    let depth = 0;
    let balanced = true;
    for (const ch of inner) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth < 0) balanced = false;
    }
    if (!balanced || depth !== 0) break;
    t = inner.trim();
  }
  return t;
};

function stringList(s: string): string[] | null {
  const m = s.trim().match(/^\[(.*)\]$/s);
  if (!m) return null;
  const items = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1] ?? x[2]);
  return items.length ? items : null;
}

/** One Firebase condition term → a rule, true (always), or null (unsupported). */
function convertTerm(term: string, conditionName: string): RemoteConfigRule | true | null {
  const t = unwrap(term);
  if (t === "true") return true;
  if (t === "false") return { type: "percent", from: 0, to: 0 };
  let m = t.match(/^device\.(country|language)\s+in\s+(\[.*\])$/s);
  if (m) {
    const values = stringList(m[2]);
    return values ? { type: m[1] as "country" | "language", values } : null;
  }
  m = t.match(/^device\.(country|language)\s*==\s*['"]([^'"]+)['"]$/);
  if (m) return { type: m[1] as "country" | "language", values: [m[2]] };
  m = t.match(/^device\.os\s*==\s*['"]([^'"]+)['"]$/);
  if (m) return m[1].toLowerCase() === "ios" ? true : null;
  m = t.match(/^app\.id\s*==\s*['"]([^'"]+)['"]$/);
  if (m) return m[1].includes(":ios:") ? true : null;
  m = t.match(/^app\.(version|build)\.(>=|<=|==|!=|>|<|exactlyMatches)\(\s*(\[.*\])\s*\)$/s);
  if (m) {
    const values = stringList(m[3]);
    if (!values || values.length !== 1) return null;
    const op = (m[2] === "exactlyMatches" ? "==" : m[2]) as RemoteConfigVersionOp;
    return { type: m[1] === "version" ? "app_version" : "app_build", op, value: values[0] };
  }
  m = t.match(/^percent(?:\(\s*['"]([^'"]*)['"]\s*\))?\s*(?:(<=|<|>=|>)\s*(\d+(?:\.\d+)?)|between\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?))$/);
  if (m) {
    const seed = m[1] || undefined;
    const rule = (from: number, to: number): RemoteConfigRule => ({ type: "percent", from: Math.max(0, from), to: Math.min(100, to), ...(seed && seed !== conditionName ? { seed } : {}) });
    if (m[2]) {
      const n = Number(m[3]);
      return m[2].startsWith("<") ? rule(0, n) : rule(n, 100);
    }
    const a = Number(m[4]);
    const b = Number(m[5]);
    return a <= b ? rule(a, b) : null;
  }
  return null;
}

/** A Firebase condition → a Revflare condition (unsupported: never matches, expression kept). */
export function convertFirebaseCondition(c: { name: string; expression: string; tagColor?: string }): { condition: RemoteConfigCondition; unsupported: string[] } {
  const terms = splitAnd(c.expression ?? "");
  const color = typeof c.tagColor === "string" && (RC_CONDITION_COLORS as readonly string[]).includes(c.tagColor.toLowerCase()) ? (c.tagColor.toLowerCase() as RemoteConfigCondition["color"]) : undefined;
  const base: RemoteConfigCondition = { name: c.name, ...(color ? { color } : {}), rules: [] };
  if (!terms) return { condition: { ...base, unsupported: true, expression: c.expression }, unsupported: [c.expression] };
  const unsupported: string[] = [];
  for (const term of terms) {
    const r = convertTerm(term, c.name);
    if (r === null) unsupported.push(term);
    else if (r !== true) {
      // Normalize through the validator (uppercase countries, locale form); invalid values make the term unsupported.
      const parsed = parseRule(r, `Condition "${c.name}"`);
      if ("error" in parsed) unsupported.push(term);
      else base.rules.push(parsed);
    }
  }
  if (unsupported.length) return { condition: { ...base, unsupported: true, expression: c.expression }, unsupported };
  return { condition: base, unsupported };
}

function firebaseValue(v: unknown): { kind: "value"; raw: string } | { kind: "inApp" } | { kind: "other"; what: string } {
  if (!isObject(v)) return { kind: "inApp" };
  if (v.useInAppDefault === true) return { kind: "inApp" };
  if (typeof v.value === "string") return { kind: "value", raw: v.value };
  return { kind: "other", what: Object.keys(v).join(", ") || "empty value" };
}

function fromFirebaseString(type: RemoteConfigValueType, raw: string): { value: unknown } | null {
  if (type === "string") return { value: raw };
  if (type === "json") {
    try {
      return { value: JSON.parse(raw) };
    } catch {
      return null;
    }
  }
  const r = coerceValue(type, raw, "");
  return "error" in r ? null : r;
}

/**
 * Converts a Firebase Remote Config template (`firebase remoteconfig:get`, REST API) into a Revflare config body.
 * Parameter groups are flattened; values convert by valueType; unsupported conditions are kept (never match) and
 * reported in `warnings`.
 */
export function convertFirebaseTemplate(template: unknown): { config: { conditions: RemoteConfigCondition[]; parameters: Record<string, unknown>[] }; warnings: string[]; unsupportedConditions: number } | Fail {
  if (!isObject(template)) return { error: "Expected a Firebase Remote Config template (JSON object with conditions / parameters / parameterGroups)" };
  if (template.conditions !== undefined && !Array.isArray(template.conditions)) return { error: "conditions must be a list" };
  if (template.parameters !== undefined && !isObject(template.parameters)) return { error: "parameters must be an object { key: { defaultValue, conditionalValues, valueType } }" };
  if (template.parameterGroups !== undefined && !isObject(template.parameterGroups)) return { error: "parameterGroups must be an object" };
  const warnings: string[] = [];
  const conditions: RemoteConfigCondition[] = [];
  const renamed = new Map<string, string>();
  let unsupportedConditions = 0;
  for (const raw of (template.conditions ?? []) as unknown[]) {
    if (!isObject(raw) || typeof raw.name !== "string" || typeof raw.expression !== "string") {
      warnings.push(`Skipped a condition without a name or expression: ${JSON.stringify(raw).slice(0, 120)}`);
      continue;
    }
    // Names Revflare does not allow ("20% rollout") are renamed; parameters' values follow the new name.
    let name = raw.name;
    const taken = (n: string) => !RC_CONDITION_NAME_RE.test(n) || isExperimentSeed(n) || conditions.some((x) => x.name === n);
    if (taken(name)) {
      const base = name.replace(/[^A-Za-z0-9_ .-]/g, "_").trim().slice(0, 60) || "condition";
      name = base;
      for (let n = 2; taken(name); n++) name = `${base}_${n}`;
      warnings.push(`Condition ${JSON.stringify(raw.name)} renamed "${name}" (names may use letters, digits, space _ . -, at most 64 characters).`);
    }
    renamed.set(raw.name, name);
    const { condition, unsupported } = convertFirebaseCondition({ ...(raw as { expression: string; tagColor?: string }), name });
    if (unsupported.length) {
      unsupportedConditions++;
      warnings.push(`Condition "${name}": ${unsupported.map((u) => `"${u}"`).join(", ")} not supported: imported as a condition that never matches.`);
    }
    conditions.push(condition);
  }
  const names = new Set(conditions.map((c) => c.name));
  const all: [string, unknown, string | null][] = Object.entries((template.parameters ?? {}) as Record<string, unknown>).map(([k, v]) => [k, v, null]);
  for (const [group, g] of Object.entries((template.parameterGroups ?? {}) as Record<string, unknown>)) {
    if (isObject(g) && isObject(g.parameters)) for (const [k, v] of Object.entries(g.parameters)) all.push([k, v, group]);
  }
  const parameters = new Map<string, Record<string, unknown>>();
  for (const [key, raw, group] of all) {
    const where = `Parameter "${key}"${group ? ` (group "${group}")` : ""}`;
    if (!RC_PARAMETER_KEY_RE.test(key)) {
      warnings.push(`${where}: skipped, keys may use letters, digits, _ . - (at most 128 characters).`);
      continue;
    }
    if (!isObject(raw)) {
      warnings.push(`${where}: skipped, not an object.`);
      continue;
    }
    if (parameters.has(key)) warnings.push(`${where}: defined twice, the last one is kept.`);
    let type: RemoteConfigValueType = FIREBASE_TYPES[String(raw.valueType ?? "STRING").toUpperCase()] ?? "string";
    const def = raw.defaultValue === undefined ? ({ kind: "inApp" } as const) : firebaseValue(raw.defaultValue);
    const conds: [string, ReturnType<typeof firebaseValue>][] = [];
    for (const [cond, cv] of Object.entries(isObject(raw.conditionalValues) ? raw.conditionalValues : {})) {
      const target = renamed.get(cond);
      if (!target || !names.has(target)) {
        warnings.push(`${where}: value for unknown condition "${cond}" skipped.`);
        continue;
      }
      conds.push([target, firebaseValue(cv)]);
    }
    const values = [def, ...conds.map(([, v]) => v)];
    for (const v of values) if (v.kind === "other") warnings.push(`${where}: ${v.what} (personalization / rollout values) not supported: the in-app default applies instead.`);
    // Values that do not fit the declared type: keep everything as strings.
    if (type !== "string" && values.some((v) => v.kind === "value" && !fromFirebaseString(type, v.raw))) {
      warnings.push(`${where}: a value is not a valid ${type}: imported as a string parameter.`);
      type = "string";
    }
    const conv = (v: ReturnType<typeof firebaseValue>) => (v.kind === "value" ? fromFirebaseString(type, v.raw)!.value : { useInAppDefault: true });
    const p: Record<string, unknown> = { key, type };
    if (typeof raw.description === "string" && raw.description) p.description = raw.description.slice(0, 1000);
    if (def.kind === "value") p.defaultValue = conv(def);
    else p.useInAppDefault = true;
    p.conditionalValues = Object.fromEntries(conds.map(([c, v]) => [c, conv(v)]));
    parameters.delete(key);
    parameters.set(key, p);
  }
  return { config: { conditions, parameters: [...parameters.values()] }, warnings, unsupportedConditions };
}

/** Merge: parameters by key (imported ones win), conditions by name (replaced in place, new ones appended). */
export function mergeConfigs(base: StoredRemoteConfig, add: { conditions: RemoteConfigCondition[]; parameters: Record<string, unknown>[] }): { conditions: unknown[]; parameters: unknown[] } {
  const conditions: unknown[] = base.conditions.map((c) => add.conditions.find((x) => x.name === c.name) ?? c);
  for (const c of add.conditions) if (!base.conditions.some((x) => x.name === c.name)) conditions.push(c);
  const parameters: unknown[] = base.parameters.map((p) => add.parameters.find((x) => x.key === p.key) ?? p);
  for (const p of add.parameters) if (!base.parameters.some((x) => x.key === p.key)) parameters.push(p);
  return { conditions, parameters };
}

// --- Database ---------------------------------------------------------------------------------------------------------

interface ConfigRow {
  id: string;
  sdk_key: string | null;
  config: string | null;
  updated_at: number | null;
}

const ROW_SQL =
  "SELECT a.id, a.sdk_key, r.config, r.updated_at FROM apps a LEFT JOIN remote_configs r ON r.app_id = a.id WHERE a.id = ? AND a.workspace_id = ?";

/** The stored config of an app (null: no such app in the workspace). One indexed read. */
export async function readRemoteConfig(db: Db, workspaceId: string, appId: string): Promise<{ config: StoredRemoteConfig; updatedAt: number | null } | null> {
  const row = await db.prepare(ROW_SQL).bind(appId, workspaceId).first<ConfigRow>();
  if (!row) return null;
  return { config: parseJson(row.config, EMPTY_REMOTE_CONFIG), updatedAt: row.updated_at };
}

/** Running and stopped experiments of an app (index on app_id, status). */
export async function activeExperiments(db: Db, appId: string): Promise<ActiveExperiment[]> {
  const { results } = await db
    .prepare("SELECT id, definition FROM experiments WHERE app_id = ? AND status IN ('running', 'stopped') ORDER BY started_at, id")
    .bind(appId)
    .all<{ id: string; definition: string }>();
  return results.map((r) => {
    const d = parseJson<Partial<ActiveExperiment>>(r.definition, {});
    return { id: r.id, keys: d.keys ?? [], types: d.types ?? {}, variants: d.variants ?? [], targeting: d.targeting ?? null, traffic: d.traffic ?? 100 };
  });
}

/** Why a config cannot replace the current one while these experiments serve assignments (null: it can). */
export function experimentConflict(config: StoredRemoteConfig, active: ActiveExperiment[]): string | null {
  for (const x of active) {
    for (const key of x.keys) {
      const p = config.parameters.find((q) => q.key === key);
      if (!p) return `Parameter "${key}" is used by experiment ${x.id}: roll it out or archive it before removing the parameter`;
      if (x.types[key] && p.type !== x.types[key]) return `Parameter "${key}" is used by experiment ${x.id}: its type must stay ${x.types[key]}`;
    }
    if (x.targeting && !config.conditions.some((c) => c.name === x.targeting))
      return `Condition "${x.targeting}" targets experiment ${x.id}: roll it out or archive it before removing or renaming the condition`;
  }
  return null;
}

/** Version of the compiled payload (the SDK cache entry): the config's own version without experiments. */
function payloadVersion(config: StoredRemoteConfig, compiled: CompiledRemoteConfig): string {
  const v = shortHash(JSON.stringify(config));
  return compiled.experiments?.length ? shortHash(JSON.stringify([v, compiled.experiments])) : v;
}

/** Writes an app's config and its compiled payload (one row). */
export async function saveRemoteConfig(db: Db, appId: string, config: StoredRemoteConfig, active: ActiveExperiment[], at: number): Promise<void> {
  const compiled = compile(config, active);
  await db
    .prepare(
      `INSERT INTO remote_configs (app_id, config, sdk_json, version, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET config = excluded.config, sdk_json = excluded.sdk_json, version = excluded.version, updated_at = excluded.updated_at`,
    )
    .bind(appId, JSON.stringify(config), JSON.stringify(compiled), payloadVersion(config, compiled), at)
    .run();
}

/** Rewrites only the compiled payload (an experiment started, rolled out or archived); the config is unchanged. */
export async function recompileRemoteConfig(db: Db, appId: string): Promise<void> {
  const row = await db.prepare("SELECT config FROM remote_configs WHERE app_id = ?").bind(appId).first<{ config: string }>();
  if (!row) return;
  const config = parseJson<StoredRemoteConfig>(row.config, EMPTY_REMOTE_CONFIG);
  const compiled = compile(config, await activeExperiments(db, appId));
  await db.prepare("UPDATE remote_configs SET sdk_json = ?, version = ? WHERE app_id = ?").bind(JSON.stringify(compiled), payloadVersion(config, compiled), appId).run();
}

export type RemoteConfigOp =
  | { kind: "replace"; body: unknown }
  | { kind: "import"; template: unknown; merge: boolean; dryRun: boolean };

export type RemoteConfigChangeResult =
  | { status: 200; result: RemoteConfig | RemoteConfigImport; sdkKey: string | null; changed: boolean }
  | { status: 400 | 404; error: string };

/** Applies a change inside the database object (atomic read-modify-write). Writes only when something changed. */
export const changeRemoteConfig = defineDbFunction(
  "remoteConfig.change",
  async (db, args: { workspaceId: string; appId: string; op: RemoteConfigOp }): Promise<RemoteConfigChangeResult> => {
    const row = await db.prepare(ROW_SQL).bind(args.appId, args.workspaceId).first<ConfigRow>();
    if (!row) return { status: 404, error: "Not found" };
    const current = parseJson<StoredRemoteConfig>(row.config, EMPTY_REMOTE_CONFIG);
    const op = args.op;
    let body: unknown;
    let importInfo: { warnings: string[]; reported: string[]; imported: RemoteConfigImport["imported"] } | null = null;
    if (op.kind === "replace") body = op.body;
    else {
      const conv = convertFirebaseTemplate(op.template);
      if ("error" in conv) return { status: 400, error: conv.error };
      body = op.merge ? mergeConfigs(current, conv.config) : conv.config;
      const reported = conv.config.conditions.filter((c) => c.unsupported).map((c) => `Condition "${c.name}" uses targeting`);
      importInfo = { warnings: conv.warnings, reported, imported: { parameters: conv.config.parameters.length, conditions: conv.config.conditions.length, unsupportedConditions: conv.unsupportedConditions } };
    }
    const parsed = parseRemoteConfig(body);
    if ("error" in parsed) return { status: 400, error: parsed.error };
    const active = await activeExperiments(db, row.id);
    const conflict = experimentConflict(parsed, active);
    if (conflict) return { status: 400, error: conflict };
    const json = JSON.stringify(parsed);
    const dryRun = op.kind === "import" && op.dryRun;
    let updatedAt = row.updated_at;
    const changed = json !== row.config && !(row.config === null && json === JSON.stringify(EMPTY_REMOTE_CONFIG));
    if (changed && !dryRun) {
      const at = now();
      await saveRemoteConfig(db, row.id, parsed, active, at);
      updatedAt = at;
    }
    const view = configView(parsed, updatedAt);
    const result: RemoteConfig | RemoteConfigImport = importInfo
      ? { ...view, warnings: [...importInfo.warnings, ...view.warnings.filter((w) => !importInfo!.reported.some((r) => w.startsWith(r)))], dryRun, merged: op.kind === "import" && op.merge, imported: importInfo.imported }
      : view;
    return { status: 200, result, sdkKey: row.sdk_key, changed: changed && !dryRun };
  },
);

const EMPTY_COMPILED = JSON.stringify(compile(EMPTY_REMOTE_CONFIG));

/** Compiled config by SDK key (null: unknown key). One indexed read of the app row and its config row. */
export async function readSdkRemoteConfig(db: Db, sdkKey: string): Promise<{ body: string; version: string } | null> {
  const row = await db
    .prepare("SELECT r.sdk_json, r.version FROM apps a LEFT JOIN remote_configs r ON r.app_id = a.id WHERE a.sdk_key = ?")
    .bind(sdkKey)
    .first<{ sdk_json: string | null; version: string | null }>();
  if (!row) return null;
  if (row.sdk_json && row.version) return { body: row.sdk_json, version: row.version };
  return { body: EMPTY_COMPILED, version: shortHash(JSON.stringify(EMPTY_REMOTE_CONFIG)) };
}
