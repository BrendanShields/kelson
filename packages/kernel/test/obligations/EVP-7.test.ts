import { describe, expect, it } from "bun:test";
import { RunManifest } from "@kelson/schemas";
import { runEval, writeLedgerEntry } from "../../src/evalrun.ts";
import { commandExecutor, runTask } from "../../src/evaltask.ts";
import { createWorkspace } from "../../src/sandbox.ts";
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

const costOf = (sessionCommand: string) => {
  const task = baseTask({ id: "t", snapshot, session_command: sessionCommand });
  const ws = createWorkspace(WORKTREE, { snapshot, storeDir: store });
  try {
    return runTask(task, ws, commandExecutor, {});
  } finally {
    ws.cleanup();
  }
};

describe("EVP-7: executor recorded in manifest; cost-file contract; ledger refuses non-claude runs", () => {
  it("the run manifest schema requires the executor field", () => {
    const res = RunManifest.safeParse({
      schema_version: 1,
      kind: "ablate",
      suite: "s",
      suite_version: "1",
      config_a: `sha256:${"0".repeat(64)}`,
      config_b: `sha256:${"1".repeat(64)}`,
      seed: 0,
      repeats: 3,
      sandbox_profile: WORKTREE,
      model_versions: {},
      tasks: [],
    });
    expect(res.success).toBe(false);
  });

  it("a known cost written to $KELSON_COST_FILE is recorded exactly", () => {
    expect(costOf(CMD.cost("1500")).cost_micro_usd).toBe(1500);
  });

  it("malformed cost content records 0 with a warning; absence records 0 silently", () => {
    for (const garbage of ["abc", "-5", "1.5", ""]) {
      const out = costOf(`printf '${garbage}' > "$KELSON_COST_FILE"`);
      expect(out.cost_micro_usd).toBe(0);
    }
    expect(costOf("true").cost_micro_usd).toBe(0);
  });

  it("a command run with a task missing session_command refuses at pre-flight", () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([
      baseTask({ id: "has-cmd", snapshot }),
      baseTask({ id: "no-cmd", snapshot, session_command: null }),
    ]);
    expect(() =>
      runEval(db, {
        kind: "compare",
        suiteDir,
        lockfileA: lockWith([{ name: "p", enabled: true }]),
        lockfileB: lockWith([{ name: "p", enabled: false }]),
        executor: "command",
        profile: WORKTREE,
        repeats: 1,
        snapshotStoreDir: store,
        gateOpts: FAST_GATE,
      }),
    ).toThrow(/session_command; missing in task\(s\): no-cmd/);
    const rows = db.query("SELECT COUNT(*) AS n FROM eval_run").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
    db.close();
  });

  it("ledger publication from a command-executor run is refused with a diagnostic", () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([baseTask({ id: "t", snapshot })]);
    const result = runEval(db, {
      kind: "ablate",
      suiteDir,
      lockfileA: lockWith([{ name: "somepack", enabled: true }]),
      lockfileB: lockWith([{ name: "somepack", enabled: false }]),
      executor: "command",
      profile: WORKTREE,
      repeats: 1,
      snapshotStoreDir: store,
      gateOpts: FAST_GATE,
    });
    expect(() =>
      writeLedgerEntry(db, {
        runId: result.runId,
        pack: "somepack",
        version: "1.0.0",
        ledgerDir: tmpDir(),
      }),
    ).toThrow(/executor "command" is not publishable/);
    db.close();
  });
});
