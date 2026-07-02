import { describe, expect, it } from "bun:test";
import { runEval } from "../../src/evalrun.ts";
import { openDb } from "../../src/storage.ts";
import {
  baseTask,
  CMD,
  FAST_GATE,
  lockWith,
  makeSnapshot,
  makeSuite,
  tmpDir,
  WORKTREE,
} from "../eval-helpers.ts";

const store = tmpDir();
const snapshot = makeSnapshot({ "README.md": "x\n" }, store);

const ablate = (sessionCommand: string, seed: number) => {
  const db = openDb(":memory:");
  const suiteDir = makeSuite(
    Array.from({ length: 4 }, (_, i) =>
      baseTask({ id: `t${i}`, snapshot, session_command: sessionCommand }),
    ),
  );
  const result = runEval(db, {
    kind: "ablate",
    suiteDir,
    // A = effectpack enabled, B = toggled off.
    lockfileA: lockWith([{ name: "effectpack", enabled: true }]),
    lockfileB: lockWith([{ name: "effectpack", enabled: false }]),
    executor: "command",
    profile: WORKTREE,
    repeats: 1,
    seed,
    snapshotStoreDir: store,
    gateOpts: FAST_GATE,
  });
  db.close();
  return result;
};

describe("EVAL-1: a fixture pack with a known injected effect produces the expected sign of delta on every run", () => {
  it("an injected cost reduction yields a negative cost delta on every run", () => {
    for (const seed of [1, 2, 3]) {
      const { verdict } = ablate(CMD.costEffect, seed);
      expect(verdict.cost_delta_pct.mean).toBeLessThan(0);
      expect(verdict.fpar_delta.mean).toBe(0);
    }
  });

  it("an injected FPAR improvement yields a positive fpar delta on every run", () => {
    for (const seed of [1, 2, 3]) {
      const { verdict } = ablate(CMD.fparEffect, seed);
      expect(verdict.fpar_delta.mean).toBeGreaterThan(0);
    }
  });

  it("paired per-task deltas are reported (per-task raw results persisted per side)", () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([
      baseTask({ id: "t0", snapshot, session_command: CMD.costEffect }),
    ]);
    const { runId } = runEval(db, {
      kind: "ablate",
      suiteDir,
      lockfileA: lockWith([{ name: "effectpack", enabled: true }]),
      lockfileB: lockWith([{ name: "effectpack", enabled: false }]),
      executor: "command",
      profile: WORKTREE,
      repeats: 2,
      snapshotStoreDir: store,
      gateOpts: FAST_GATE,
    });
    const rows = db
      .query(
        "SELECT side, COUNT(*) AS n FROM eval_task_result WHERE run_id = ? GROUP BY side ORDER BY side",
      )
      .all(runId) as { side: string; n: number }[];
    expect(rows).toEqual([
      { side: "A", n: 2 },
      { side: "B", n: 2 },
    ]);
    db.close();
  });
});
