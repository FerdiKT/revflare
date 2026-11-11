import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
import { SKILL_MD } from "../src/skill-content.js";

// `revflare skill install`: writes the SKILL.md bundled at build time (scripts/embed-skill.mjs).

let out = "";
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("skill install", () => {
  it("bundles the current skills/revflare/SKILL.md (run npm run cli:build when this fails)", () => {
    const source = readFileSync(new URL("../../skills/revflare/SKILL.md", import.meta.url), "utf8");
    expect(SKILL_MD).toBe(source);
    expect(SKILL_MD).toMatch(/^---\nname: revflare\n/);
  });

  it("installs into ~/.claude/skills/revflare by default, then reports unchanged / updated", async () => {
    const home = mkdtempSync(join(tmpdir(), "revflare-skill-"));
    const env = { HOME: home };
    const path = join(home, ".claude", "skills", "revflare", "SKILL.md");
    expect(await run(["skill", "install", "--json"], { env })).toBe(0);
    expect(JSON.parse(out)).toEqual({ path, status: "installed" });
    expect(readFileSync(path, "utf8")).toBe(SKILL_MD);

    out = "";
    expect(await run(["skill", "install", "--json"], { env })).toBe(0);
    expect(JSON.parse(out).status).toBe("unchanged");

    writeFileSync(path, "old");
    out = "";
    expect(await run(["skill", "install"], { env })).toBe(0);
    expect(out).toContain("Skill updated");
    expect(readFileSync(path, "utf8")).toBe(SKILL_MD);
  });

  it("--dir picks another skills directory (~ expanded)", async () => {
    const home = mkdtempSync(join(tmpdir(), "revflare-skill-"));
    expect(await run(["skill", "install", "--dir", "~/project/.claude/skills", "--json"], { env: { HOME: home } })).toBe(0);
    expect(JSON.parse(out).path).toBe(join(home, "project", ".claude", "skills", "revflare", "SKILL.md"));
    expect(await run(["skill", "install", "extra"], { env: { HOME: home } })).toBe(2);
  });
});
