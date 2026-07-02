import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { evaluateFlakiness } from "../../src/flaky.ts";
import { openDb } from "../../src/storage.ts";
import { ulid } from "../../src/ulid.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

const setup = (db: Database) => {
  db.query(
    "INSERT INTO eval_suite (id, version, role) VALUES ('s', '1', 'staging')",
  ).run();
  db.query(
    `INSERT INTO benchmark_task (id, suite_id, suite_version, snapshot_ref, statement, checks, budget_ceiling, origin)
     VALUES ('t', 's', '1', 'sha256:x', 'x', '[]', 1, 'seed')`,
  ).run();
};

let runCounter = 0;
const addRun = (
  db: Database,
  results: { side: "A" | "B"; passes: boolean[] }[],
): void => {
  const runId = ulid();
  runCounter++;
  db.query(
    `INSERT INTO eval_run (id, kind, suite_id, suite_version, config_a, config_b, seed, executor, model_versions, sandbox_profile, manifest_hash, started_at)
     VALUES (?, 'ablate', 's', '1', ?, ?, 0, 'command', '{}', '{}', 'sha256:m', ?)`,
  ).run(
    runId,
    HASH_A,
    HASH_B,
    `2026-01-01T00:00:${String(runCounter).padStart(2, "0")}Z`,
  );
  for (const { side, passes } of results)
    passes.forEach((p, i) => {
      db.query(
        `INSERT INTO eval_task_result (id, run_id, bench_task_id, side, repeat_index, fpar_pass, cost_micro_usd, check_results, raw_ref, schema_version)
         VALUES (?, ?, 't', ?, ?, ?, 0, '[]', NULL, 1)`,
      ).run(ulid(), runId, side, i, p ? 1 : 0);
    });
};

const detect = (db: Database) =>
  evaluateFlakiness(db, {
    suiteId: "s",
    suiteVersion: "1",
    configs: [HASH_A, HASH_B],
  });

const isQuarantined = (db: Database): boolean =>
  (
    db.query("SELECT quarantined FROM benchmark_task WHERE id = 't'").get() as {
      quarantined: number;
    }
  ).quarantined === 1;

describe("EVP-5: window rule pooled per (task, config) across runs; sides never pool; quarantine before gate math", () => {
  it("a deterministic-flaky task is quarantined as soon as its window fills (second run at default repeats)", () => {
    const db = openDb(":memory:");
    setup(db);
    addRun(db, [{ side: "A", passes: [true, false, true] }]);
    expect(detect(db)).toEqual([]);
    addRun(db, [{ side: "A", passes: [false, true, true] }]);
    // window = most recent 5 of 6: [F,T,F,T,T] → 3-2 split → flaky
    const events = detect(db);
    expect(events).toHaveLength(1);
    expect(events[0]?.task_id).toBe("t");
    expect(isQuarantined(db)).toBe(true);
    db.close();
  });

  it("a 4-1 window is below min_minority and never quarantines", () => {
    const db = openDb(":memory:");
    setup(db);
    addRun(db, [{ side: "A", passes: [true, true, false] }]);
    addRun(db, [{ side: "A", passes: [true, true, true] }]);
    // window = [T,F,T,T,T] → minority 1 < 2
    expect(detect(db)).toEqual([]);
    expect(isQuarantined(db)).toBe(false);
    db.close();
  });

  it("stable fixtures are never quarantined across 100 runs", () => {
    const db = openDb(":memory:");
    setup(db);
    for (let i = 0; i < 100; i++) {
      addRun(db, [
        { side: "A", passes: [true, true, true] },
        { side: "B", passes: [true, true, true] },
      ]);
      expect(detect(db)).toEqual([]);
    }
    expect(isQuarantined(db)).toBe(false);
    db.close();
  });

  it("sides never pool: uniform-per-side results that would be mixed pooled are not flaky", () => {
    const db = openDb(":memory:");
    setup(db);
    // A always passes, B always fails — pooled that's maximally mixed.
    for (let i = 0; i < 3; i++)
      addRun(db, [
        { side: "A", passes: [true, true, true] },
        { side: "B", passes: [false, false, false] },
      ]);
    expect(detect(db)).toEqual([]);
    expect(isQuarantined(db)).toBe(false);
    db.close();
  });
});
