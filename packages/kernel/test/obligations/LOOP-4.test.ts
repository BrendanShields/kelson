import { describe, expect, it } from "bun:test";
import { createProposal } from "../../src/loop.ts";
import { openDb } from "../../src/storage.ts";
import {
  DISABLE_PONYTAIL,
  loopCtx,
  seedVerdictEvidence,
} from "../loop-helpers.ts";

describe("LOOP-4: the loop has no write path to protected surfaces — rejected and audited at the kernel boundary", () => {
  it("loop-originated proposals targeting each protected surface are rejected with an audit event", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const evidence = seedVerdictEvidence(db);
    for (const target of ["kernel", "loop-spec", "eval-thresholds", "seed"]) {
      expect(() =>
        createProposal(db, {
          targetPack: target,
          diff: DISABLE_PONYTAIL,
          evidence,
          rationale: "r",
          createdBy: "loop",
          repoRoot: ctx.repoRoot,
          gatingSuiteIds: ["seed"],
        }),
      ).toThrow(/LOOP-4/);
    }
    const audits = db
      .query(
        "SELECT payload FROM loop_event WHERE kind = 'acl_rejected' ORDER BY rowid",
      )
      .all() as { payload: string }[];
    expect(audits).toHaveLength(4);
    expect(
      audits.map(
        (a) => (JSON.parse(a.payload) as { target_pack: string }).target_pack,
      ),
    ).toEqual(["kernel", "loop-spec", "eval-thresholds", "seed"]);
    db.close();
  });

  it("a human proposal to an ordinary pack passes the same boundary", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const proposal = createProposal(db, {
      targetPack: "ponytail",
      diff: DISABLE_PONYTAIL,
      evidence: seedVerdictEvidence(db),
      rationale: "human-authored",
      createdBy: "human",
      repoRoot: ctx.repoRoot,
    });
    expect(proposal.state).toBe("proposed");
    db.close();
  });
});
