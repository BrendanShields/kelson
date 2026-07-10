import { describe, expect, it } from "bun:test";
import type { EvidenceLink } from "@kelson/schemas";
import {
  type CycleDraft,
  EDIT_BUDGET_DEFAULT,
  emitProposalCycle,
} from "../../src/loop.ts";
import { openDb } from "../../src/storage.ts";
import {
  DISABLE_PONYTAIL,
  loopCtx,
  seedVerdictEvidence,
} from "../loop-helpers.ts";

const mkDraft = (
  evidence: EvidenceLink[],
  rationale: string,
  effect: number,
): CycleDraft => ({
  targetPack: "ponytail",
  diff: DISABLE_PONYTAIL,
  evidence,
  rationale,
  expected_effect: effect,
});

describe("LOOP-10: a cycle ranks by expected effect and emits at most the edit budget; clipped candidates get no row", () => {
  it("7 ranked candidates emit exactly the top 4 as proposed rows in rank order, no row for the clipped 3", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const evidence = seedVerdictEvidence(db);
    // Deliberately unsorted input — rank order must come from expected_effect.
    const effects = [0.1, 0.4, 0.7, 0.2, 0.6, 0.3, 0.5];
    const cycle = emitProposalCycle(db, {
      drafts: effects.map((e) => mkDraft(evidence, `effect ${e}`, e)),
      createdBy: "loop",
      repoRoot: ctx.repoRoot,
    });
    expect(EDIT_BUDGET_DEFAULT).toBe(4);
    expect(cycle.proposals).toHaveLength(4);
    expect(cycle.clipped).toBe(3);
    const rows = db
      .query("SELECT rationale, state FROM proposal ORDER BY rowid")
      .all() as { rationale: string; state: string }[];
    expect(rows.map((r) => r.rationale)).toEqual([
      "effect 0.7",
      "effect 0.6",
      "effect 0.5",
      "effect 0.4",
    ]);
    expect(rows.every((r) => r.state === "proposed")).toBe(true);
    db.close();
  });

  it("a configured budget of 2 emits exactly 2", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const evidence = seedVerdictEvidence(db);
    const cycle = emitProposalCycle(db, {
      drafts: [0.3, 0.1, 0.2].map((e) => mkDraft(evidence, `e${e}`, e)),
      createdBy: "loop",
      repoRoot: ctx.repoRoot,
      editBudget: 2,
    });
    expect(cycle.proposals.map((p) => p.rationale)).toEqual(["e0.3", "e0.2"]);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM proposal").get() as { n: number }).n,
    ).toBe(2);
    db.close();
  });

  it("the hard schema floor rejects a budget below 1 (and non-integers)", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const evidence = seedVerdictEvidence(db);
    const drafts = [mkDraft(evidence, "r", 0.5)];
    for (const bad of [0, -1, 2.5])
      expect(() =>
        emitProposalCycle(db, {
          drafts,
          createdBy: "loop",
          repoRoot: ctx.repoRoot,
          editBudget: bad,
        }),
      ).toThrow(/LOOP-10/);
    // Floor itself is legal.
    const cycle = emitProposalCycle(db, {
      drafts,
      createdBy: "loop",
      repoRoot: ctx.repoRoot,
      editBudget: 1,
    });
    expect(cycle.proposals).toHaveLength(1);
    db.close();
  });
});
