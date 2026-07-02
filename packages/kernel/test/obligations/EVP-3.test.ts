import { describe, expect, it } from "bun:test";
import {
  aggregateReplays,
  recordReplay,
  validateReplay,
} from "../../src/replay.ts";
import { storeSnapshot } from "../../src/snapshots.ts";
import { openDb } from "../../src/storage.ts";
import { makeRepo, tmpDir } from "../eval-helpers.ts";

const store = tmpDir();
const goodSnapshot = storeSnapshot(makeRepo({ "README.md": "x\n" }), store);
const CONFIG = `sha256:${"c".repeat(64)}`;

const base = {
  snapshotHash: goodSnapshot,
  storeDir: store,
  originalStatus: "complete" as const,
  originalModels: ["claude-sonnet-5"],
  candidateModels: ["claude-sonnet-5"],
};

const record = (
  db: ReturnType<typeof openDb>,
  validity: "valid" | "advisory",
  reason: Parameters<typeof recordReplay>[1]["advisory_reason"],
  replayPass: boolean,
  i: number,
) =>
  recordReplay(db, {
    source_session_id: `s${i}`,
    snapshot_ref: goodSnapshot,
    config: CONFIG,
    run_id: null,
    outcome: {
      fpar_pass: replayPass,
      cost_micro_usd: 100,
      original_fpar_pass: true,
      original_cost_micro_usd: 100,
    },
    validity,
    advisory_reason: reason,
  });

describe("EVP-3: each validity-rule violation lands in advisory; none reaches the gate aggregate", () => {
  it("rule 1: a snapshot that does not restore bit-identically is advisory", () => {
    expect(
      validateReplay({ ...base, snapshotHash: `sha256:${"f".repeat(64)}` }),
    ).toEqual({ validity: "advisory", reason: "snapshot_hash_mismatch" });
  });

  it("rule 2: model mismatch is advisory — cross-model replays inform, never gate", () => {
    expect(
      validateReplay({
        ...base,
        candidateModels: ["claude-haiku-4-5-20251001"],
      }),
    ).toEqual({ validity: "advisory", reason: "model_mismatch" });
  });

  it("rule 3: a non-complete source session is advisory", () => {
    expect(validateReplay({ ...base, originalStatus: "degraded" })).toEqual({
      validity: "advisory",
      reason: "source_session_not_complete",
    });
    expect(validateReplay(base)).toEqual({ validity: "valid", reason: null });
  });

  it("advisory records are reported but excluded from the gate aggregate", () => {
    const db = openDb(":memory:");
    // 10 valid clean replays + 5 advisory catastrophic failures.
    for (let i = 0; i < 10; i++) record(db, "valid", null, true, i);
    for (let i = 10; i < 15; i++)
      record(db, "advisory", "model_mismatch", false, i);
    const aggregate = aggregateReplays(db, CONFIG);
    expect(aggregate.valid_n).toBe(10);
    expect(aggregate.advisory_n).toBe(5);
    // The advisory failures would veto if they gated; they do not.
    expect(aggregate.vetoed).toBe(false);
    expect(aggregate.decision).toBe("no_effect");
    expect(aggregate.session_ids).toHaveLength(10);
    db.close();
  });
});
