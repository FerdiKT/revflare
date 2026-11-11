import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../worker/index";
import { ORIGIN } from "./helpers";

// Optional LANDING binding (worker/lib/landing.ts): signed-out visitors of / and the site's pages get the marketing
// site; signed-in users keep the dashboard at /, and the API is never routed there.

const stub = (body: string) => ({ fetch: async () => new Response(body) }) as unknown as Fetcher;
const extra = { LANDING: stub("landing"), ASSETS: stub("dashboard") } as Partial<Env>;

async function get(path: string, init: RequestInit = {}, bindings: Partial<Env> = extra) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), { ...env, ...bindings } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("landing site", () => {
  it("serves / to signed-out visitors and the dashboard to signed-in users", async () => {
    expect(await (await get("/")).text()).toBe("landing");
    expect(await (await get("/", { headers: { cookie: "theme=dark; rf_session=abc" } })).text()).toBe("dashboard");
  });

  it("serves the site's pages and assets, not the API", async () => {
    for (const path of ["/install.md", "/llms.txt", "/license", "/buy", "/docs/manual", "/_astro/x.css", "/thanks.html"]) {
      expect(await (await get(path)).text(), path).toBe("landing");
    }
    const status = await get("/api/v1/auth/status");
    expect(await status.text()).not.toBe("landing");
  });

  it("does nothing without the binding", async () => {
    const res = await get("/api/v1/auth/status", {}, {});
    expect(res.status).toBeLessThan(500);
  });
});
