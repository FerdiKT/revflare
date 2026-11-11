import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "../context.js";
import { c, println, printJson } from "../format.js";
import { SKILL_MD } from "../skill-content.js";

/** Expands a leading `~` with the home directory (HOME from the environment first, so tests can redirect it). */
function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export const skillInstall: Command = {
  name: "skill install",
  summary: "Install (or update) the Claude Code skill for this CLI into ~/.claude/skills/revflare.",
  description:
    "Writes the SKILL.md bundled with this CLI version to <dir>/revflare/SKILL.md (default dir: ~/.claude/skills,\n" +
    "Claude Code's personal skills). Use --dir .claude/skills for a project-level skill. Re-run after updating the CLI.",
  options: { dir: { type: "string", arg: "<path>", description: "Skills directory (default ~/.claude/skills)" } },
  max: 0,
  examples: ["revflare skill install", "revflare skill install --dir .claude/skills"],
  async run(ctx, { values }) {
    const home = ctx.env.HOME || ctx.env.USERPROFILE || homedir();
    const dir = resolve(expandHome(typeof values.dir === "string" ? values.dir : "~/.claude/skills", home));
    const path = join(dir, "revflare", "SKILL.md");
    let current: string | null = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      /* not installed yet */
    }
    const status = current === null ? "installed" : current === SKILL_MD ? "unchanged" : "updated";
    if (status !== "unchanged") {
      mkdirSync(join(dir, "revflare"), { recursive: true });
      writeFileSync(path, SKILL_MD);
    }
    if (ctx.json) return printJson({ path, status });
    println(
      status === "unchanged"
        ? `${c.green("✓")} Skill already up to date: ${path}`
        : `${c.green("✓")} Skill ${status}: ${path}\n${c.gray("Start a new Claude Code session to load it.")}`,
    );
  },
};
