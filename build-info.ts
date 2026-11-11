// Build-time constants for the Worker and the web app (Vite `define`): version from package.json and the git commit.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function commit(): string {
  const fromEnv = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"], cwd: new URL(".", import.meta.url) }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

export function buildDefines(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
  return {
    __REVFLARE_VERSION__: JSON.stringify(pkg.version),
    __REVFLARE_COMMIT__: JSON.stringify(commit()),
  };
}
