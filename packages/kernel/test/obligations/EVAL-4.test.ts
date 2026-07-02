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

describe("EVAL-4: every run records enough to reproduce the comparison; re-running from the manifest reproduces verdicts", () => {
  const suiteDir = makeSuite(
    Array.from({ length: 3 }, (_, i) =>
      baseTask({ id: `t${i}`, snapshot, session_command: CMD.costEffect }),
    ),
  );
  const opts = {
    kind: "ablate" as const,
    suiteDir,
    lockfileA: lockWith([{ name: "effectpack", enabled: true }]),
    lockfileB: lockWith([{ name: "effectpack", enabled: false }]),
    executor: "command" as const,
    profile: WORKTREE,
    repeats: 2,
    seed: 42,
    snapshotStoreDir: store,
    gateOpts: FAST_GATE,
  };

  it("the manifest records lockfile hashes, suite version, model versions, seed, and per-task snapshots", () => {
    const db = openDb(":memory:");
    const { manifest } = runEval(db, opts);
    expect(manifest.config_a).toMatch(/^sha256:/);
    expect(manifest.config_b).toMatch(/^sha256:/);
    expect(manifest.config_a).not.toBe(manifest.config_b);
    expect(manifest.suite_version).toBe("1");
    expect(manifest.seed).toBe(42);
    expect(manifest.tasks).toHaveLength(3);
    expect(manifest.executor).toBe("command");
    db.close();
  });

  it("re-running from the recorded parameters reproduces identical verdicts for deterministic tasks", () => {
    const db1 = openDb(":memory:");
    const first = runEval(db1, opts);
    db1.close();
    const db2 = openDb(":memory:");
    const second = runEval(db2, opts);
    db2.close();
    expect(second.manifestHash).toBe(first.manifestHash);
    expect(second.verdict.decision).toBe(first.verdict.decision);
    expect(second.verdict.fpar_delta).toEqual(first.verdict.fpar_delta);
    expect(second.verdict.cost_delta_pct).toEqual(first.verdict.cost_delta_pct);
  });
});
