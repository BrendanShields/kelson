import { describe, expect, it } from "bun:test";
import { RunManifest, SandboxProfile } from "@kelson/schemas";
import { runEval } from "../../src/evalrun.ts";
import { openDb } from "../../src/storage.ts";
import {
  baseTask,
  FAST_GATE,
  lockWith,
  makeSnapshot,
  makeSuite,
  tmpDir,
  WORKTREE,
} from "../eval-helpers.ts";

const store = tmpDir();
const snapshot = makeSnapshot({ "README.md": "x\n" }, store);

describe("SEC-3: every eval run records its sandbox profile in the run manifest", () => {
  it("the manifest schema requires isolation level and network policy", () => {
    expect(SandboxProfile.safeParse({ isolation: "worktree" }).success).toBe(
      false,
    );
    expect(RunManifest.shape.sandbox_profile.safeParse(WORKTREE).success).toBe(
      true,
    );
  });

  it("a live run's manifest and eval_run row carry the profile", () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([baseTask({ id: "t", snapshot })]);
    const { manifest, runId } = runEval(db, {
      kind: "ablate",
      suiteDir,
      lockfileA: lockWith([{ name: "p", enabled: true }]),
      lockfileB: lockWith([{ name: "p", enabled: false }]),
      executor: "command",
      profile: WORKTREE,
      repeats: 1,
      snapshotStoreDir: store,
      gateOpts: FAST_GATE,
    });
    expect(manifest.sandbox_profile).toEqual(WORKTREE);
    const row = db
      .query("SELECT sandbox_profile FROM eval_run WHERE id = ?")
      .get(runId) as { sandbox_profile: string };
    expect(JSON.parse(row.sandbox_profile)).toEqual(WORKTREE);
    db.close();
  });
});
