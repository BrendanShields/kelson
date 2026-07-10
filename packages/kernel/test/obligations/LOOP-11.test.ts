import { describe, expect, it } from "bun:test";
import { Proposal } from "@kelson/schemas";
import {
  assembleRejectionHistory,
  type CycleDraft,
  emitProposalCycle,
  REJECTION_WINDOW,
  transition,
} from "../../src/loop.ts";
import { openDb } from "../../src/storage.ts";
import {
  draftProposal,
  loopCtx,
  seedRejected,
  seedVerdictEvidence,
} from "../loop-helpers.ts";

const draft = (db: Parameters<typeof seedVerdictEvidence>[0]): CycleDraft => ({
  targetPack: "ponytail",
  // Distinct from every seedRejected fixture diff so a quarantined fixture's
  // content-hash block (LOOP-9) never trips the emission under test.
  diff: { kind: "lockfile", ops: [{ op: "disable", pack: "routing-default" }] },
  evidence: seedVerdictEvidence(db),
  rationale: "cycle emission",
  expected_effect: 0.5,
});

describe("LOOP-11: the rejection history is compiler input; every emitted proposal records the snapshot watermark", () => {
  it("with 3 rejections on record the input carries all 3 with bases; emissions record the newest ULID", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    seedRejected(db, ctx, { rationale: "r1", reason: "gate verdict: hurts" });
    seedRejected(db, ctx, { rationale: "r2", reason: "human: too risky" });
    const newest = seedRejected(db, ctx, {
      rationale: "r3",
      reason: "gate verdict: underpowered",
    });
    const history = assembleRejectionHistory(db);
    expect(history.entries.map((e) => e.summary)).toEqual(["r3", "r2", "r1"]);
    expect(history.entries.map((e) => e.basis)).toEqual([
      "gate verdict: underpowered",
      "human: too risky",
      "gate verdict: hurts",
    ]);
    expect(history.seenThrough).toBe(newest.id);
    const cycle = emitProposalCycle(db, {
      drafts: [draft(db)],
      createdBy: "loop",
      repoRoot: ctx.repoRoot,
    });
    expect(cycle.proposals[0]?.rejections_seen_through).toBe(newest.id);
    // Read the column back — the persisted value, not the returned object.
    const row = db
      .query("SELECT rejections_seen_through FROM proposal WHERE id = ?")
      .get(cycle.proposals[0]?.id as string) as {
      rejections_seen_through: string;
    };
    expect(row.rejections_seen_through).toBe(newest.id);
    db.close();
  });

  it("with zero rejections the watermark is explicitly null, persisted as NULL", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    expect(assembleRejectionHistory(db)).toEqual({
      entries: [],
      seenThrough: null,
    });
    const cycle = emitProposalCycle(db, {
      drafts: [draft(db)],
      createdBy: "loop",
      repoRoot: ctx.repoRoot,
    });
    expect(cycle.proposals[0]?.rejections_seen_through).toBeNull();
    const row = db
      .query("SELECT rejections_seen_through FROM proposal WHERE id = ?")
      .get(cycle.proposals[0]?.id as string) as {
      rejections_seen_through: string | null;
    };
    expect(row.rejections_seen_through).toBeNull();
    db.close();
  });

  it("a missing field is a schema error, distinct from null", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const cycle = emitProposalCycle(db, {
      drafts: [draft(db)],
      createdBy: "loop",
      repoRoot: ctx.repoRoot,
    });
    const { rejections_seen_through, ...withoutField } = Proposal.parse(
      cycle.proposals[0],
    );
    expect(rejections_seen_through).toBeNull();
    expect(Proposal.safeParse(withoutField).success).toBe(false);
    expect(
      Proposal.safeParse({ ...withoutField, rejections_seen_through: null })
        .success,
    ).toBe(true);
    db.close();
  });

  it("a 21st rejection evicts the oldest — window exactly 20, newest first by proposal rowid", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    for (let i = 0; i < REJECTION_WINDOW + 1; i++)
      seedRejected(db, ctx, { rationale: `r${i}`, reason: `because ${i}` });
    const history = assembleRejectionHistory(db);
    expect(history.entries).toHaveLength(REJECTION_WINDOW);
    expect(history.entries[0]?.summary).toBe(`r${REJECTION_WINDOW}`);
    expect(history.entries.at(-1)?.summary).toBe("r1");
    expect(history.entries.some((e) => e.summary === "r0")).toBe(false);
    db.close();
  });

  it("a rejection landing mid-cycle never splits a cycle's watermarks; the next cycle sees it", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const before = seedRejected(db, ctx, {
      rationale: "pre-cycle",
      reason: "gate verdict: hurts",
    });
    // Snapshot at input assembly, THEN a rejection lands mid-cycle.
    const snapshot = assembleRejectionHistory(db);
    const midCycle = seedRejected(db, ctx, {
      rationale: "mid-cycle",
      reason: "human: overlaps",
    });
    const cycle = emitProposalCycle(db, {
      drafts: [draft(db), draft(db)],
      createdBy: "loop",
      repoRoot: ctx.repoRoot,
      editBudget: 2,
      history: snapshot,
    });
    for (const p of cycle.proposals)
      expect(p.rejections_seen_through).toBe(before.id);
    const next = emitProposalCycle(db, {
      drafts: [draft(db)],
      createdBy: "loop",
      repoRoot: ctx.repoRoot,
    });
    expect(next.proposals[0]?.rejections_seen_through).toBe(midCycle.id);
    db.close();
  });

  it("recency is the proposal row's rowid, not the rejecting transition's time", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    // A created before B, but B rejected before A — the two orders differ,
    // so ORDER BY updated_at (or transition time) would return [A, B].
    const a = draftProposal(db, ctx, { rationale: "created-first" });
    const b = draftProposal(db, ctx, { rationale: "created-second" });
    transition(db, b.id, "gated", { actor: "auto" });
    transition(db, b.id, "rejected", { actor: "human", reason: "b first" });
    transition(db, a.id, "gated", { actor: "auto" });
    transition(db, a.id, "rejected", { actor: "human", reason: "a second" });
    const history = assembleRejectionHistory(db);
    expect(history.entries.map((e) => e.summary)).toEqual([
      "created-second",
      "created-first",
    ]);
    expect(history.seenThrough).toBe(b.id);
    db.close();
  });

  it("a reasonless entering transition yields a null basis, never a predecessor transition's reason", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const p = draftProposal(db, ctx, { rationale: "stale-reason probe" });
    // An earlier transition records a reason; the entering one carries none.
    transition(db, p.id, "gated", { actor: "auto", reason: "stale note" });
    transition(db, p.id, "rejected", { actor: "human" });
    const history = assembleRejectionHistory(db);
    expect(history.entries[0]?.summary).toBe("stale-reason probe");
    expect(history.entries[0]?.basis).toBeNull();
    db.close();
  });

  it("a quarantined proposal's entry carries its revert reason, never the earlier passing override", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const q = seedRejected(db, ctx, {
      rationale: "went bad in monitoring",
      reason: "regressed FPAR post-apply",
      quarantine: true,
    });
    const history = assembleRejectionHistory(db);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.state).toBe("quarantined");
    expect(history.entries[0]?.basis).toBe("regressed FPAR post-apply");
    expect(history.seenThrough).toBe(q.id);
    db.close();
  });
});
