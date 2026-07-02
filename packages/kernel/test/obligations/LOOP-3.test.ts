import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  applyProposal,
  enterGate,
  getProposal,
  readChangelog,
  transition,
} from "../../src/loop.ts";
import {
  checkMonitor,
  type MetricsProvider,
  monitorSweep,
  openMonitor,
} from "../../src/monitor.ts";
import { openDb } from "../../src/storage.ts";
import {
  draftProposal,
  type LoopCtx,
  loopCtx,
  seedSession,
  seedVerdictEvidence,
} from "../loop-helpers.ts";

const APPLY_AT = "2026-07-02T12:00:00Z";
const iso = (dayOffset: number, i = 0) =>
  new Date(
    Date.parse(APPLY_AT) + dayOffset * 86_400_000 + i * 60_000,
  ).toISOString();

interface Fixture {
  db: Database;
  ctx: LoopCtx;
  proposalId: string;
  lockfileAfter: string;
  metrics: Map<string, { fpar: number | null; tpac: number | null }>;
  provider: MetricsProvider;
}

const applied = (
  opts: { baselineFpar?: number; baselineN?: number } = {},
): Fixture => {
  const db = openDb(":memory:");
  const ctx = loopCtx();
  const metrics = new Map<
    string,
    { fpar: number | null; tpac: number | null }
  >();
  const baselineN = opts.baselineN ?? 12;
  for (let i = 0; i < baselineN; i++) {
    const id = seedSession(db, {
      lockfileHash: `sha256:${"e".repeat(64)}`,
      startedAt: iso(-3, i),
    });
    metrics.set(id, { fpar: opts.baselineFpar ?? 0.8, tpac: 1000 });
  }
  const proposal = draftProposal(db, ctx);
  enterGate(db, proposal.id, ctx.repoRoot);
  transition(db, proposal.id, "approved", {
    actor: "human",
    reason: "test approval",
  });
  const { lockfileAfter } = applyProposal(db, proposal.id, ctx);
  openMonitor(db, proposal.id, {
    appliedAt: APPLY_AT,
    lockfileAfter,
    changelog: readChangelog(ctx.changelogPath),
  });
  return {
    db,
    ctx,
    proposalId: proposal.id,
    lockfileAfter,
    metrics,
    provider: (id) => metrics.get(id) ?? { fpar: null, tpac: null },
  };
};

const addPostSessions = (
  f: Fixture,
  n: number,
  fpar: number,
  dayOffset = 3,
): void => {
  for (let i = 0; i < n; i++) {
    const id = seedSession(f.db, {
      lockfileHash: f.lockfileAfter,
      startedAt: iso(dayOffset, i),
    });
    f.metrics.set(id, { fpar, tpac: 1000 });
  }
};

describe("LOOP-3: in-window regression auto-reverts and quarantines; multi-diff causes revert one at a time in reverse order", () => {
  it("an injected post-apply FPAR regression triggers revert within the window (day 3, exactly 8 sessions)", () => {
    const f = applied();
    addPostSessions(f, 8, 0.4);
    const ctxArgs = {
      now: iso(3, 10),
      changelog: readChangelog(f.ctx.changelogPath),
      metrics: f.provider,
      applyCtx: f.ctx,
    };
    const { reverted } = monitorSweep(f.db, ctxArgs);
    expect(reverted).toBe(f.proposalId);
    expect(getProposal(f.db, f.proposalId).state).toBe("quarantined");
    f.db.close();
  });

  it("no regression → window stays open at day 14 with 20 sessions (conjunctive closure) and closes inclusively at 30", () => {
    const f = applied();
    addPostSessions(f, 20, 0.8);
    const args = {
      now: iso(14, 30),
      changelog: readChangelog(f.ctx.changelogPath),
      metrics: f.provider,
    };
    expect(checkMonitor(f.db, f.proposalId, args).status).toBe("clean");
    addPostSessions(f, 10, 0.8, 15);
    expect(
      checkMonitor(f.db, f.proposalId, { ...args, now: iso(16) }).status,
    ).toBe("closed");
    expect(getProposal(f.db, f.proposalId).state).toBe("stable");
    f.db.close();
  });

  it("with two monitored diffs and one injected culprit, only the culprit ends quarantined", () => {
    const f = applied();
    // A-only stratum: 10 healthy sessions under A alone.
    addPostSessions(f, 10, 0.8, 1);
    // Apply B (the culprit-to-be).
    const b = draftProposal(f.db, f.ctx, {
      targetPack: "routing-default",
      diff: {
        kind: "lockfile" as const,
        ops: [{ op: "disable" as const, pack: "routing-default" }],
      },
      evidence: seedVerdictEvidence(f.db),
    });
    enterGate(f.db, b.id, f.ctx.repoRoot);
    transition(f.db, b.id, "approved", {
      actor: "human",
      reason: "test approval",
    });
    const appliedB = applyProposal(f.db, b.id, f.ctx);
    openMonitor(f.db, b.id, {
      appliedAt: iso(4),
      lockfileAfter: appliedB.lockfileAfter,
      changelog: readChangelog(f.ctx.changelogPath),
    });
    // Sessions under A+B regress hard.
    for (let i = 0; i < 10; i++) {
      const id = seedSession(f.db, {
        lockfileHash: appliedB.lockfileAfter,
        startedAt: iso(6, i),
      });
      f.metrics.set(id, { fpar: 0.3, tpac: 1000 });
    }
    const { reverted } = monitorSweep(f.db, {
      now: iso(7),
      changelog: readChangelog(f.ctx.changelogPath),
      metrics: f.provider,
      applyCtx: f.ctx,
    });
    expect(reverted).toBe(b.id);
    expect(getProposal(f.db, b.id).state).toBe("quarantined");
    expect(getProposal(f.db, f.proposalId).state).toBe("monitoring");
    f.db.close();
  });

  it("starved inter-apply stratum → indistinguishable → revert last-applied only; survivor re-measures on fresh sessions", () => {
    const f = applied();
    // Only 3 A-only sessions: stratum < 8 → isolation impossible.
    addPostSessions(f, 3, 0.8, 1);
    const b = draftProposal(f.db, f.ctx, {
      targetPack: "routing-default",
      diff: {
        kind: "lockfile" as const,
        ops: [{ op: "disable" as const, pack: "routing-default" }],
      },
      evidence: seedVerdictEvidence(f.db),
    });
    enterGate(f.db, b.id, f.ctx.repoRoot);
    transition(f.db, b.id, "approved", { actor: "human", reason: "test" });
    const appliedB = applyProposal(f.db, b.id, f.ctx);
    openMonitor(f.db, b.id, {
      appliedAt: iso(2),
      lockfileAfter: appliedB.lockfileAfter,
      changelog: readChangelog(f.ctx.changelogPath),
    });
    for (let i = 0; i < 10; i++) {
      const id = seedSession(f.db, {
        lockfileHash: appliedB.lockfileAfter,
        startedAt: iso(3, i),
      });
      f.metrics.set(id, { fpar: 0.3, tpac: 1000 });
    }
    const { reverted } = monitorSweep(f.db, {
      now: iso(4),
      changelog: readChangelog(f.ctx.changelogPath),
      metrics: f.provider,
      applyCtx: f.ctx,
    });
    // Indistinguishable → last-applied (B) only; A survives.
    expect(reverted).toBe(b.id);
    expect(getProposal(f.db, f.proposalId).state).toBe("monitoring");
    // Survivor re-measures fresh: sessions before the revert no longer count.
    // The changelog writes wall-clock timestamps; align the revert's `at`
    // with the synthetic clock so the fresh-window floor is exercisable.
    const log = readChangelog(f.ctx.changelogPath).map((e) =>
      e.action === "revert" ? { ...e, at: iso(4) } : e,
    );
    const after = checkMonitor(f.db, f.proposalId, {
      now: iso(5),
      changelog: log,
      metrics: f.provider,
    });
    expect(after.status).toBe("skipped");
    f.db.close();
  });

  it("a quarantined diff cannot be re-proposed without human release", () => {
    const f = applied();
    addPostSessions(f, 8, 0.4);
    monitorSweep(f.db, {
      now: iso(3, 10),
      changelog: readChangelog(f.ctx.changelogPath),
      metrics: f.provider,
      applyCtx: f.ctx,
    });
    expect(() => draftProposal(f.db, f.ctx)).toThrow(/quarantined.*LOOP-9/s);
    f.db.close();
  });
});
