// Bayesian summaries of an experiment's rates (docs/experiments.md#statistics): each variant's rate has a
// Beta(1 + x, 1 + n − x) posterior (uniform prior, x conversions out of n exposed installs). A seeded Monte Carlo
// (20,000 draws by default) gives each variant's probability to be the best and, against the control (index 0), the
// expected relative lift with its 95% credible interval. Deterministic for a seed, so a result does not move between
// reads of the same data.

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
