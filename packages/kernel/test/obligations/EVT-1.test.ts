import { describe, expect, it } from "bun:test";
import { Verdict } from "@kelson/schemas";
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

describe("EVT-1: ablate produces a four-way verdict with effect sizes and CIs, never a bare pass/fail", () => {
  it("the Verdict schema admits only the four decisions and requires deltas with CIs", () => {
    expect(Verdict.shape.decision.options).toEqual([
      "helps",
      "hurts",
      "no_effect",
      "underpowered",
    ]);
    const bare = Verdict.safeParse({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      decision: "pass",
    });
    expect(bare.success).toBe(false);
  });

  it("a live ablate returns decision + both deltas with CIs + n + alpha + B", () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([
      baseTask({ id: "t0", snapshot, session_command: CMD.costEffect }),
    ]);
    const { verdict } = runEval(db, {
      kind: "ablate",
      suiteDir,
      lockfileA: lockWith([{ name: "effectpack", enabled: true }]),
      lockfileB: lockWith([{ name: "effectpack", enabled: false }]),
      executor: "command",
      profile: WORKTREE,
      repeats: 1,
      snapshotStoreDir: store,
      gateOpts: FAST_GATE,
    });
    expect(Verdict.safeParse(verdict).success).toBe(true);
    expect(verdict.fpar_delta.ci95).toHaveLength(2);
    expect(verdict.cost_delta_pct.ci95).toHaveLength(2);
    expect(verdict.n).toBe(1);
    expect(verdict.alpha).toBe(0.05);
    db.close();
  });
});
