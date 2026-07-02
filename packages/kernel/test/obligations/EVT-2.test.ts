import { describe, expect, it } from "bun:test";
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

// One togglable fixture per pack kind (PackManifest.kind) — the eval tool
// treats them uniformly because each is just a lockfile entry.
const PACK_KINDS = [
  "stage-pack",
  "efficiency-pack",
  "spec-tooling-pack",
  "routing-pack",
  "eval-suite-pack",
  "agent-registry-pack",
];

describe("EVT-2: every pack type runs through ablate uniformly", () => {
  it("one fixture of each pack type completes ablate with a verdict", () => {
    const suiteDir = makeSuite([baseTask({ id: "t0", snapshot })]);
    for (const pack of PACK_KINDS) {
      const db = openDb(":memory:");
      const result = runEval(db, {
        kind: "ablate",
        suiteDir,
        lockfileA: lockWith(
          PACK_KINDS.map((name) => ({ name, enabled: true })),
        ),
        lockfileB: lockWith(
          PACK_KINDS.map((name) => ({ name, enabled: name !== pack })),
        ),
        executor: "command",
        profile: WORKTREE,
        repeats: 1,
        snapshotStoreDir: store,
        gateOpts: FAST_GATE,
      });
      expect(result.verdict.decision).toBeDefined();
      expect(result.manifest.config_a).not.toBe(result.manifest.config_b);
      db.close();
    }
  });
});
