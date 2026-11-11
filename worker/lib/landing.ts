import { SESSION_COOKIE } from "./auth";

/** Pages and assets of the marketing site (LANDING binding); none of them is a dashboard route. */
const LANDING_PATHS = new Set([
  "/install.md",
  "/llms.txt",
  "/license",
  "/commercial-license",
  "/privacy",
  "/terms",
  "/thanks",
  "/buy",
  "/robots.txt",
  "/sitemap-index.xml",
  "/sitemap-0.xml",
  "/og.png",
  "/apple-touch-icon.png",
  "/favicon-32.png",
]);
const LANDING_PREFIXES = ["/_astro/", "/docs/"];

/**
 * The marketing site's response for this request, or null for the dashboard. `/` goes to the site only without a
 * session cookie, so signed-in users keep the dashboard there (the sign-in page stays at /login).
 */
export function landingResponse(request: Request, env: Env): Promise<Response> | null {
  if (!env.LANDING || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const path = new URL(request.url).pathname.replace(/\.html$/, "");
  if (path === "/") {
    const cookie = request.headers.get("Cookie") ?? "";
    if (new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=`).test(cookie)) return env.ASSETS.fetch(request);
    return env.LANDING.fetch(request);
  }
  if (LANDING_PATHS.has(path) || LANDING_PREFIXES.some((p) => path.startsWith(p))) return env.LANDING.fetch(request);
  return null;
}
