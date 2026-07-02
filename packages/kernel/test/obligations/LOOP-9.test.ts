import { describe, expect, it } from "bun:test";
import {
  applyProposal,
  enterGate,
  getProposal,
  readChangelog,
  releaseQuarantined,
  revertProposal,
  transition,
} from "../../src/loop.ts";
import {
  checkMonitor,
  openMonitor,
  pooledNullBootstrap,
} from "../../src/monitor.ts";
import { openDb } from "../../src/storage.ts";
import { draftProposal, loopCtx, seedSession } from "../loop-helpers.ts";

describe("LOOP-9: frozen quarantine-filtered baselines, seeded pooled-null bootstrap, stall semantics, content-hash quarantine with human-only release", () => {
  it("the pooled-null bootstrap is seeded and replayable; a real shift is significant, a null shift is not", () => {
    const regressed = pooledNullBootstrap(
      Array.from({ length: 10 }, () => 0.4),
      Array.from({ length: 12 }, () => 0.8),
      "decrease",
      42,
      2000,
    );
    expect(regressed.delta).toBeCloseTo(-0.4, 10);
    expect(regressed.p).toBeLessThan(0.05);
    expect(
      pooledNullBootstrap([0.4, 0.4], [0.8, 0.8], "decrease", 42, 2000),
    ).toEqual(
      pooledNullBootstrap([0.4, 0.4], [0.8, 0.8], "decrease", 42, 2000),
    );
    const mixed = [0.7, 0.8, 0.9, 0.8, 0.7, 0.8, 0.9, 0.8];
    const nullCase = pooledNullBootstrap(mixed, mixed, "decrease", 7, 2000);
    expect(nullCase.p).toBeGreaterThan(0.05);
  });

  it("a zero-session diff stalls once at day 14 and is never auto-reverted", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const proposal = draftProposal(db, ctx);
    enterGate(db, proposal.id, ctx.repoRoot);
    transition(db, proposal.id, "approved", {
      actor: "human",
      reason: "test approval",
    });
    const { lockfileAfter } = applyProposal(db, proposal.id, ctx);
    openMonitor(db, proposal.id, {
      appliedAt: "2026-07-02T12:00:00Z",
      lockfileAfter,
      changelog: readChangelog(ctx.changelogPath),
    });
    const args = {
      now: "2026-07-17T12:00:00Z",
      changelog: readChangelog(ctx.changelogPath),
      metrics: () => ({ fpar: null, tpac: null }),
    };
    expect(checkMonitor(db, proposal.id, args).status).toBe("stalled");
    expect(checkMonitor(db, proposal.id, args).status).toBe("stalled");
    const stalls = db
      .query(
        "SELECT COUNT(*) AS n FROM loop_event WHERE kind = 'monitor_stalled'",
      )
      .get() as { n: number };
    expect(stalls.n).toBe(1);
    expect(getProposal(db, proposal.id).state).toBe("monitoring");
    db.close();
  });

  it("release returns a quarantined proposal to proposed — never to applied — and unblocks its content hash", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const proposal = draftProposal(db, ctx);
    enterGate(db, proposal.id, ctx.repoRoot);
    transition(db, proposal.id, "approved", {
      actor: "human",
      reason: "test approval",
    });
    applyProposal(db, proposal.id, ctx);
    transition(db, proposal.id, "monitoring", { actor: "auto" });
    revertProposal(db, proposal.id, ctx, {
      actor: "auto",
      reason: "regression",
    });
    expect(getProposal(db, proposal.id).state).toBe("quarantined");
    expect(() => draftProposal(db, ctx)).toThrow(/LOOP-9/);

    const released = releaseQuarantined(db, proposal.id, "human");
    expect(released.state).toBe("proposed");
    // Content hash unblocked: a fresh identical proposal is creatable again.
    const again = draftProposal(db, ctx);
    expect(again.state).toBe("proposed");
    db.close();
  });

  it("baselines exclude sessions whose lockfile contains a then-quarantined diff", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    // Quarantine proposal Q first.
    const q = draftProposal(db, ctx);
    enterGate(db, q.id, ctx.repoRoot);
    transition(db, q.id, "approved", {
      actor: "human",
      reason: "test approval",
    });
    const appliedQ = applyProposal(db, q.id, ctx);
    transition(db, q.id, "monitoring", { actor: "auto" });
    // Sessions under Q's lockfile.
    for (let i = 0; i < 5; i++)
      seedSession(db, {
        lockfileHash: appliedQ.lockfileAfter,
        startedAt: `2026-07-02T0${i}:00:00Z`,
      });
    revertProposal(db, q.id, ctx, { actor: "auto", reason: "regression" });
    // Clean sessions after the revert.
    for (let i = 0; i < 9; i++)
      seedSession(db, {
        lockfileHash: `sha256:${"e".repeat(64)}`,
        startedAt: `2026-07-02T1${i}:00:00Z`,
      });
    const p2 = releaseQuarantined(db, q.id, "human");
    enterGate(db, p2.id, ctx.repoRoot);
    transition(db, p2.id, "approved", {
      actor: "human",
      reason: "test approval",
    });
    const applied2 = applyProposal(db, p2.id, ctx);
    const monitor = openMonitor(db, p2.id, {
      appliedAt: "2026-07-03T00:00:00Z",
      lockfileAfter: applied2.lockfileAfter,
      changelog: readChangelog(ctx.changelogPath),
    });
    // Only the 9 clean sessions qualify; Q-tainted ones are filtered.
    expect(monitor.baseline_session_ids).toHaveLength(9);
    db.close();
  });
});
