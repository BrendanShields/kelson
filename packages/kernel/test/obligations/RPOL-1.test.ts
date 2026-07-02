import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { resolveRule } from "../../src/routing.ts";
import { POLICY, vectorArb } from "../routing-helpers.ts";

describe("RPOL-1: first-match resolution over rules falling through to default — total and deterministic", () => {
  it("PBT: any vector resolves to exactly one rule; identical inputs give identical decisions", () => {
    fc.assert(
      fc.property(vectorArb, (v) => {
        const first = resolveRule(POLICY, v);
        const second = resolveRule(POLICY, v);
        expect(second).toEqual(first);
        expect(first.ruleIndex).toBeGreaterThanOrEqual(-1);
        expect(first.ruleIndex).toBeLessThan(POLICY.rules.length);
        expect(first.spec.target.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it("first match wins top to bottom; unmatched fields are wildcards", () => {
    const mech = resolveRule(POLICY, {
      step: "build",
      tier: "T0",
      size: "S",
      lang: "typescript",
      novelty: 1,
      novelty_bucket: "high",
      task_type: "mechanical",
      repo: "r",
    });
    // Matches both rule 0 (mechanical) and rule 1 (build/T0): first wins.
    expect(mech.ruleIndex).toBe(0);
  });

  it("a vector matching no rule lands on default (rule_index -1)", () => {
    const spec = resolveRule(POLICY, {
      step: "spec",
      tier: "T2",
      size: "L",
      lang: "rust",
      novelty: 0,
      novelty_bucket: "low",
      task_type: "standard",
      repo: "r",
    });
    expect(spec.ruleIndex).toBe(-1);
    expect(spec.spec.target).toBe("frontier");
  });
});
