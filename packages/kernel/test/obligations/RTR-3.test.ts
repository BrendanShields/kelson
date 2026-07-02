import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { canExplore } from "../../src/routing.ts";
import { entry, REGISTRY, vectorArb } from "../routing-helpers.ts";

describe("RTR-3: exploration is a T0-only behavior — no bandit decision ever assigns an exploration arm to T1+", () => {
  it("PBT: canExplore is false for every T1+ vector regardless of registry shape", () => {
    fc.assert(
      fc.property(
        vectorArb.filter((v) => v.tier !== "T0"),
        fc.constantFrom(...REGISTRY),
        (vector, exploit) => {
          expect(canExplore(vector, exploit, REGISTRY)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("exploration requires a candidate exactly one cost class below the exploit arm", () => {
    const t0 = {
      step: "build",
      tier: "T0",
      size: "M",
      lang: "typescript",
      novelty: 1,
      novelty_bucket: "high",
      task_type: "standard",
      repo: "r",
    } as const;
    expect(canExplore(t0, entry("mid-tier", 2), REGISTRY)).toBe(true);
    // Exploit already cheapest: nothing one class below.
    expect(canExplore(t0, entry("small", 1), REGISTRY)).toBe(false);
    // Gap in the ladder: cost_class 3 exploit with no class-2 candidate.
    expect(
      canExplore(t0, entry("frontier", 3), [
        entry("small", 1),
        entry("frontier", 3),
      ]),
    ).toBe(false);
  });
});
