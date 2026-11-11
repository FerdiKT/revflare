import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      // Pure unit tests (parsers, metrics math) in Node.
      {
        resolve: { alias: { "cloudflare:workers": stub } },
        test: { name: "node", include: ["test/**/*.test.ts"], exclude: ["test/workers/**"], environment: "node" },
      },
      // The `revflare` CLI (cli/), plain Node.
      { test: { name: "cli", include: ["cli/test/**/*.test.ts"], environment: "node" } },
      // Integration tests: the real app against a local Durable Object database and R2 inside workerd.
      "./vitest.workers.config.ts",
      "./vitest.workers-b.config.ts",
      "./vitest.workers-c.config.ts",
    ],
  },
});
