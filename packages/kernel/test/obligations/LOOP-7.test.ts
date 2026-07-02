import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Lockfile } from "@kelson/schemas";
import {
  applyProposal,
  enterGate,
  lockfileContains,
  readChangelog,
  transition,
} from "../../src/loop.ts";
import { hashLockfile } from "../../src/packs.ts";
import { openDb } from "../../src/storage.ts";
import { ulid } from "../../src/ulid.ts";
import { draftProposal, loopCtx, seedSession } from "../loop-helpers.ts";

describe("LOOP-7: sessions pin their lockfile at start; applied diffs affect only sessions started after the apply", () => {
  it("two overlapping sessions spanning an apply record different pinned hashes; every event joins exactly one lockfile", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const beforeHash = hashLockfile(
      JSON.parse(readFileSync(ctx.lockfilePath, "utf8")) as Lockfile,
    );
    // Session 1 starts (and pins) before the apply and outlives it.
    const s1 = seedSession(db, {
      lockfileHash: beforeHash,
      startedAt: "2026-07-02T10:00:00Z",
    });

    const proposal = draftProposal(db, ctx);
    enterGate(db, proposal.id, ctx.repoRoot);
    transition(db, proposal.id, "approved", {
      actor: "human",
      reason: "test approval",
    });
    const { lockfileAfter } = applyProposal(db, proposal.id, ctx);

    // Session 2 starts after the apply and pins the child lockfile.
    const s2 = seedSession(db, {
      lockfileHash: lockfileAfter,
      startedAt: "2026-07-02T11:00:00Z",
    });

    const rows = db
      .query("SELECT id, lockfile_hash FROM session ORDER BY rowid")
      .all() as { id: string; lockfile_hash: string }[];
    expect(rows).toEqual([
      { id: s1, lockfile_hash: beforeHash },
      { id: s2, lockfile_hash: lockfileAfter },
    ]);
    expect(beforeHash).not.toBe(lockfileAfter);

    // Attribution: the changelog chain assigns each pinned hash to exactly
    // one side of the diff.
    const log = readChangelog(ctx.changelogPath);
    expect(lockfileContains(log, beforeHash, proposal.id)).toBe(false);
    expect(lockfileContains(log, lockfileAfter, proposal.id)).toBe(true);

    // Telemetry events join through session_id to exactly one lockfile.
    db.query(
      `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort, agent_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, unit_prices, cost_micro_usd, budget_tokens, overrun, span_id, schema_version)
       VALUES (?, ?, ?, 'build', 'm', 'medium', 'a', 1, 1, 0, 0, '{}', 1, 100, 'none', NULL, 1)`,
    ).run(ulid(), ulid(), s1);
    const joined = db
      .query(
        "SELECT s.lockfile_hash FROM step_event e JOIN session s ON s.id = e.session_id",
      )
      .all() as { lockfile_hash: string }[];
    expect(joined).toEqual([{ lockfile_hash: beforeHash }]);
    db.close();
  });
});
