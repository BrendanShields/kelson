import { describe, expect, it } from "bun:test";
import { gate, mulberry32, type PairedResult } from "../../src/stats.ts";

const TRIALS = 200;
const RESAMPLES = 1000;

const trial = (
  seed: number,
  n: number,
  pA: number,
  pB: number,
): PairedResult[] => {
  const rand = mulberry32(seed * 7919 + 13);
  return Array.from({ length: n }, (_, i) => ({
    task_id: `t${i}`,
    fpar_a: rand() < pA ? 1 : 0,
    fpar_b: rand() < pB ? 1 : 0,
    cost_a: 100,
    cost_b: 100,
  }));
};

const rateOf = (
  decision: string,
  n: number,
  pA: number,
  pB: number,
): number => {
  let hits = 0;
  for (let s = 0; s < TRIALS; s++) {
    const out = gate(trial(s, n, pA, pB), { resamples: RESAMPLES, seed: s });
    if (out.decision === decision) hits++;
  }
  return hits / TRIALS;
};

describe("EVAL-2: synthetic distributions are accepted/rejected at configured error rates; underpowered always rejected", () => {
  it("a strong positive FPAR effect is accepted (helps) in ≥98% of trials", () => {
    expect(rateOf("helps", 24, 0.95, 0.3)).toBeGreaterThanOrEqual(0.98);
  });

  it("a strong negative FPAR effect is rejected (hurts) in ≥98% of trials", () => {
    expect(rateOf("hurts", 24, 0.3, 0.95)).toBeGreaterThanOrEqual(0.98);
  });

  it("under the null, false 'helps' stays within alpha ± 2%", () => {
    expect(rateOf("helps", 24, 0.7, 0.7)).toBeLessThanOrEqual(0.05 + 0.02);
  });

  it("a suite-configured minimum applies (EVAL-2 'suite's configured minimum'), floored at 6 by schema", () => {
    const pairs = trial(1, 6, 1.0, 0.0);
    expect(gate(pairs, { resamples: RESAMPLES, seed: 1 }).decision).toBe(
      "underpowered",
    );
    expect(
      gate(pairs, { resamples: RESAMPLES, seed: 1, minSample: 6 }).decision,
    ).not.toBe("underpowered");
    const { EvalSuite } =
      require("@kelson/schemas") as typeof import("@kelson/schemas");
    expect(
      EvalSuite.safeParse({
        id: "s",
        version: "1",
        role: "gating",
        min_sample: 5,
      }).success,
    ).toBe(false);
    expect(
      EvalSuite.safeParse({
        id: "s",
        version: "1",
        role: "gating",
        min_sample: 6,
      }).success,
    ).toBe(true);
  });

  it("underpowered runs (n below minimum) are always rejected regardless of observed delta", () => {
    for (let s = 0; s < 50; s++) {
      const pairs = trial(s, 19, 1.0, 0.0);
      const out = gate(pairs, { resamples: RESAMPLES, seed: s });
      expect(out.decision).toBe("underpowered");
    }
  });
});
