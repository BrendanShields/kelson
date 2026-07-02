import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  explorationDraw,
  exploreDecision,
  promotionCandidate,
  recordOutcome,
} from "../../src/bandit.ts";
import { openDb } from "../../src/storage.ts";
import { ulid } from "../../src/ulid.ts";
import { entry, REGISTRY, vectorArb } from "../routing-helpers.ts";

describe("RPOL-4: exploration only under the three conditions, ULID-derived and replayable; write surface pinned by RTR-5 tests", () => {
  it("PBT: no decision stream ever explores on T1+, non-cheaper, or single-candidate cases", () => {
    fc.assert(
      fc.property(
        vectorArb,
        fc.constantFrom(...REGISTRY),
        (vector, exploit) => {
          const decision = exploreDecision(vector, exploit, REGISTRY, ulid());
          if (vector.tier !== "T0") expect(decision).toBeNull();
          if (exploit.cost_class === 1) expect(decision).toBeNull();
          if (decision)
            expect(decision.cost_class).toBe(exploit.cost_class - 1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("promotion trigger: a margin crossed late in the window is NOT 50-consecutive; a sustained margin is", () => {
    const db = openDb(":memory:");
    // Late-crosser: challenger fails 49 times then wins 25 — the EMA margin
    // only holds at the very end, never for 50 consecutive outcomes.
    for (let i = 0; i < 60; i++) recordOutcome(db, "v1", "incumbent", 0);
    for (let i = 0; i < 49; i++) recordOutcome(db, "v1", "late", 0);
    for (let i = 0; i < 25; i++) recordOutcome(db, "v1", "late", 1);
    expect(promotionCandidate(db, "v1", "incumbent", "late")).toBe(false);
    // Sustained: challenger wins 80 straight against a losing incumbent.
    for (let i = 0; i < 80; i++) recordOutcome(db, "v1", "steady", 1);
    expect(promotionCandidate(db, "v1", "incumbent", "steady")).toBe(true);
    db.close();
  });

  it("replaying the same ULID reproduces the decision exactly", () => {
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
    const mid = entry("mid-tier", 2);
    // Find a ULID whose draw explores, then replay it.
    let exploringUlid: string | null = null;
    for (let i = 0; i < 200 && !exploringUlid; i++) {
      const candidate = ulid();
      if (explorationDraw(candidate) < 0.05) exploringUlid = candidate;
    }
    expect(exploringUlid).not.toBeNull();
    const first = exploreDecision(t0, mid, REGISTRY, exploringUlid as string);
    const replay = exploreDecision(t0, mid, REGISTRY, exploringUlid as string);
    expect(first?.id).toBe("small");
    expect(replay).toEqual(first);
    // And a non-exploring ULID replays as null.
    let calmUlid: string | null = null;
    for (let i = 0; i < 200 && !calmUlid; i++) {
      const candidate = ulid();
      if (explorationDraw(candidate) >= 0.05) calmUlid = candidate;
    }
    expect(exploreDecision(t0, mid, REGISTRY, calmUlid as string)).toBeNull();
  });
});
