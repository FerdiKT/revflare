/** Wrong usage (unknown flag, missing argument...): exit code 2. */
export class UsageError extends Error {
  constructor(message: string, readonly command?: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** An error answered by the Revflare API (the message is the API's `error`). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Any other failure the user can act on (exit code 1, message printed as is). */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** Time left until the next 00:00 UTC, e.g. "3h 12m", "45m", "less than a minute". */
export function untilUtcMidnight(now: Date): string {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const min = Math.floor((next - now.getTime()) / 60_000);
  if (min < 1) return "less than a minute";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * The Workers Free plan's daily database limits: `503 { code: "quota" }` (every request fails until 00:00 UTC) or
 * `429 { code: "budget" }` (today's share for background work such as imports is used up). Exit code 3.
 */
export class QuotaError extends ApiError {
  constructor(
    readonly code: "quota" | "budget",
    status: number,
    body: unknown,
    now: Date = new Date(),
  ) {
    const left = untilUtcMidnight(now);
    super(
      code === "quota"
        ? `Revflare reached today's Cloudflare Free plan database limit: requests fail until 00:00 UTC (in ${left}).`
        : `Today's database budget for imports and other background work is used up (Cloudflare Free plan): continue after 00:00 UTC (in ${left}).`,
      status,
      body,
    );
    this.name = "QuotaError";
  }
}
