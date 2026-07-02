import { describe, expect, it } from "bun:test";
import { Proposal } from "@kelson/schemas";
import { createProposal } from "../../src/loop.ts";
import { openDb } from "../../src/storage.ts";
import { DISABLE_PONYTAIL, draftProposal, loopCtx } from "../loop-helpers.ts";

describe("LOOP-1: proposals carry machine-checkable evidence links; unresolvable links are rejected pre-gate", () => {
  it("a proposal with resolvable links is created and schema-valid", () => {
    const db = openDb(":memory:");
    const proposal = draftProposal(db, loopCtx());
    expect(Proposal.safeParse(proposal).success).toBe(true);
    expect(proposal.evidence.length).toBeGreaterThan(0);
    db.close();
  });

  it("a proposal citing a nonexistent row is rejected at creation with the dangling link named", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    expect(() =>
      createProposal(db, {
        targetPack: "ponytail",
        diff: DISABLE_PONYTAIL,
        evidence: ["ev:db/verdict/01ARZ3NDEKTSV4RRFFQ69G5FZZ"] as never,
        rationale: "r",
        createdBy: "loop",
        repoRoot: ctx.repoRoot,
      }),
    ).toThrow(/01ARZ3NDEKTSV4RRFFQ69G5FZZ.*LOOP-1/s);
    // Rejection is audited even though no proposal row exists.
    const events = db
      .query("SELECT kind FROM loop_event ORDER BY rowid")
      .all() as { kind: string }[];
    expect(events.some((e) => e.kind === "evidence_check")).toBe(true);
    db.close();
  });

  it("an empty evidence array is a schema error, distinct from unresolvable", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    expect(() =>
      createProposal(db, {
        targetPack: "ponytail",
        diff: DISABLE_PONYTAIL,
        evidence: [],
        rationale: "r",
        createdBy: "loop",
        repoRoot: ctx.repoRoot,
      }),
    ).toThrow();
    db.close();
  });
});
