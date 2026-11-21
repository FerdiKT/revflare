// Bayesian summaries of an experiment's rates (docs/experiments.md#statistics): each variant's rate has a
// Beta(1 + x, 1 + n − x) posterior (uniform prior, x conversions out of n exposed installs). A seeded Monte Carlo
// (20,000 draws by default) gives each variant's probability to be the best and, against the control (index 0), the
// expected relative lift with its 95% credible interval. Deterministic for a seed, so a result does not move between
// reads of the same data. Revenue per install: a seeded bootstrap of the mean (compareMeans).

import type { ExperimentLift } from "../../shared/types";

export const DEFAULT_DRAWS = 20_000;

/** mulberry32: small, fast, seeded PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a of a string (seeds from experiment ids). */
export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normal(rand: () => number): number {
  let u = 0;
  while (u <= Number.EPSILON) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Gamma(shape, 1) by Marsaglia and Tsang (shape < 1 boosted). */
export function gamma(shape: number, rand: () => number): number {
  if (shape < 1) {
    let u = 0;
    while (u <= Number.EPSILON) u = rand();
    return gamma(shape + 1, rand) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function beta(a: number, b: number, rand: () => number): number {
  const x = gamma(a, rand);
  const y = gamma(b, rand);
  return x / (x + y);
}

export interface RateSummary {
  /** Per variant: probability to have the highest rate. */
  probabilityBest: number[];
  /** Per variant (index 0 = control: null): relative lift (p_v − p_0) / p_0. */
  lift: (ExperimentLift | null)[];
}

const quantile = (sorted: Float64Array, q: number) => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/** Beta posteriors of `{ n, x }` per variant (index 0 = control), compared by Monte Carlo. */
export function compareRates(arms: { n: number; x: number }[], opts: { draws?: number; seed?: number } = {}): RateSummary {
  const k = arms.length;
  const draws = opts.draws ?? DEFAULT_DRAWS;
  const rand = rng(opts.seed ?? 1);
  const wins = new Array<number>(k).fill(0);
  const lifts = arms.map(() => new Float64Array(draws));
  const p = new Array<number>(k);
  for (let i = 0; i < draws; i++) {
    let best = 0;
    for (let j = 0; j < k; j++) {
      const n = Math.max(0, arms[j].n);
      const x = Math.min(Math.max(0, arms[j].x), n);
      p[j] = beta(1 + x, 1 + n - x, rand);
      if (p[j] > p[best]) best = j;
    }
    wins[best]++;
    for (let j = 1; j < k; j++) lifts[j][i] = (p[j] - p[0]) / p[0];
  }
  return {
    probabilityBest: wins.map((w) => w / draws),
    lift: lifts.map((l, j) => {
      if (j === 0) return null;
      let sum = 0;
      for (const v of l) sum += v;
      const sorted = l.slice().sort();
      return { expected: sum / draws, low: quantile(sorted, 0.025), high: quantile(sorted, 0.975) };
    }),
  };
}

/** Bootstrap resamples of a mean (revenue per install). */
export const DEFAULT_BOOTSTRAP = 4_000;

export interface MeanSummary {
  /** Per variant: share of resamples where its mean is the highest. */
  probabilityBest: number[];
  /** Per variant (index 0 = control: null): relative lift of the mean (m_v − m_0) / m_0, 95% percentile interval. */
  lift: (ExperimentLift | null)[];
  /** Per variant: 95% percentile interval of the mean; null without installs. */
  interval: ({ low: number; high: number } | null)[];
}

/**
 * Draws Binomial(n, p) by geometric skips: O(result) per draw, exact. Used for the number of resampled installs that
 * land on a non-zero value (most installs spend nothing, so the payers are few).
 */
function binomialSparse(n: number, p: number, rand: () => number): number {
  if (p <= 0 || n <= 0) return 0;
  if (p >= 1) return n;
  const lq = Math.log(1 - p);
  let pos = 0;
  let count = 0;
  for (;;) {
    let u = 0;
    while (u <= Number.EPSILON) u = rand();
    pos += Math.floor(Math.log(u) / lq) + 1;
    if (pos > n) return count;
    count++;
  }
}

/**
 * Non-parametric bootstrap of each variant's mean value per install: `n` installs of which only `values` (the
 * non-zero ones) are listed, the others count 0. A resample of n installs with replacement is drawn exactly as
 * Binomial(n, k/n) non-zero picks among the k values, so the cost follows the payers, not the installs. Seeded: the
 * same data gives the same result.
 */
export function compareMeans(arms: { n: number; values: number[] }[], opts: { draws?: number; seed?: number } = {}): MeanSummary {
  const k = arms.length;
  const draws = opts.draws ?? DEFAULT_BOOTSTRAP;
  const rand = rng(opts.seed ?? 1);
  const means = arms.map(() => new Float64Array(draws));
  const wins = new Array<number>(k).fill(0);
  for (let i = 0; i < draws; i++) {
    let best = -1;
    for (let j = 0; j < k; j++) {
      const { n, values } = arms[j];
      let m = 0;
      if (n > 0 && values.length) {
        const picks = binomialSparse(n, Math.min(1, values.length / n), rand);
        let sum = 0;
        for (let p = 0; p < picks; p++) sum += values[Math.floor(rand() * values.length)];
        m = sum / n;
      }
      means[j][i] = m;
      if (n > 0 && (best < 0 || m > means[best][i])) best = j;
    }
    if (best >= 0) wins[best]++;
  }
  const anyInstalls = arms.some((a) => a.n > 0);
  return {
    probabilityBest: wins.map((w) => (anyInstalls ? w / draws : 0)),
    interval: means.map((m, j) => {
      if (arms[j].n <= 0) return null;
      const sorted = m.slice().sort();
      return { low: quantile(sorted, 0.025), high: quantile(sorted, 0.975) };
    }),
    lift: means.map((m, j) => {
      if (j === 0 || arms[j].n <= 0 || arms[0].n <= 0) return null;
      const l: number[] = [];
      for (let i = 0; i < draws; i++) if (means[0][i] > 0) l.push((m[i] - means[0][i]) / means[0][i]);
      // The control earned nothing in (almost) every resample: a relative lift means nothing.
      if (l.length < draws * 0.9) return null;
      const sorted = Float64Array.from(l).sort();
      return { expected: l.reduce((s, v) => s + v, 0) / l.length, low: quantile(sorted, 0.025), high: quantile(sorted, 0.975) };
    }),
  };
}
