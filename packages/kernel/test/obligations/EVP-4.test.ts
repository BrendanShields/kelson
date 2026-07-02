import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  gate,
  type PairedResult,
  REPLAY_MIN_SAMPLE,
  replayVeto,
} from "../../src/stats.ts";

const pairs = (
  n: number,
  f: (i: number) => Partial<PairedResult>,
): PairedResult[] =>
  Array.from({ length: n }, (_, i) => ({
    task_id: `t${i}`,
    fpar_a: 1,
    fpar_b: 1,
    cost_a: 100,
    cost_b: 100,
    ...f(i),
  }));

describe("EVP-4: the gate reproduces the §5 decision table exactly; §5.1 replay veto; verdict is order-invariant", () => {
  it("non-inferior + FPAR improved → helps", () => {
    const out = gate(pairs(24, (i) => (i < 12 ? { fpar_b: 0 } : {})));
    expect(out.decision).toBe("helps");
  });

  it("non-inferior + cost improved → helps", () => {
    const out = gate(pairs(24, () => ({ cost_a: 90 })));
    expect(out.decision).toBe("helps");
  });

  it("non-inferior, neither improved → no_effect (rejected — a change must earn its place)", () => {
    expect(gate(pairs(24, () => ({}))).decision).toBe("no_effect");
  });

  it("inferior on FPAR → hurts", () => {
    expect(gate(pairs(24, (i) => (i < 12 ? { fpar_a: 0 } : {}))).decision).toBe(
      "hurts",
    );
  });

  it("inferior on cost → hurts", () => {
    expect(gate(pairs(24, () => ({ cost_a: 120 }))).decision).toBe("hurts");
  });

  it("n < 20 → underpowered, even with a maximal effect", () => {
    expect(gate(pairs(19, () => ({ fpar_b: 0 }))).decision).toBe(
      "underpowered",
    );
  });

  it("verdict includes both deltas with CIs, n, alpha, and B", () => {
    const out = gate(pairs(24, () => ({ cost_a: 90 })));
    expect(out.fpar_delta.ci95).toHaveLength(2);
    expect(out.cost_delta_pct.ci95).toHaveLength(2);
    expect(out.n).toBe(24);
    expect(out.alpha).toBe(0.05);
    expect(out.resamples).toBe(10_000);
  });

  it("§5.1 replay rule: distinct minimum n ≥ 10; no_effect passes (veto semantics)", () => {
    expect(REPLAY_MIN_SAMPLE).toBe(10);
    const clean = replayVeto(pairs(12, () => ({})));
    expect(clean.outcome.decision).toBe("no_effect");
    expect(clean.vetoed).toBe(false);
    const regressed = replayVeto(
      pairs(12, (i) => (i < 8 ? { fpar_a: 0 } : {})),
    );
    expect(regressed.vetoed).toBe(true);
    const thin = replayVeto(pairs(9, () => ({})));
    expect(thin.outcome.decision).toBe("underpowered");
    expect(thin.vetoed).toBe(true);
  });

  it("PBT: the verdict is a pure function of the paired-results multiset (order-invariant)", () => {
    const pairArb = fc.record({
      task_id: fc.string({ minLength: 1, maxLength: 6 }),
      fpar_a: fc.constantFrom(0, 1),
      fpar_b: fc.constantFrom(0, 1),
      cost_a: fc.integer({ min: 0, max: 1000 }),
      cost_b: fc.integer({ min: 0, max: 1000 }),
    });
    fc.assert(
      fc.property(
        fc.array(pairArb, { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 0, max: 1000 }),
        (ps, seed) => {
          const shuffled = [...ps].reverse();
          const a = gate(ps, { resamples: 200, seed });
          const b = gate(shuffled, { resamples: 200, seed });
          expect(b).toEqual(a);
        },
      ),
      { numRuns: 50 },
    );
  });
});
