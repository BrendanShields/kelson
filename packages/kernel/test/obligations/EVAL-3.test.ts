import { describe, expect, it } from "bun:test";
import { runEval } from "../../src/evalrun.ts";
import { promoteTask } from "../../src/flaky.ts";
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

describe("EVAL-3: a flaky task is quarantined, excluded from gating, and sticky until re-approved by a human", () => {
  it("quarantine excludes the task from gate math in the triggering run and stays until promote", () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([
      baseTask({ id: "stable", snapshot }),
      baseTask({ id: "flaky", snapshot, session_command: CMD.seededFlaky }),
    ]);
    const opts = {
      kind: "compare" as const,
      suiteDir,
      lockfileA: lockWith([{ name: "p", enabled: true }]),
      lockfileB: lockWith([{ name: "p", enabled: false }]),
      executor: "command" as const,
      profile: WORKTREE,
      snapshotStoreDir: store,
      gateOpts: FAST_GATE,
    };
    // Distinct run seeds vary the derived task seeds until the flaky task's
    // window fills mixed; the stable task must survive every run.
    let quarantinedAt: number | null = null;
    for (let seed = 0; seed < 12 && quarantinedAt === null; seed++) {
      const result = runEval(db, { ...opts, seed });
      if (result.verdict.quarantined_tasks.includes("flaky")) {
        quarantinedAt = seed;
        expect(result.verdict.n).toBe(1);
        expect(result.quarantine.some((q) => q.task_id === "flaky")).toBe(true);
      }
      expect(result.verdict.quarantined_tasks).not.toContain("stable");
    }
    expect(quarantinedAt).not.toBeNull();

    // Sticky: still excluded next run even if results would look clean.
    const after = runEval(db, { ...opts, seed: 99 });
    expect(after.verdict.quarantined_tasks).toContain("flaky");

    // Human re-admission (kelson eval suite promote) clears it.
    promoteTask(db, "fixture-suite", "1", "flaky");
    const readmitted = runEval(db, { ...opts, seed: 100 });
    // The task may re-quarantine from its live window this same run — EVP-5
    // retains the window — but it must have re-entered evaluation: either it
    // counts in n (not quarantined) or it was re-quarantined by the detector
    // (a fresh quarantine event this run, not stickiness).
    const reQuarantined = readmitted.quarantine.some(
      (q) => q.task_id === "flaky",
    );
    const counted = !readmitted.verdict.quarantined_tasks.includes("flaky");
    expect(reQuarantined || counted).toBe(true);
    db.close();
  });
});
