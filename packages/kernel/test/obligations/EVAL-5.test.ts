import { describe, expect, it } from "bun:test";
import { evaluateGate } from "../../src/loop.ts";
import { recordReplay } from "../../src/replay.ts";
import { openDb } from "../../src/storage.ts";
import { ulid } from "../../src/ulid.ts";

const CONFIG = `sha256:${"a".repeat(64)}`;

const seedHelpsRun = (db: ReturnType<typeof openDb>): string => {
  db.query(
    "INSERT OR IGNORE INTO eval_suite (id, version, role) VALUES ('seed', '1', 'gating')",
  ).run();
  const runId = ulid();
  db.query(
    `INSERT INTO eval_run (id, kind, suite_id, suite_version, config_a, config_b, seed, executor, model_versions, sandbox_profile, manifest_hash, started_at, finished_at)
     VALUES (?, 'ablate', 'seed', '1', ?, ?, 0, 'claude', '{}', '{}', ?, ?, ?)`,
  ).run(
    runId,
    CONFIG,
    `sha256:${"b".repeat(64)}`,
    `sha256:${"d".repeat(64)}`,
    "2026-07-02T00:00:00Z",
    "2026-07-02T01:00:00Z",
  );
  db.query(
    "INSERT INTO verdict (id, run_id, decision, deltas, n, alpha) VALUES (?, ?, 'helps', '{}', 24, 0.05)",
  ).run(ulid(), runId);
  // The gate recomputes from per-task results with the candidate as side A:
  // 24 tasks, equal fpar, candidate 10% cheaper → helps.
  for (let i = 0; i < 24; i++) {
    for (const [side, cost] of [
      ["A", 90],
      ["B", 100],
    ] as const) {
      db.query(
        `INSERT INTO eval_task_result (id, run_id, bench_task_id, side, repeat_index, fpar_pass, cost_micro_usd, check_results, raw_ref, schema_version)
         VALUES (?, ?, ?, ?, 0, 1, ?, '[]', NULL, 1)`,
      ).run(ulid(), runId, `t${i}`, side, cost);
    }
  }
  return runId;
};

const seedReplays = (
  db: ReturnType<typeof openDb>,
  n: number,
  replayPass: boolean,
) => {
  for (let i = 0; i < n; i++)
    recordReplay(db, {
      source_session_id: `s${i}`,
      snapshot_ref: `sha256:${"e".repeat(64)}`,
      config: CONFIG,
      run_id: null,
      outcome: {
        fpar_pass: replayPass,
        cost_micro_usd: 100,
        original_fpar_pass: true,
        original_cost_micro_usd: 100,
      },
      validity: "valid",
      advisory_reason: null,
    });
};

describe("EVAL-5: benchmark success plus counterfactual replay — a diff that degrades replayed real tasks is not auto-appliable", () => {
  it("EVP §5 side-swap: a run whose candidate is side B gates on the swapped pairs", () => {
    const db = openDb(":memory:");
    // Side A costs MORE (the pack hurts); the disable candidate lives on side
    // B and must evaluate helps only through the swap.
    const runId = seedHelpsRun(db); // A=90, B=100 as seeded
    seedReplays(db, 12, true);
    const asA = evaluateGate(db, {
      runId,
      replayConfig: CONFIG,
      candidateSide: "A",
    });
    const asB = evaluateGate(db, {
      runId,
      replayConfig: CONFIG,
      candidateSide: "B",
    });
    expect(asA.benchmark.decision).toBe("helps"); // A is 10% cheaper
    expect(asB.benchmark.decision).toBe("hurts"); // swapped: B is 11% dearer
    expect(asB.auto_approvable).toBe(false);
    db.close();
  });

  it("helps + clean replays (n>=10) → auto-approvable; the aggregate records the replayed session ids", () => {
    const db = openDb(":memory:");
    const runId = seedHelpsRun(db);
    seedReplays(db, 12, true);
    const basis = evaluateGate(db, {
      runId,
      replayConfig: CONFIG,
      candidateSide: "A",
    });
    expect(basis.auto_approvable).toBe(true);
    expect(basis.replay.valid_n).toBe(12);
    db.close();
  });

  it("helps on benchmarks but degrading real replayed tasks → vetoed, not auto-appliable", () => {
    const db = openDb(":memory:");
    const runId = seedHelpsRun(db);
    seedReplays(db, 12, false);
    const basis = evaluateGate(db, {
      runId,
      replayConfig: CONFIG,
      candidateSide: "A",
    });
    expect(basis.replay.vetoed).toBe(true);
    expect(basis.auto_approvable).toBe(false);
    db.close();
  });

  it("fewer than 10 valid replays → underpowered veto (no auto-apply eligibility)", () => {
    const db = openDb(":memory:");
    const runId = seedHelpsRun(db);
    seedReplays(db, 6, true);
    const basis = evaluateGate(db, {
      runId,
      replayConfig: CONFIG,
      candidateSide: "A",
    });
    expect(basis.replay.decision).toBe("underpowered");
    expect(basis.auto_approvable).toBe(false);
    db.close();
  });
});
