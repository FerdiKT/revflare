import { afterEach, describe, expect, it, vi } from "vitest";
import { commandHelp, parseCommand, splitCommand } from "../src/args.js";
import { intervalQuery, parseMetric, rangeQuery } from "../src/commands/common.js";
import { UsageError } from "../src/errors.js";
import { COMMANDS, run } from "../src/main.js";
import { capture } from "./helpers.js";

const names = COMMANDS.map((c) => c.name);
const def = (name: string) => COMMANDS.find((c) => c.name === name)!;

afterEach(() => vi.restoreAllMocks());

describe("splitCommand", () => {
  it("finds one- and two-word commands, with global flags first", () => {
    expect(splitCommand(["chart", "mrr", "--range", "12m"], names)).toMatchObject({ name: "chart", rest: ["mrr", "--range", "12m"] });
    expect(splitCommand(["import", "revenuecat-charts", "--dry-run"], names)).toMatchObject({ name: "import revenuecat-charts", rest: ["--dry-run"] });
    expect(splitCommand(["--json", "jobs", "show", "job_1"], names)).toMatchObject({ name: "jobs show", rest: ["--json", "job_1"] });
    expect(splitCommand(["--profile", "work", "overview"], names)).toMatchObject({ name: "overview", rest: ["--profile", "work"] });
    expect(splitCommand(["goals"], names)).toMatchObject({ name: "goals", rest: [] });
    expect(splitCommand(["goals", "add", "--target", "10"], names)).toMatchObject({ name: "goals add", rest: ["--target", "10"] });
    expect(splitCommand(["app", "com.example.app"], names)).toMatchObject({ name: "app", rest: ["com.example.app"] });
    expect(splitCommand(["import"], names).name).toBeNull();
  });
});

describe("parseCommand", () => {
  it("parses repeatable options, short flags and globals", () => {
    const { values, positionals } = parseCommand(def("chart"), ["revenue", "-r", "90d", "--app", "a", "-a", "b,c", "--group-by", "country", "--json"]);
    expect(positionals).toEqual(["revenue"]);
    expect(values.range).toBe("90d");
    expect(values.app).toEqual(["a", "b,c"]);
    expect(values["group-by"]).toBe("country");
    expect(values.json).toBe(true);
  });

  it("rejects unknown flags and wrong positional counts", () => {
    expect(() => parseCommand(def("chart"), ["--bogus"])).toThrow(UsageError);
    expect(() => parseCommand(def("chart"), [])).toThrow(/Missing argument/);
    expect(() => parseCommand(def("customer"), ["a", "b"])).toThrow(/Unexpected argument/);
    expect(parseCommand(def("chart"), ["--help"]).values.help).toBe(true);
  });

  it("validates ranges, intervals and metrics", () => {
    expect(rangeQuery({ range: "12m" })).toEqual({ range: "12m", from: undefined, to: undefined });
    expect(rangeQuery({ from: "2026-01-01", to: "2026-02-01" })).toMatchObject({ from: "2026-01-01", to: "2026-02-01" });
    expect(() => rangeQuery({ range: "forever" })).toThrow(/Invalid --range/);
    expect(() => rangeQuery({ from: "01/02/2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => rangeQuery({ range: "30d", from: "2026-01-01" })).toThrow(/either/);
    expect(intervalQuery({ interval: "week" })).toBe("week");
    expect(() => intervalQuery({ interval: "year" })).toThrow(UsageError);
    expect(parseMetric("active-subscriptions", "revenue")).toBe("active_subscriptions");
    expect(parseMetric(undefined, "revenue")).toBe("revenue");
    expect(() => parseMetric("profit", "revenue")).toThrow(/Unknown metric/);
  });

  it("every command has help with its options", () => {
    for (const cmd of COMMANDS) {
      const help = commandHelp(cmd);
      expect(help).toContain(`revflare ${cmd.name}`);
      for (const k of Object.keys(cmd.options ?? {})) expect(help).toContain(`--${k}`);
    }
  });
});

describe("run: exit codes", () => {
  it("0 for help and version, 2 for usage errors, 1 for errors", async () => {
    const out = capture();
    expect(await run(["--help"])).toBe(0);
    expect(out.stdout).toContain("Usage: revflare <command>");
    expect(await run(["chart", "--help"])).toBe(0);
    expect(out.stdout).toContain("--group-by");
    expect(await run(["help", "import", "revenuecat-charts"])).toBe(0);
    expect(out.stdout).toContain("revflare import revenuecat-charts");
    expect(await run(["--version"])).toBe(0);
    expect(await run(["frobnicate"])).toBe(2);
    expect(out.stderr).toContain('unknown command "frobnicate"');
    expect(await run(["import", "nothing"])).toBe(2);
    expect(out.stderr).toContain("revflare import apple");
    expect(await run(["chart", "revenue", "--frob"])).toBe(2);
    expect(await run(["overview"], { env: { REVFLARE_CONFIG: "/nonexistent/revflare.json" } })).toBe(1);
    expect(out.stderr).toContain("Not logged in");
  });
});
