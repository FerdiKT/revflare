#!/usr/bin/env node
import { run } from "./main.js";

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  process.stderr.write(`revflare needs Node.js 20 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`error: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  },
);
