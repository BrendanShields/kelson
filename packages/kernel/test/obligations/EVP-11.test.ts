import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runBench } from "../../src/bench.ts";
import { writeLedgerEntry } from "../../src/evalrun.ts";
import type { ExecutorFn } from "../../src/evaltask.ts";
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
const LOCK = lockWith([{ name: "p", enabled: true }]);

// A stub "api" agent injected via extraExecutors (EVP-9): hand-known outcome,
// captures the env each session received so seed/agent-mark assertions read
// what the session actually saw — not what the implementation derives.
const stubAgent = (
  cost: number,
  ok: boolean,
): {
  fn: ExecutorFn;
  seen: { taskId: string; env: Record<string, string> }[];
} => {
  const seen: { taskId: string; env: Record<string, string> }[] = [];
  const fn: ExecutorFn = (ctx) => {
    seen.push({ taskId: ctx.task.id, env: { ...ctx.sideEnv } });
    return { ok, cost_micro_usd: cost, detail: null, raw_ref: null };
  };
  return { fn, seen };
};

describe("EVP-11: cross-agent bench — own tables, shared seeds, structural ledger fence", () => {
  it("hand-known per-agent outcomes yield the hand-computed pairs and verdict; eval tables untouched", async () => {
    const db = openDb(":memory:");
    const capDir = tmpDir();
    const capFile = join(capDir, "seeds.txt");
    // The command side branches on KELSON_BENCH_AGENT (the obligation's
    // fixture shape) and records the env line the session saw. Every baseline
    // session exits 1 — a failed session is a scored repeat, and the run
    // still completes to a verdict (divergence pin).
    const sessionCommand = `printf '%s %s %s\\n' "$KELSON_BENCH_AGENT" "$KELSON_BENCH_REPEAT" "$KELSON_SEED" >> '${capFile}'; case "$KELSON_BENCH_AGENT" in command) printf 200 > "$KELSON_COST_FILE"; exit 1;; *) exit 0;; esac`;
    const suiteDir = makeSuite([
      baseTask({ id: "t-a", snapshot, session_command: sessionCommand }),
      baseTask({ id: "t-b", snapshot, session_command: sessionCommand }),
      baseTask({ id: "t-c", snapshot, session_command: sessionCommand }),
    ]);
    const api = stubAgent(100, true);

    const result = await runBench(db, {
      suiteDir,
      executors: ["api", "command"],
      lockfile: LOCK,
      profile: WORKTREE,
      repeats: 2,
      snapshotStoreDir: store,
      extraExecutors: { api: api.fn },
      gateOpts: FAST_GATE,
    });

    // Hand-computed pairing: candidate (api stub) passes every repeat at 100;
    // baseline (command) fails every repeat at 200. Expected per task:
    // fpar 1 vs 0, mean cost 100 vs 200 — and the §5 table says non-inferior
    // + improved on FPAR with cost also improved = "helps" (computed by hand
    // from the decision table, not by calling gate()).
    expect(result.rows).toEqual([
      {
        task_id: "t-a",
        candidate_fpar: 1,
        baseline_fpar: 0,
        candidate_cost_micro_usd: 100,
        baseline_cost_micro_usd: 200,
      },
      {
        task_id: "t-b",
        candidate_fpar: 1,
        baseline_fpar: 0,
        candidate_cost_micro_usd: 100,
        baseline_cost_micro_usd: 200,
      },
      {
        task_id: "t-c",
        candidate_fpar: 1,
        baseline_fpar: 0,
        candidate_cost_micro_usd: 100,
        baseline_cost_micro_usd: 200,
      },
    ]);
    expect(result.verdict.decision).toBe("helps");
    expect(result.verdict.n).toBe(3);
    // No --model: no model id recorded — never guessed (PROV-3 discipline).
    expect(result.manifest.model_versions).toEqual({});

    // Seed contract: for each (task, repeat) the command line and the stub's
    // captured env carry the SAME seed; across repeats of one task they differ.
    const lines = (await Bun.file(capFile).text())
      .trim()
      .split("\n")
      .map((l) => l.split(" ") as [string, string, string]);
    expect(lines.length).toBe(6); // 3 tasks × 2 repeats, command side only
    for (const [agent] of lines) expect(agent).toBe("command");
    const stubSeed = new Map(
      api.seen.map((s) => [
        `${s.taskId}:${s.env.KELSON_BENCH_REPEAT}`,
        s.env.KELSON_SEED,
      ]),
    );
    const cmdSeeds = new Map<string, string[]>();
    for (let i = 0; i < lines.length; i++) {
      const [, repeat, seed] = lines[i] as [string, string, string];
      const taskId = (["t-a", "t-b", "t-c"] as const)[Math.floor(i / 2)];
      expect(seed).toBe(stubSeed.get(`${taskId}:${repeat}`) as string);
      cmdSeeds.set(taskId as string, [
        ...(cmdSeeds.get(taskId as string) ?? []),
        seed,
      ]);
    }
    for (const [, seeds] of cmdSeeds) expect(seeds[0]).not.toBe(seeds[1]);
    for (const s of api.seen) expect(s.env.KELSON_BENCH_AGENT).toBe("api");

    // Own tables only: eval_run/eval_task_result untouched (flaky windows
    // cannot see bench data); 12 append-only bench rows + 1 finalized run.
    expect(
      (db.query("SELECT COUNT(*) AS n FROM eval_run").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (
        db.query("SELECT COUNT(*) AS n FROM eval_task_result").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      (
        db.query("SELECT COUNT(*) AS n FROM bench_task_result").get() as {
          n: number;
        }
      ).n,
    ).toBe(12);
    const run = db
      .query("SELECT verdict, finished_at FROM bench_run WHERE id = ?")
      .get(result.runId) as { verdict: string; finished_at: string };
    expect(JSON.parse(run.verdict).decision).toBe("helps");
    expect(run.finished_at).not.toBeNull();

    // Append-only: UPDATE refused by trigger.
    expect(() =>
      db.query("UPDATE bench_task_result SET fpar_pass = 1").run(),
    ).toThrow(/append-only/);

    // Structural ledger fence: a bench run id resolves to no eval_run row.
    expect(() =>
      writeLedgerEntry(db, {
        runId: result.runId,
        pack: "p",
        version: "1.0.0",
        ledgerDir: tmpDir(),
      }),
    ).toThrow(/unknown run/);
    db.close();
  }, 30_000);

  it("a pre-quarantined task is excluded from pairs and named in the manifest", async () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([
      baseTask({ id: "clean", snapshot }),
      baseTask({ id: "quar", snapshot }),
    ]);
    db.query(
      `INSERT INTO benchmark_task (id, suite_id, suite_version, snapshot_ref, statement, checks, budget_ceiling, origin, quarantined)
       VALUES ('quar', 'fixture-suite', '1', ?, 's', '[]', 1, 'seed', 1)`,
    ).run(snapshot);
    const api = stubAgent(100, true);
    const result = await runBench(db, {
      suiteDir,
      executors: ["api", "command"],
      lockfile: LOCK,
      profile: WORKTREE,
      repeats: 1,
      snapshotStoreDir: store,
      extraExecutors: { api: api.fn },
      gateOpts: FAST_GATE,
    });
    expect(result.rows.map((r) => r.task_id)).toEqual(["clean"]);
    expect(result.excludedTaskIds).toEqual(["quar"]);
    expect(result.manifest.excluded_task_ids).toEqual(["quar"]);
    expect(
      (
        db
          .query(
            "SELECT COUNT(*) AS n FROM bench_task_result WHERE bench_task_id = 'quar'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
    db.close();
  }, 30_000);

  it("an all-quarantined suite refuses pre-flight writing nothing", async () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([baseTask({ id: "only", snapshot })]);
    db.query(
      `INSERT INTO benchmark_task (id, suite_id, suite_version, snapshot_ref, statement, checks, budget_ceiling, origin, quarantined)
       VALUES ('only', 'fixture-suite', '1', ?, 's', '[]', 1, 'seed', 1)`,
    ).run(snapshot);
    const api = stubAgent(100, true);
    await expect(
      runBench(db, {
        suiteDir,
        executors: ["api", "command"],
        lockfile: LOCK,
        profile: WORKTREE,
        snapshotStoreDir: store,
        extraExecutors: { api: api.fn },
      }),
    ).rejects.toThrow(/no runnable tasks/);
    for (const table of ["bench_run", "bench_task_result"])
      expect(
        (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
          .n,
      ).toBe(0);
    expect(api.seen.length).toBe(0);
    db.close();
  });

  it("an unresolvable executor refuses pre-flight writing nothing (EVP-9)", async () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([baseTask({ id: "t", snapshot })]);
    // "api" without extraExecutors is unresolvable in this invocation.
    await expect(
      runBench(db, {
        suiteDir,
        executors: ["api", "command"],
        lockfile: LOCK,
        profile: WORKTREE,
        snapshotStoreDir: store,
      }),
    ).rejects.toThrow(/not resolvable/);
    for (const table of ["bench_run", "bench_task_result"])
      expect(
        (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
          .n,
      ).toBe(0);
    db.close();
  });

  it("--model rides identically into both agents' session env and the manifest records session_model", async () => {
    const db = openDb(":memory:");
    const suiteDir = makeSuite([baseTask({ id: "t", snapshot })]);
    // Two distinct agent names, both stubbed (extraExecutors wins on
    // collision with the built-in table), so each side's received env is
    // captured directly.
    const a = stubAgent(100, true);
    const b = stubAgent(100, true);
    const result = await runBench(db, {
      suiteDir,
      executors: ["api", "claude"],
      lockfile: LOCK,
      profile: WORKTREE,
      repeats: 1,
      snapshotStoreDir: store,
      extraExecutors: { api: a.fn, claude: b.fn },
      gateOpts: FAST_GATE,
      model: "m-x",
    });
    expect(result.manifest.model_versions).toEqual({ session_model: "m-x" });
    for (const s of [...a.seen, ...b.seen])
      expect(s.env.ANTHROPIC_MODEL).toBe("m-x");
    expect(a.seen.length).toBe(1);
    expect(b.seen.length).toBe(1);
    db.close();
  }, 30_000);

  it("a 1-of-2 even split scores task FPAR 0 — strict majority (divergence pin)", async () => {
    const db = openDb(":memory:");
    // Candidate (command) passes repeat 0 only: an even split. Its repeat-1
    // failure is also the mid-run-failure probe: the row lands and the run
    // completes.
    const suiteDir = makeSuite([
      baseTask({
        id: "tie",
        snapshot,
        session_command: '[ "$KELSON_BENCH_REPEAT" = "0" ]',
      }),
    ]);
    const api = stubAgent(100, true);
    const result = await runBench(db, {
      suiteDir,
      executors: ["command", "api"],
      lockfile: LOCK,
      profile: WORKTREE,
      repeats: 2,
      snapshotStoreDir: store,
      extraExecutors: { api: api.fn },
      gateOpts: FAST_GATE,
    });
    expect(result.rows[0]?.candidate_fpar).toBe(0);
    expect(result.rows[0]?.baseline_fpar).toBe(1);
    // both candidate repeats are scored rows (pass then fail), run completed
    const rows = db
      .query(
        "SELECT fpar_pass FROM bench_task_result WHERE agent = 'candidate' ORDER BY repeat_index",
      )
      .all() as { fpar_pass: number }[];
    expect(rows.map((r) => r.fpar_pass)).toEqual([1, 0]);
    expect(result.verdict).toBeDefined();
    db.close();
  }, 30_000);
});
