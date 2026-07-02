import type { Delta, VerdictDecision } from "@kelson/schemas";

// EVP §5: paired bootstrap, B = 10,000, two-sided alpha = 0.05.
// Non-inferiority margins: FPAR lower CI bound >= -2pp; cost upper bound <= +5%.
export const GATE_DEFAULTS = {
  resamples: 10_000,
  alpha: 0.05,
  minSample: 20,
  fparMarginPp: -0.02,
  costMarginPct: 5,
} as const;

export interface PairedResult {
  task_id: string;
  fpar_a: number;
  fpar_b: number;
  cost_a: number;
  cost_b: number;
}

export interface GateOptions {
  resamples?: number;
  alpha?: number;
  minSample?: number;
  seed?: number;
}

export interface GateOutcome {
  decision: VerdictDecision;
  fpar_delta: Delta;
  cost_delta_pct: Delta;
  n: number;
  alpha: number;
  resamples: number;
}

// Deterministic PRNG — EVAL-4 requires the verdict to reproduce from the
// recorded seed; Math.random would break that.
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const mean = (xs: number[]): number =>
  xs.reduce((a, b) => a + b, 0) / xs.length;

const percentile = (sorted: number[], p: number): number => {
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (idx - lo);
};

const bootstrapCi = (
  diffs: number[],
  resamples: number,
  alpha: number,
  rand: () => number,
): Delta => {
  const n = diffs.length;
  const means = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)] as number;
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  return {
    mean: mean(diffs),
    ci95: [percentile(means, alpha / 2), percentile(means, 1 - alpha / 2)],
  };
};

// EVP §5.1: replay pairs each task against its own original outcome; distinct
// minimum n >= 10, veto semantics — no_effect PASSES (the benchmark stage
// already established improvement; replay only proves no real-work regression).
export const REPLAY_MIN_SAMPLE = 10;

export const replayVeto = (
  pairs: PairedResult[],
  opts: GateOptions = {},
): { vetoed: boolean; outcome: GateOutcome } => {
  const outcome = gate(pairs, {
    minSample: REPLAY_MIN_SAMPLE,
    ...opts,
  });
  return {
    vetoed: outcome.decision === "hurts" || outcome.decision === "underpowered",
    outcome,
  };
};

// EVP-4: the verdict is a pure function of the paired-results multiset —
// inputs are canonically sorted so permutations draw identical resamples.
export const gate = (
  pairs: PairedResult[],
  opts: GateOptions = {},
): GateOutcome => {
  const resamples = opts.resamples ?? GATE_DEFAULTS.resamples;
  const alpha = opts.alpha ?? GATE_DEFAULTS.alpha;
  const minSample = opts.minSample ?? GATE_DEFAULTS.minSample;
  const sorted = [...pairs].sort(
    (a, b) =>
      a.task_id.localeCompare(b.task_id) ||
      a.fpar_a - b.fpar_a ||
      a.fpar_b - b.fpar_b ||
      a.cost_a - b.cost_a ||
      a.cost_b - b.cost_b,
  );
  const n = sorted.length;

  const fparDiffs = sorted.map((p) => p.fpar_a - p.fpar_b);
  const costDiffs = sorted.map((p) => p.cost_a - p.cost_b);
  const baseCost = n === 0 ? 0 : mean(sorted.map((p) => p.cost_b));

  const empty: Delta = { mean: 0, ci95: [0, 0] };
  if (n === 0)
    return {
      decision: "underpowered",
      fpar_delta: empty,
      cost_delta_pct: empty,
      n,
      alpha,
      resamples,
    };

  const rand = mulberry32(opts.seed ?? 0);
  const fparDelta = bootstrapCi(fparDiffs, resamples, alpha, rand);
  const costAbs = bootstrapCi(costDiffs, resamples, alpha, rand);
  const toPct = (v: number) => (baseCost === 0 ? 0 : (v / baseCost) * 100);
  const costDelta: Delta = {
    mean: toPct(costAbs.mean),
    ci95: [toPct(costAbs.ci95[0]), toPct(costAbs.ci95[1])],
  };

  let decision: VerdictDecision;
  if (n < minSample) decision = "underpowered";
  else {
    const fparNonInferior = fparDelta.ci95[0] >= GATE_DEFAULTS.fparMarginPp;
    const costNonInferior = costDelta.ci95[1] <= GATE_DEFAULTS.costMarginPct;
    const fparImproved = fparDelta.ci95[0] > 0;
    const costImproved = costDelta.ci95[1] < 0;
    if (!fparNonInferior || !costNonInferior) decision = "hurts";
    else if (fparImproved || costImproved) decision = "helps";
    else decision = "no_effect";
  }
  return {
    decision,
    fpar_delta: fparDelta,
    cost_delta_pct: costDelta,
    n,
    alpha,
    resamples,
  };
};
