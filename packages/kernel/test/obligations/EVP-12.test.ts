import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { effectiveConcurrency, runEval } from "../../src/evalrun.ts";
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

const orderedRows = (db: Database, runId: string) =>
  db
    .query(
      `SELECT bench_task_id, side, repeat_index, fpar_pass, cost_micro_usd
       FROM eval_task_result WHERE run_id = ? ORDER BY rowid`,
    )
    .all(runId);

describe("EVP-12: bounded concurrency changes throughput, never results", () => {
  it("concurrency 1 and 4 under the same seed yield identical ordered rows, identical verdict; manifest records the effective concurrency", async () => {
    const suiteDir = makeSuite([
      baseTask({ id: "t0", snapshot, session_command: CMD.costEffect }),
      baseTask({ id: "t1", snapshot, session_command: CMD.fparEffect }),
      baseTask({ id: "t2", snapshot, session_command: CMD.costEffect }),
    ]);
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
    const db1 = openDb(":memory:");
    const seq = await runEval(db1, { ...opts, concurrency: 1 });
    const seqRows = orderedRows(db1, seq.runId);
    db1.close();
    const db4 = openDb(":memory:");
    const conc = await runEval(db4, { ...opts, concurrency: 4 });
    const concRows = orderedRows(db4, conc.runId);
    db4.close();

    expect(concRows).toEqual(seqRows);
    expect(conc.verdict.decision).toBe(seq.verdict.decision);
    expect(conc.verdict.fpar_delta).toEqual(seq.verdict.fpar_delta);
    expect(conc.verdict.cost_delta_pct).toEqual(seq.verdict.cost_delta_pct);
    expect(conc.verdict.quarantined_tasks).toEqual(
      seq.verdict.quarantined_tasks,
    );
    // revert-check: an implementation that ignores opts.concurrency passes the
    // equality assertions above; the manifest recording is the discriminator.
    expect(seq.manifest.concurrency).toBe(1);
    expect(conc.manifest.concurrency).toBe(4);
  });

  it("cells genuinely overlap (recorded completion order differs from persisted order) while rows persist in suite-task, side, repeat order", async () => {
    // Injected async executor: every side-A cell sleeps while side-B cells
    // finish instantly, and each cell records its actual completion. With
    // concurrency 4 the first completion MUST be a B cell — if execution
    // were secretly serial (the F-100 vacuous-fixture failure this test
    // exists to catch), completions would equal submission order (A first).
    // (Suite task order is loadSuite's readdir order, so the persisted-order
    // expectation is derived from the manifest, never hardcoded.)
    const completions: string[] = [];
    const suiteDir = makeSuite([
      baseTask({ id: "t0", snapshot }),
      baseTask({ id: "t1", snapshot }),
    ]);
    const db = openDb(":memory:");
    const result = await runEval(db, {
      kind: "ablate",
      suiteDir,
      lockfileA: lockWith([{ name: "effectpack", enabled: true }]),
      lockfileB: lockWith([{ name: "effectpack", enabled: false }]),
      executor: "api",
      extraExecutors: {
        api: async (ctx) => {
          if (ctx.sideEnv.KELSON_SIDE === "A") await Bun.sleep(250);
          completions.push(`${ctx.task.id}:${ctx.sideEnv.KELSON_SIDE}`);
          return { ok: true, cost_micro_usd: 100, detail: null, raw_ref: null };
        },
      },
      profile: WORKTREE,
      repeats: 1,
      seed: 7,
      snapshotStoreDir: store,
      gateOpts: FAST_GATE,
      concurrency: 4,
    });
    const persisted = (
      orderedRows(db, result.runId) as {
        bench_task_id: string;
        side: string;
        repeat_index: number;
      }[]
    ).map((r) => `${r.bench_task_id}:${r.side}:${r.repeat_index}`);
    db.close();
    const submissionOrder = result.manifest.tasks.flatMap((t) => [
      `${t.id}:A:0`,
      `${t.id}:B:0`,
    ]);
    expect(persisted).toEqual(submissionOrder);
    expect(completions).toHaveLength(4);
    // Overlap proof: a B cell finished before any A cell.
    expect(completions[0]?.endsWith(":B")).toBe(true);
    expect(completions.map((c) => `${c}:0`)).not.toEqual(submissionOrder);
  });

  it("container profile clamps to sequential via the function runEval consults", () => {
    const container = {
      isolation: "container" as const,
      network: { policy: "deny" as const, allowlist: [] },
    };
    expect(effectiveConcurrency(container, 4)).toBe(1);
    expect(effectiveConcurrency(container, 100)).toBe(1);
    expect(effectiveConcurrency(WORKTREE, 4)).toBe(4);
    expect(effectiveConcurrency(WORKTREE, undefined)).toBe(1);
    // Identity with runEval: the worktree manifest cases above record
    // exactly effectiveConcurrency(WORKTREE, requested).
  });
});
