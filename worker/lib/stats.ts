// Pure statistics and decision rules of the funnel / event alerts (worker/lib/insights.ts, docs/funnels.md#alerts):
// two-proportion tests (and an exact binomial CDF), sensitivity thresholds, the round-robin pick and the event silence rule.

import type { FunnelAlertSensitivity, FunnelAlertSettings } from "../../shared/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An alert needs p below this (one-sided: drops only). */
export const P_MAX = 0.01;
/** Relative drop of a conversion rate that raises an alert, per sensitivity. */
export const DROP_THRESHOLD: Record<FunnelAlertSensitivity, number> = { high: 0.15, normal: 0.2, low: 0.3 };
/** Hours without events before an app counts as silent, per sensitivity (scaled up for apps with sparse events). */
export const SILENCE_HOURS: Record<FunnelAlertSensitivity, number> = { high: 3, normal: 6, low: 12 };
/** Funnel anomaly: installs entering step 1 yesterday, installs at the step before the one tested. */
export const MIN_ENTRANTS = 100;
export const MIN_PREDECESSORS = 30;
/** Funnel anomaly: the 14-day baseline needs at least this many installs at the step before, and 5× yesterday's. */
export const MIN_BASELINE_PREDECESSORS = 300;
export const BASELINE_FACTOR = 5;
/** Release regression: step-1 installs per version. */
export const MIN_VERSION_ENTRANTS = 200;

export const DEFAULT_FUNNEL_ALERTS: FunnelAlertSettings = { enabled: true, sensitivity: "normal" };

const SENSITIVITIES: FunnelAlertSensitivity[] = ["high", "normal", "low"];
export const isSensitivity = (v: unknown): v is FunnelAlertSensitivity => SENSITIVITIES.includes(v as FunnelAlertSensitivity);

/** The most sensitive of several settings (event silence uses the app's funnels). */
export function mostSensitive(list: FunnelAlertSensitivity[]): FunnelAlertSensitivity {
  return SENSITIVITIES.find((s) => list.includes(s)) ?? "normal";
}

// --- Distributions ---------------------------------------------------------------------------------------------------

/** ln Γ(x) (Lanczos, g = 7). */
export function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** P(X ≤ x) for X ~ Binomial(n, p), exact (log-space sum). */
export function binomialCdf(x: number, n: number, p: number): number {
  if (x < 0) return 0;
  if (x >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lnN = logGamma(n + 1);
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let max = -Infinity;
  const terms: number[] = [];
  for (let k = 0; k <= x; k++) {
    const t = lnN - logGamma(k + 1) - logGamma(n - k + 1) + k * lp + (n - k) * lq;
    terms.push(t);
    if (t > max) max = t;
  }
  let sum = 0;
  for (const t of terms) sum += Math.exp(t - max);
  return Math.min(1, Math.exp(max) * sum);
}

/** Standard normal CDF (erfc, Numerical Recipes' Chebyshev fit, |error| < 1.2e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const erfc =
    t *
    Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return z >= 0 ? 1 - erfc / 2 : erfc / 2;
}

/** One-sided two-proportion z-test that x1/n1 is below x2/n2: z and p = Φ(z). */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number): { z: number; p: number } {
  if (!n1 || !n2) return { z: 0, p: 1 };
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p: 1 };
  const z = (x1 / n1 - x2 / n2) / se;
  return { z, p: normalCdf(z) };
}

// --- Decisions -------------------------------------------------------------------------------------------------------

/** A step whose conversion (from the step before) dropped. `step` is the index of the step reached (≥ 1). */
export interface StepDrop {
  step: number;
  /** Converted / entered at the step before, for the tested period (yesterday, or the new version). */
  converted: number;
  entered: number;
  rate: number;
  /** The comparison rate (14-day pool, or the previous version). */
  baseRate: number;
  baseConverted: number;
  baseEntered: number;
  /** Relative drop (0.34 = 34 % lower). */
  drop: number;
  /** One-sided p (the larger of the two tests for an anomaly). */
  p: number;
  /** Anomaly only: the same weekday(s) of the 14-day window (7 and 14 days before yesterday). */
  weekday?: { rate: number; converted: number; entered: number; drop: number };
}

/**
 * Funnel anomaly: yesterday's step-to-step conversions (users per step) against both the pooled 14 days before and the
 * same weekday(s) in those 14 days (weekly patterns, e.g. weekend dips, do not alert). Each comparison is a one-sided
 * two-proportion z-test (the baselines are samples too); both must be significant with a drop at least the
 * sensitivity's. Needs ≥ 100 entrants yesterday, ≥ 30 installs at the step before, a 14-day baseline of at least
 * max(300, 5 × yesterday's) installs at the step before and a weekday baseline of at least max(30, yesterday's): smaller
 * baselines skip the step. Returns the step with the largest relative drop (against the 14 days) among the significant ones.
 */
export function worstAnomaly(yesterday: number[], baseline: number[], weekday: number[], sensitivity: FunnelAlertSensitivity): StepDrop | null {
  if ((yesterday[0] ?? 0) < MIN_ENTRANTS) return null;
  const threshold = DROP_THRESHOLD[sensitivity];
  let worst: StepDrop | null = null;
  for (let k = 1; k < yesterday.length; k++) {
    const n = yesterday[k - 1];
    const x = yesterday[k];
    const bn = baseline[k - 1] ?? 0;
    const bx = baseline[k] ?? 0;
    const wn = weekday[k - 1] ?? 0;
    const wx = weekday[k] ?? 0;
    if (n < MIN_PREDECESSORS || bx <= 0 || wx <= 0) continue;
    if (bn < Math.max(MIN_BASELINE_PREDECESSORS, BASELINE_FACTOR * n) || wn < Math.max(MIN_PREDECESSORS, n)) continue;
    const rate = x / n;
    const baseRate = bx / bn;
    const wRate = wx / wn;
    const drop = 1 - rate / baseRate;
    const wDrop = 1 - rate / wRate;
    if (drop < threshold || wDrop < threshold) continue;
    const p = Math.max(twoProportionTest(x, n, bx, bn).p, twoProportionTest(x, n, wx, wn).p);
    if (p >= P_MAX) continue;
    if (!worst || drop > worst.drop)
      worst = { step: k, converted: x, entered: n, rate, baseRate, baseConverted: bx, baseEntered: bn, drop, p, weekday: { rate: wRate, converted: wx, entered: wn, drop: wDrop } };
  }
  return worst;
}

/**
 * Release regression: per step, the new version's conversion against the previous version's over the same window
 * (two-proportion z-test). Needs ≥ 200 step-1 installs per version and ≥ 30 at the step before.
 */
export function worstRegression(next: number[], prev: number[], sensitivity: FunnelAlertSensitivity): StepDrop | null {
  if ((next[0] ?? 0) < MIN_VERSION_ENTRANTS || (prev[0] ?? 0) < MIN_VERSION_ENTRANTS) return null;
  let worst: StepDrop | null = null;
  for (let k = 1; k < next.length; k++) {
    const n1 = next[k - 1];
    const x1 = next[k];
    const n2 = prev[k - 1] ?? 0;
    const x2 = prev[k] ?? 0;
    if (n1 < MIN_PREDECESSORS || n2 < MIN_PREDECESSORS || x2 <= 0) continue;
    const rate = x1 / n1;
    const baseRate = x2 / n2;
    const drop = 1 - rate / baseRate;
    if (drop < DROP_THRESHOLD[sensitivity]) continue;
    const { p } = twoProportionTest(x1, n1, x2, n2);
    if (p >= P_MAX) continue;
    if (!worst || drop > worst.drop) worst = { step: k, converted: x1, entered: n1, rate, baseRate, baseConverted: x2, baseEntered: n2, drop, p };
  }
  return worst;
}

/** A step-1 entry for the release pick: when the install entered and on which app version (null: unknown). */
export interface VersionEntry {
  first: number;
  version: string | null;
}

export type ReleasePick =
  | { version: string; previous: string; start: number; winStart: number; winEnd: number; counts: Map<string, number> }
  | { skipped: string; noNewVersion: boolean };

/**
 * Release regression: which version to test. Versions first seen within the last 14 days (and at least a day after
 * the data starts) are tried newest first; the first with ≥ 200 entrants in its window (from its first install, at
 * most 7 days back, to `convertMs` ago) is tested, so a TestFlight / beta build with a few testers does not hide the
 * real rollout. `previous`: the most used other version in that window.
 */
export function pickRelease(entries: Iterable<VersionEntry>, opts: { at: number; dataFrom: number; convertMs: number }): ReleasePick {
  const list = [...entries].filter((e): e is { first: number; version: string } => !!e.version);
  const starts = new Map<string, number>();
  for (const e of list) starts.set(e.version, Math.min(starts.get(e.version) ?? Infinity, e.first));
  const candidates = [...starts]
    .filter(([, start]) => start >= opts.dataFrom + DAY && start >= opts.at - 14 * DAY)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
  if (!candidates.length) return { skipped: "regression: no version first seen in the last 14 days", noNewVersion: true };
  const winEnd = opts.at - opts.convertMs;
  const seen: string[] = [];
  for (const [version, start] of candidates) {
    const winStart = Math.max(start, opts.at - 7 * DAY);
    const counts = new Map<string, number>();
    for (const e of list) if (e.first >= winStart && e.first <= winEnd) counts.set(e.version, (counts.get(e.version) ?? 0) + 1);
    const n = counts.get(version) ?? 0;
    if (n < MIN_VERSION_ENTRANTS) {
      seen.push(`${version} ${n}`);
      continue;
    }
    let previous: string | null = null;
    for (const [v, c] of counts) if (v !== version && (!previous || c > counts.get(previous)!)) previous = v;
    if (!previous || counts.get(previous)! < MIN_VERSION_ENTRANTS)
      return { skipped: `regression: ${version} has ${n} installs, ${previous ?? "no other version"} ${previous ? counts.get(previous) : 0} (needs ${MIN_VERSION_ENTRANTS} each)`, noNewVersion: false };
    return { version, previous, start, winStart, winEnd, counts };
  }
  return { skipped: `regression: no new version has ${MIN_VERSION_ENTRANTS} installs (${seen.join(", ")})`, noNewVersion: false };
}

/** Up to `limit` ids (sorted) starting after `cursor`, wrapping around: every funnel gets its turn. */
export function pickRoundRobin(ids: string[], cursor: string | null, limit: number): string[] {
  const sorted = [...ids].sort();
  const start = cursor ? sorted.findIndex((id) => id > cursor) : 0;
  const from = start < 0 ? 0 : start;
  return [...sorted.slice(from), ...sorted.slice(0, from)].slice(0, limit);
}

// --- Event silence ---------------------------------------------------------------------------------------------------

/**
 * What the hourly check remembers per app (settings `events_seen:<app>`): the last "last event received" note it saw
 * and, per UTC day, in how many hourly checks the note had moved (active hours, a cheap measure of the app's volume).
 */
export interface SilenceState {
  last: number | null;
  days: Record<string, number>;
}

export interface SilenceResult {
  state: SilenceState;
  /** The state must be written back. */
  changed: boolean;
  /** Days with events among the 7 before today. */
  activeDays: number;
  /** Silence that raises the alert, in hours (sensitivity, scaled for sparse apps). */
  thresholdHours: number;
  silentHours: number | null;
  status: "no_baseline" | "ok" | "silent";
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Baseline: the app received events on at least 4 of the last 7 days. Threshold: the sensitivity's hours, or twice the
 * usual gap between active hours when that is longer (at most 48 hours).
 */
export function eventSilence(prev: SilenceState | null, lastEventAt: number | null, at: number, sensitivity: FunnelAlertSensitivity): SilenceResult {
  const state: SilenceState = { last: prev?.last ?? null, days: { ...(prev?.days ?? {}) } };
  let changed = false;
  if (lastEventAt && lastEventAt !== state.last) {
    const d = dayOf(lastEventAt);
    state.days[d] = (state.days[d] ?? 0) + 1;
    state.last = lastEventAt;
    changed = true;
  }
  const oldest = dayOf(at - 8 * DAY);
  for (const d of Object.keys(state.days))
    if (d < oldest) {
      delete state.days[d];
      changed = true;
    }
  let activeDays = 0;
  let activeHours = 0;
  for (let i = 1; i <= 7; i++) {
    const h = state.days[dayOf(at - i * DAY)] ?? 0;
    if (h > 0) activeDays++;
    activeHours += h;
  }
  const usualGap = activeHours > 0 ? (24 * 7) / activeHours : 24;
  const thresholdHours = Math.min(48, Math.max(SILENCE_HOURS[sensitivity], Math.round(2 * usualGap)));
  const silentHours = lastEventAt ? (at - lastEventAt) / HOUR : null;
  const status = activeDays < 4 || silentHours === null ? "no_baseline" : silentHours > thresholdHours ? "silent" : "ok";
  return { state, changed, activeDays, thresholdHours, silentHours, status };
}
