// Command registry and argument parsing on top of node:util parseArgs.

import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";

export interface OptionSpec {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  /** Placeholder in help, e.g. "<id>". */
  arg?: string;
  description: string;
}

export type Options = Record<string, OptionSpec>;

export interface Parsed {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export interface CommandDef {
  /** "post", "media upload", "posts show"... */
  name: string;
  /** "<id>", "<files...>" for help. */
  args?: string;
  summary: string;
  description?: string;
  options?: Options;
  examples?: string[];
  /** Positional argument count bounds. */
  min?: number;
  max?: number;
  /** Hidden from the command list (aliases). */
  hidden?: boolean;
}

export const GLOBAL_OPTIONS: Options = {
  json: { type: "boolean", description: "Print JSON (stable, machine-readable) instead of tables" },
  profile: { type: "string", arg: "<name>", description: "Config profile to use (default: the logged-in one; env REVFLARE_PROFILE)" },
  "no-color": { type: "boolean", description: "Disable colors (also NO_COLOR=1)" },
  help: { type: "boolean", short: "h", description: "Show help" },
};

const GLOBAL_WITH_VALUE = new Set(["--profile"]);

/**
 * Find the command words at the start of argv (global flags may come first). Returns the matched command name and
 * the remaining arguments.
 */
export function splitCommand(argv: string[], names: string[]): { name: string | null; rest: string[]; words: string[] } {
  const words: number[] = [];
  for (let i = 0; i < argv.length && words.length < 2; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (GLOBAL_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      // A flag before any word is global; after the first word, stop: the rest belongs to the command.
      if (words.length) break;
      continue;
    }
    if (words.length && words[words.length - 1] !== i - 1) break;
    words.push(i);
  }
  const w = words.map((i) => argv[i]);
  let name: string | null = null;
  if (w.length >= 2 && names.includes(`${w[0]} ${w[1]}`)) name = `${w[0]} ${w[1]}`;
  else if (w.length >= 1 && names.includes(w[0])) name = w[0];
  const used = name ? name.split(" ").length : 0;
  const drop = new Set(words.slice(0, used));
  return { name, rest: argv.filter((_, i) => !drop.has(i)), words: w };
}

/** Parse the arguments of a command (strict: unknown flags are usage errors). */
export function parseCommand(def: CommandDef, args: string[]): Parsed {
  const options = { ...GLOBAL_OPTIONS, ...(def.options ?? {}) };
  const config: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> = {};
  for (const [k, o] of Object.entries(options)) config[k] = { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) };
  let parsed;
  try {
    parsed = parseArgs({ args, options: config, allowPositionals: true, strict: true });
  } catch (err) {
    const msg = (err as Error).message.replace(/\. To specify a positional argument starting with a '-'.*$/s, "");
    throw new UsageError(msg, def.name);
  }
  const values = parsed.values as Parsed["values"];
  if (!values.help) {
    const n = parsed.positionals.length;
    if (def.min !== undefined && n < def.min) throw new UsageError(`Missing argument: revflare ${def.name} ${def.args ?? ""}`.trim(), def.name);
    if (def.max !== undefined && n > def.max) throw new UsageError(`Unexpected argument "${parsed.positionals[def.max]}"`, def.name);
  }
  return { values, positionals: parsed.positionals };
}

export function str(v: Parsed["values"][string]): string | undefined {
  if (Array.isArray(v)) return v[v.length - 1];
  return typeof v === "string" ? v : undefined;
}

export function list(v: Parsed["values"][string]): string[] {
  if (Array.isArray(v)) return v;
  return typeof v === "string" ? [v] : [];
}

function optionLines(opts: Options): string[] {
  const rows = Object.entries(opts).map(([k, o]) => [`${o.short ? `-${o.short}, ` : "    "}--${k}${o.arg ? ` ${o.arg}` : ""}${o.multiple ? " (repeatable)" : ""}`, o.description]);
  const w = Math.min(Math.max(...rows.map((r) => r[0].length)), 44);
  return rows.map(([a, b]) => `  ${a.padEnd(w)}  ${b}`);
}

export function commandHelp(def: CommandDef): string {
  const out = [`Usage: revflare ${def.name}${def.args ? ` ${def.args}` : ""}${def.options && Object.keys(def.options).length ? " [options]" : ""}`, "", def.summary];
  if (def.description) out.push("", def.description);
  if (def.options && Object.keys(def.options).length) out.push("", "Options:", ...optionLines(def.options));
  out.push("", "Global options:", ...optionLines(GLOBAL_OPTIONS));
  if (def.examples?.length) out.push("", "Examples:", ...def.examples.map((e) => `  ${e}`));
  return out.join("\n");
}
