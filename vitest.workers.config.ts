import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { readFileSync } from "node:fs";
import { buildDefines } from "./build-info";

const chain = JSON.parse(
  readFileSync(
    new URL("./test/fixtures/apple-test-chain.json", import.meta.url),
    "utf8",
  ),
) as { root: string };

// vitest-pool-workers wraps the Durable Object class once more for every test file in a runtime; past ~20 files the
// wrappers overflow the stack. The suite runs in three runtimes: [a-d] here, [e-l] in vitest.workers-c.config.ts and
// [m-z] in vitest.workers-b.config.ts.
export const SECOND_HALF = ["test/workers/[m-z]*.test.ts"];
export const MIDDLE_PART = ["test/workers/[e-l]*.test.ts"];

export function workersConfig(
  name: string,
  include: string[],
  exclude: string[] = [],
) {
  return defineWorkersConfig({
    define: buildDefines(),
    test: {
      name,
      include,
      exclude,
      // One workerd and one shared database for the whole suite: late tests read a much larger database, 5 s is too tight.
      testTimeout: 60_000,
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: false,
          wrangler: { configPath: "./test/workers/wrangler.test.jsonc" },
          miniflare: {
            bindings: {
              TEST_MODE: "true",
              DEV_SEED: "true",
              TEST_APPLE_ROOT: chain.root,
              CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
              CF_ANALYTICS_TOKEN: "test-analytics-token",
            },
          },
        },
      },
    },
  });
}

export default workersConfig(
  "workers",
  ["test/workers/**/*.test.ts"],
  [...SECOND_HALF, ...MIDDLE_PART],
);
