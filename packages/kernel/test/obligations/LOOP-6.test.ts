import { describe, expect, it } from "bun:test";
import { evaluateGate } from "../../src/loop.ts";
import { openDb } from "../../src/storage.ts";
import { ulid } from "../../src/ulid.ts";

const seedRun = (
  db: ReturnType<typeof openDb>,
  role: "gating" | "staging",
): string => {
  db.query(
    "INSERT OR IGNORE INTO eval_suite (id, version, role) VALUES (?, '1', ?)",
  ).run(role, role);
  const runId = ulid();
  db.query(
    `INSERT INTO eval_run (id, kind, suite_id, suite_version, config_a, config_b, seed, executor, model_versions, sandbox_profile, manifest_hash, started_at, finished_at)
     VALUES (?, 'ablate', ?, '1', ?, ?, 0, 'claude', '{}', '{}', ?, ?, ?)`,
  ).run(
    runId,
    role,
    `sha256:${"a".repeat(64)}`,
    `sha256:${"b".repeat(64)}`,
    `sha256:${"c".repeat(64)}`,
    "2026-07-02T00:00:00Z",
    "2026-07-02T01:00:00Z",
  );
  db.query(
    "INSERT INTO verdict (id, run_id, decision, deltas, n, alpha) VALUES (?, ?, 'helps', '{}', 24, 0.05)",
  ).run(ulid(), runId);
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

describe("LOOP-6: staged suites never gate — only human promotion moves tasks into a gating suite", () => {
  it("a staged-suite run never appears in a gate computation", () => {
    const db = openDb(":memory:");
    const stagedRun = seedRun(db, "staging");
    expect(() =>
      evaluateGate(db, {
        runId: stagedRun,
        replayConfig: `sha256:${"a".repeat(64)}`,
        candidateSide: "A",
      }),
    ).toThrow(/staged suites never gate.*LOOP-6/s);
    db.close();
  });

  it("a gating-suite run with a helps verdict is gate-eligible", () => {
    const db = openDb(":memory:");
    const gatingRun = seedRun(db, "gating");
    const basis = evaluateGate(db, {
      runId: gatingRun,
      replayConfig: `sha256:${"a".repeat(64)}`,
      candidateSide: "A",
    });
    expect(basis.benchmark.decision).toBe("helps");
    expect(basis.benchmark.suite_role).toBe("gating");
    db.close();
  });
});
