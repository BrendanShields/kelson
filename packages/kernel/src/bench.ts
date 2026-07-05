import type { Database } from "bun:sqlite";
import type {
  BenchManifest as BenchManifestT,
  BenchTaskRow,
  Executor,
  SandboxProfile,
  Verdict,
} from "@kelson/schemas";
import { BenchManifest } from "@kelson/schemas";
import { hashContent } from "./artifacts.ts";
import {
  type Lockfileish,
  loadSuite,
  materializeClaudeSide,
} from "./evalrun.ts";
import { EXECUTORS, type ExecutorFn, runTask } from "./evaltask.ts";
import { canonicalJson, hashLockfile } from "./packs.ts";
import { createWorkspace } from "./sandbox.ts";
import { DEFAULT_SNAPSHOT_DIR } from "./snapshots.ts";
import { type GateOptions, gate, type PairedResult } from "./stats.ts";
import { ulid } from "./ulid.ts";

// EVP-11: the §2 seed derivation with the side component removed — the seed
// for a given (task, repeat) is identical across both agents by construction.
export const benchSeed = (
  runSeed: number,
  taskId: string,
  repeat: number,
): number =>
  Number.parseInt(
    hashContent(`${runSeed}:${taskId}:${repeat}`).slice(7, 15),
    16,
  );

export interface BenchRunOptions {
  suiteDir: string;
  // ordered per EVP-11: [candidate, baseline]; candidate feeds the gate as
  // side A. Identical names are legal (an A/A calibration run).
  executors: [Executor, Executor];
  lockfile: Lockfileish;
  profile: SandboxProfile;
  seed?: number;
  repeats?: number;
  snapshotStoreDir?: string;
  // EVP-11: applied identically to both agents' session env as
  // ANTHROPIC_MODEL — the PRD-S1 same-base-model comparison — and recorded
  // as model_versions.session_model. Absent → no model id recorded (an agent
  // whose session does not report its model is never guessed, PROV-3).
  model?: string;
  // EVP-9: caller-supplied executors (the CLI injects the native "api").
  extraExecutors?: Partial<Record<Executor, ExecutorFn>>;
  gateOpts?: GateOptions;
}

export interface BenchRunResult {
  runId: string;
  manifest: BenchManifestT;
  manifestHash: string;
  verdict: Verdict;
  rows: BenchTaskRow[];
  excludedTaskIds: string[];
  // UX-18/UX-P5: the effective gate minimum this run was judged against, so
  // an underpowered rendering states the TRUE deficit (not the default's).
  minSample: number;
}

const AGENTS = ["candidate", "baseline"] as const;

// EVP-11 divergence pin: strict majority — 1 iff passes > repeats/2; an even
// split fails. Mirrors runEval's majority.
const majority = (xs: { fpar: boolean }[]): 0 | 1 =>
  xs.filter((x) => x.fpar).length * 2 > xs.length ? 1 : 0;
const meanCost = (xs: { cost: number }[]): number =>
  xs.reduce((a, x) => a + x.cost, 0) / xs.length;

export const runBench = async (
  db: Database,
  opts: BenchRunOptions,
): Promise<BenchRunResult> => {
  // EVP-11 pre-flight: everything that can refuse does so before any
  // bench_run/bench_task_result write — a refusal writes nothing.
  const resolved = opts.executors.map((name) => {
    const fn = { ...EXECUTORS, ...opts.extraExecutors }[name];
    if (!fn)
      throw new Error(
        `executor "${name}" is not resolvable in this invocation — the CLI injects it via extraExecutors (EVP-9)`,
      );
    return fn;
  }) as [ExecutorFn, ExecutorFn];
  if (opts.executors.includes("api") && opts.profile.isolation === "container")
    throw new Error(
      'executor "api" under the container profile is refused — the native runtime\'s file tools do not cross the container boundary yet (EVP-9)',
    );

  const { suite, tasks } = loadSuite(opts.suiteDir);
  if (opts.executors.includes("command")) {
    const missing = tasks
      .filter((t) => t.session_command === null)
      .map((t) => t.id);
    if (missing.length)
      throw new Error(
        `executor "command" requires session_command; missing in task(s): ${missing.join(", ")}`,
      );
  }

  // EVP-11: quarantine snapshots at run start — excluded, named in the
  // manifest, never re-evaluated by a bench run. Read BEFORE the dimension
  // upsert so an all-quarantined refusal literally writes nothing (audit
  // 2026-07-05): the flag lives on pre-existing rows, so this run's upsert
  // cannot change the answer.
  const quarantined = new Set(
    (
      db
        .query(
          "SELECT id FROM benchmark_task WHERE suite_id = ? AND suite_version = ? AND quarantined = 1",
        )
        .all(suite.id, suite.version) as { id: string }[]
    ).map((r) => r.id),
  );
  const effective = [...tasks]
    .filter((t) => !quarantined.has(t.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (effective.length === 0)
    throw new Error(
      `bench refuses at pre-flight: no runnable tasks (${tasks.length}/${tasks.length} quarantined or suite empty) — a run that measures nothing is a misconfiguration, not a result (EVP-11)`,
    );

  // Dimension upsert (mirrors runEval; never touches the quarantined flag, so
  // a pre-existing quarantine survives). Not a bench-result write.
  db.query(
    "INSERT OR IGNORE INTO eval_suite (id, version, role) VALUES (?, ?, ?)",
  ).run(suite.id, suite.version, suite.role);
  for (const t of tasks)
    db.query(
      `INSERT INTO benchmark_task (id, suite_id, suite_version, snapshot_ref, statement, checks, budget_ceiling, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'seed')
       ON CONFLICT (id, suite_id, suite_version) DO UPDATE SET
         snapshot_ref = excluded.snapshot_ref, statement = excluded.statement,
         checks = excluded.checks, budget_ceiling = excluded.budget_ceiling`,
    ).run(
      t.id,
      suite.id,
      suite.version,
      t.snapshot,
      t.statement,
      JSON.stringify(t.checks),
      t.budget_ceiling_musd,
    );

  const repeats = opts.repeats ?? 3;
  const runSeed = opts.seed ?? 0;
  const runId = ulid();
  const config = hashLockfile(opts.lockfile);

  const manifest = BenchManifest.parse({
    schema_version: 1,
    kind: "bench",
    suite: suite.id,
    suite_version: suite.version,
    executor_candidate: opts.executors[0],
    executor_baseline: opts.executors[1],
    config,
    seed: runSeed,
    repeats,
    sandbox_profile: opts.profile,
    // EVP-11: session_model when --model is set; otherwise no model id is
    // recorded — never guessed (PROV-3 discipline).
    model_versions: opts.model ? { session_model: opts.model } : {},
    tasks: effective.map((t) => ({ id: t.id, snapshot: t.snapshot })),
    excluded_task_ids: [...quarantined].sort(),
  });
  const manifestHash = hashContent(canonicalJson(manifest));

  db.query(
    `INSERT INTO bench_run (id, suite_id, suite_version, executor_candidate, executor_baseline, config, seed, repeats, model_versions, sandbox_profile, manifest_hash, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    suite.id,
    suite.version,
    opts.executors[0],
    opts.executors[1],
    config,
    runSeed,
    repeats,
    JSON.stringify(manifest.model_versions),
    JSON.stringify(manifest.sandbox_profile),
    manifestHash,
    new Date().toISOString(),
  );

  const rows: BenchTaskRow[] = [];
  for (const task of effective) {
    const acc = {
      candidate: [] as { fpar: boolean; cost: number }[],
      baseline: [] as { fpar: boolean; cost: number }[],
    };
    for (let i = 0; i < repeats; i++) {
      for (const [idx, agent] of AGENTS.entries()) {
        const ws = createWorkspace(opts.profile, {
          snapshot: task.snapshot,
          storeDir: opts.snapshotStoreDir ?? DEFAULT_SNAPSHOT_DIR,
        });
        try {
          if (opts.executors[idx] === "claude")
            materializeClaudeSide(ws.dir, opts.lockfile);
          // EVP-11: a session failure inside runTask is a scored repeat (the
          // failed-session check), never a run abort.
          const outcome = await runTask(task, ws, resolved[idx] as ExecutorFn, {
            KELSON_SEED: String(benchSeed(runSeed, task.id, i)),
            KELSON_BENCH_AGENT: String(opts.executors[idx]),
            KELSON_BENCH_REPEAT: String(i),
            KELSON_ENABLED_PACKS: opts.lockfile.entries
              .filter((e) => e.enabled)
              .map((e) => e.name)
              .join(","),
            // EVP-11: --model rides identically into both agents' sessions
            // (api consumes it directly; claude via its env passthrough).
            ...(opts.model ? { ANTHROPIC_MODEL: opts.model } : {}),
          });
          db.query(
            `INSERT INTO bench_task_result (id, run_id, bench_task_id, agent, repeat_index, fpar_pass, cost_micro_usd, check_results, raw_ref, schema_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          ).run(
            ulid(),
            runId,
            task.id,
            agent,
            i,
            outcome.fpar_pass ? 1 : 0,
            outcome.cost_micro_usd,
            JSON.stringify(outcome.check_results),
            outcome.raw_ref,
          );
          acc[agent].push({
            fpar: outcome.fpar_pass,
            cost: outcome.cost_micro_usd,
          });
        } finally {
          ws.cleanup();
        }
      }
    }
    rows.push({
      task_id: task.id,
      candidate_fpar: majority(acc.candidate),
      baseline_fpar: majority(acc.baseline),
      candidate_cost_micro_usd: meanCost(acc.candidate),
      baseline_cost_micro_usd: meanCost(acc.baseline),
    });
  }

  // EVP-11: candidate is side A; the gate's verdict is relayed verbatim.
  const pairs: PairedResult[] = rows.map((r) => ({
    task_id: r.task_id,
    fpar_a: r.candidate_fpar,
    fpar_b: r.baseline_fpar,
    cost_a: r.candidate_cost_micro_usd,
    cost_b: r.baseline_cost_micro_usd,
  }));
  // UX-P5: the effective minimum this run is judged against — suite config
  // then explicit gateOpts, else the §5 default — surfaced so the rendered
  // deficit is the true one.
  const minSample = opts.gateOpts?.minSample ?? suite.min_sample ?? 20;
  const outcome = gate(pairs, {
    seed: runSeed,
    ...(suite.min_sample !== undefined ? { minSample: suite.min_sample } : {}),
    ...opts.gateOpts,
  });
  const verdict: Verdict = {
    id: ulid(),
    run_id: runId,
    decision: outcome.decision,
    fpar_delta: outcome.fpar_delta,
    cost_delta_pct: outcome.cost_delta_pct,
    n: outcome.n,
    alpha: outcome.alpha,
    bootstrap_resamples: outcome.resamples,
    quarantined_tasks: [...quarantined].sort(),
  };
  // EVP-11: exactly one terminal finalization write; the verdict table pairs
  // with eval_run and is not used here (structural ledger fence).
  db.query(
    "UPDATE bench_run SET verdict = ?, finished_at = ? WHERE id = ?",
  ).run(JSON.stringify(verdict), new Date().toISOString(), runId);

  return {
    runId,
    manifest,
    manifestHash,
    verdict,
    rows,
    excludedTaskIds: [...quarantined].sort(),
    minSample,
  };
};
