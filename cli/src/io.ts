// stdin / interactive prompts.

import { fstatSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Read all of stdin. `implicit` (no --text/--text-file given): only when stdin is a pipe or a file, and give up when
 * nothing arrives within 1.5s, so agents whose stdin is an idle pipe do not hang.
 */
export async function readStdin(implicit: boolean): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  if (implicit) {
    try {
      const st = fstatSync(0);
      if (!st.isFIFO() && !st.isFile()) return null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const finish = (v: string | null) => {
      if (timer) clearTimeout(timer);
      process.stdin.removeAllListeners("data").removeAllListeners("end").removeAllListeners("error");
      process.stdin.pause();
      resolve(v);
    };
    if (implicit) timer = setTimeout(() => (chunks.length ? undefined : finish(null)), 1500);
    process.stdin.on("data", (c: Buffer) => {
      chunks.push(c);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    });
    process.stdin.on("end", () => finish(chunks.length ? Buffer.concat(chunks).toString("utf8") : implicit ? null : ""));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

/** Ask a question on the terminal (stderr). `secret`: do not echo the answer. */
export function prompt(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (opts.secret) {
      const write = (rl as any)._writeToOutput?.bind(rl);
      if (write) {
        (rl as any)._writeToOutput = (s: string) => {
          if (s.startsWith(question) || s === "\r\n" || s === "\n") write(s);
        };
      }
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
