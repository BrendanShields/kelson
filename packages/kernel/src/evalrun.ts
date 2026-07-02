import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BenchmarkTask,
  EvalSuite,
  type Executor,
  LedgerEntry,
  RunManifest,
  type SandboxProfile,
  type Verdict,
  type VerdictDecision,
} from "@kelson/schemas";
import { hashContent } from "./artifacts.ts";
import { BudgetMonitor } from "./budget.ts";
import { EXECUTORS, runTask } from "./evaltask.ts";
import { evaluateFlakiness, type QuarantineEvent } from "./flaky.ts";
import { canonicalJson, hashLockfile } from "./packs.ts";
import {
  extractFeatures,
  loadPolicy,
  loadRegistry,
  policyHash,
  route,
} from "./routing.ts";
import { createWorkspace } from "./sandbox.ts";
import { DEFAULT_SNAPSHOT_DIR } from "./snapshots.ts";
import {
  GATE_DEFAULTS,
  type GateOptions,
  gate,
  type PairedResult,
} from "./stats.ts";
import { ulid } from "./ulid.ts";

export interface LoadedSuite {
  suite: EvalSuite;
  tasks: BenchmarkTask[];
}

export const loadSuite = (suiteDir: string): LoadedSuite => {
  const suite = EvalSuite.parse(
    Bun.YAML.parse(readFileSync(join(suiteDir, "suite.yaml"), "utf8")),
  );
  const tasks = readdirSync(suiteDir, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && existsSync(join(suiteDir, d.name, "task.yaml")),
    )
    .map((d) =>
      BenchmarkTask.parse(
        Bun.YAML.parse(
          readFileSync(join(suiteDir, d.name, "task.yaml"), "utf8"),
        ),
      ),
    );
  if (tasks.length === 0) throw new Error(`suite has no tasks: ${suiteDir}`);
  return { suite, tasks };
};

// seed_i = H(run_seed, task_id, side, i) — deterministic from the manifest
// (EVP §2), surfaced to the session via KELSON_SEED.
export const taskSeed = (
  runSeed: number,
  taskId: string,
  side: "A" | "B",
  repeat: number,
): number =>
  Number.parseInt(
    hashContent(`${runSeed}:${taskId}:${side}:${repeat}`).slice(7, 15),
    16,
  );

interface Lockfileish {
  entries: { name: string; enabled: boolean }[];
}

// Side materialization: command sessions read KELSON_* env; claude sessions
// read workspace .claude/settings.json plugin toggles.
const sideEnvFor = (
  side: "A" | "B",
  lockfile: Lockfileish,
  seed: number,
  sessionModel?: { model: string; baseUrl?: string },
): Record<string, string> => ({
  KELSON_SIDE: side,
  KELSON_SEED: String(seed),
  KELSON_ENABLED_PACKS: lockfile.entries
    .filter((e) => e.enabled)
    .map((e) => e.name)
    .join(","),
  // EVP-8: the override rides the session env, so it lands after the auth
  // passthrough and wins; local endpoints need a non-empty dummy key.
  ...(sessionModel
    ? {
        ANTHROPIC_MODEL: sessionModel.model,
        ...(sessionModel.baseUrl
          ? {
              ANTHROPIC_BASE_URL: sessionModel.baseUrl,
              ANTHROPIC_API_KEY: "kelson-local",
            }
          : {}),
      }
    : {}),
});

const materializeClaudeSide = (dir: string, lockfile: Lockfileish): void => {
  const enabledPlugins = Object.fromEntries(
    lockfile.entries.map((e) => [
      e.name.includes("@") ? e.name : `${e.name}@${e.name}`,
      e.enabled,
    ]),
  );
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    `${JSON.stringify({ enabledPlugins }, null, 2)}\n`,
  );
};

export const togglePack = <L extends Lockfileish>(
  lockfile: L,
  pack: string,
): L => {
  const entry = lockfile.entries.find((e) => e.name === pack);
  if (!entry) throw new Error(`pack not in lockfile: ${pack}`);
  return {
    ...lockfile,
    entries: lockfile.entries.map((e) =>
      e.name === pack ? { ...e, enabled: !e.enabled } : e,
    ),
  };
};

export interface EvalRunOptions {
  kind: "ablate" | "compare";
  suiteDir: string;
  lockfileA: Lockfileish;
  lockfileB: Lockfileish;
  executor: Executor;
  profile: SandboxProfile;
  seed?: number;
  repeats?: number;
  snapshotStoreDir?: string;
  modelVersions?: Record<string, string>;
  // EVP-8: same override on both sides; recorded in the manifest; bars ledger.
  sessionModel?: { model: string; baseUrl?: string };
  // RTR-1/CTX-4 integration: when the named pack is enabled on a side, each
  // task is routed (decision recorded, model + budget from the policy);
  // a disabled side runs the baseline (highest-cost) registry model.
  routing?: { pack: string; policyPath: string; registryDir: string };
  gateOpts?: GateOptions;
  flaky?: { k?: number; minMinority?: number };
}

export interface EvalRunResult {
  runId: string;
  manifest: RunManifest;
  manifestHash: string;
  verdict: Verdict;
  quarantine: QuarantineEvent[];
}

export const runEval = (db: Database, opts: EvalRunOptions): EvalRunResult => {
  const { suite, tasks } = loadSuite(opts.suiteDir);
  // EVP-7 (divergence-pinned): executor/task-shape mismatch refuses at
  // pre-flight, before any sandbox or task starts — never mid-run.
  if (opts.executor === "command") {
    const missing = tasks
      .filter((t) => t.session_command === null)
      .map((t) => t.id);
    if (missing.length)
      throw new Error(
        `executor "command" requires session_command; missing in task(s): ${missing.join(", ")}`,
      );
  }
  const repeats = opts.repeats ?? 3;
  const runSeed = opts.seed ?? 0;
  const runId = ulid();
  const configA = hashLockfile(opts.lockfileA);
  const configB = hashLockfile(opts.lockfileB);

  if (opts.routing && opts.sessionModel)
    throw new Error(
      "routing and a session model override cannot combine — the routed model would silently clobber the override while the manifest still records it (EVP-8)",
    );
  const routing = opts.routing
    ? (() => {
        const policy = loadPolicy(opts.routing.policyPath);
        const registry = loadRegistry(opts.routing.registryDir);
        const baseline = [...registry].sort(
          (a, b) => b.cost_class - a.cost_class,
        )[0];
        if (!baseline) throw new Error("routing registry is empty");
        return { policy, registry, baseline, hash: policyHash(policy) };
      })()
    : null;

  const manifest = RunManifest.parse({
    schema_version: 1,
    kind: opts.kind,
    suite: suite.id,
    suite_version: suite.version,
    config_a: configA,
    config_b: configB,
    seed: runSeed,
    repeats,
    executor: opts.executor,
    sandbox_profile: opts.profile,
    model_versions: {
      ...opts.modelVersions,
      ...(routing
        ? {
            routing_policy: routing.hash,
            baseline_model: routing.baseline.endpoint.ref,
          }
        : {}),
      ...(opts.sessionModel
        ? {
            session_model: opts.sessionModel.model,
            ...(opts.sessionModel.baseUrl
              ? { session_base_url: opts.sessionModel.baseUrl }
              : {}),
          }
        : {}),
    },
    tasks: tasks.map((t) => ({ id: t.id, snapshot: t.snapshot })),
  });
  const manifestHash = hashContent(canonicalJson(manifest));

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

  db.query(
    `INSERT INTO eval_run (id, kind, suite_id, suite_version, config_a, config_b, seed, executor, model_versions, sandbox_profile, manifest_hash, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    opts.kind,
    suite.id,
    suite.version,
    configA,
    configB,
    runSeed,
    opts.executor,
    JSON.stringify(manifest.model_versions),
    JSON.stringify(manifest.sandbox_profile),
    manifestHash,
    new Date().toISOString(),
  );

  const executor = EXECUTORS[opts.executor];
  const sides = [
    { side: "A" as const, lockfile: opts.lockfileA },
    { side: "B" as const, lockfile: opts.lockfileB },
  ];
  const byTask = new Map<
    string,
    {
      A: { fpar: boolean; cost: number }[];
      B: { fpar: boolean; cost: number }[];
    }
  >();

  for (const task of tasks) {
    const acc = { A: [], B: [] } as NonNullable<ReturnType<typeof byTask.get>>;
    byTask.set(task.id, acc);
    for (const { side, lockfile } of sides) {
      for (let i = 0; i < repeats; i++) {
        const ws = createWorkspace(opts.profile, {
          snapshot: task.snapshot,
          storeDir: opts.snapshotStoreDir ?? DEFAULT_SNAPSHOT_DIR,
        });
        try {
          if (opts.executor === "claude")
            materializeClaudeSide(ws.dir, lockfile);
          const stepId = `${runId}:${task.id}:${side}:${i}`;
          let routedEnv: Record<string, string> = {};
          let monitor: BudgetMonitor | null = null;
          if (routing) {
            const enabled = lockfile.entries.some(
              (e) => e.name === opts.routing?.pack && e.enabled,
            );
            if (enabled) {
              // Benchmark tasks carry no plan yet, so every feature falls
              // back per the RPOL-2 table (lang honestly "unknown") — per-task
              // extraction lands with the Phase 4 pipeline (F-062).
              const vector = extractFeatures({
                step: "build",
                repo: suite.id,
              });
              const decision = route(db, {
                policy: routing.policy,
                registry: routing.registry,
                vector,
                taskId: task.id,
                stepId,
              });
              const entry = routing.registry.find(
                (e) => e.id === decision.target,
              );
              if (!entry)
                throw new Error(
                  `routed target not in registry: ${decision.target}`,
                );
              routedEnv = { ANTHROPIC_MODEL: entry.endpoint.ref };
              monitor = new BudgetMonitor(db, {
                taskId: task.id,
                stepId,
                attempt: 0,
                ruleId: `rule:${decision.rule_index}`,
                policyHash: routing.hash,
                modelId: entry.endpoint.ref,
                escalationDepth: 0,
                budgetTokens: decision.budget_tokens,
              });
            } else {
              routedEnv = { ANTHROPIC_MODEL: routing.baseline.endpoint.ref };
            }
          }
          const outcome = runTask(task, ws, executor, {
            ...sideEnvFor(
              side,
              lockfile,
              taskSeed(runSeed, task.id, side, i),
              opts.sessionModel,
            ),
            ...routedEnv,
          });
          if (monitor && outcome.raw_ref) {
            try {
              const usage = (
                JSON.parse(outcome.raw_ref) as {
                  usage?: { input_tokens?: number; output_tokens?: number };
                }
              ).usage;
              const tokens =
                (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
              // Single post-session accounting point. A 2x pause stays OPEN:
              // the session already finished, so any resolution event would
              // be fiction — the durable pause is the honest record (F-063).
              monitor.record(tokens);
            } catch (e) {
              console.error(
                `budget accounting skipped for ${stepId}: unparseable session usage (${(e as Error).message})`,
              );
            }
          }
          db.query(
            `INSERT INTO eval_task_result (id, run_id, bench_task_id, side, repeat_index, fpar_pass, cost_micro_usd, check_results, raw_ref, schema_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          ).run(
            ulid(),
            runId,
            task.id,
            side,
            i,
            outcome.fpar_pass ? 1 : 0,
            outcome.cost_micro_usd,
            JSON.stringify(outcome.check_results),
            outcome.raw_ref,
          );
          acc[side].push({
            fpar: outcome.fpar_pass,
            cost: outcome.cost_micro_usd,
          });
        } finally {
          ws.cleanup();
        }
      }
    }
  }

  // EVAL-3/EVP-5: quarantine moves happen before gate math; newly quarantined
  // tasks are excluded from this run's gate.
  const quarantine = evaluateFlakiness(db, {
    suiteId: suite.id,
    suiteVersion: suite.version,
    configs: [configA, configB],
    ...opts.flaky,
  });
  const quarantinedIds = new Set(
    (
      db
        .query(
          "SELECT id FROM benchmark_task WHERE suite_id = ? AND suite_version = ? AND quarantined = 1",
        )
        .all(suite.id, suite.version) as { id: string }[]
    ).map((r) => r.id),
  );

  const majority = (xs: { fpar: boolean }[]) =>
    xs.filter((x) => x.fpar).length * 2 > xs.length ? 1 : 0;
  const meanCost = (xs: { cost: number }[]) =>
    xs.reduce((a, x) => a + x.cost, 0) / xs.length;
  const pairs: PairedResult[] = tasks
    .filter((t) => !quarantinedIds.has(t.id))
    .map((t) => {
      const acc = byTask.get(t.id) as NonNullable<
        ReturnType<typeof byTask.get>
      >;
      return {
        task_id: t.id,
        fpar_a: majority(acc.A),
        fpar_b: majority(acc.B),
        cost_a: meanCost(acc.A),
        cost_b: meanCost(acc.B),
      };
    });

  const outcome = gate(pairs, { seed: runSeed, ...opts.gateOpts });
  const verdict: Verdict = {
    id: ulid(),
    run_id: runId,
    decision: outcome.decision,
    fpar_delta: outcome.fpar_delta,
    cost_delta_pct: outcome.cost_delta_pct,
    n: outcome.n,
    alpha: outcome.alpha,
    bootstrap_resamples: outcome.resamples,
    quarantined_tasks: [...quarantinedIds].sort(),
  };
  db.query(
    "INSERT INTO verdict (id, run_id, decision, deltas, n, alpha) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    verdict.id,
    runId,
    verdict.decision,
    JSON.stringify({
      fpar: verdict.fpar_delta,
      cost_pct: verdict.cost_delta_pct,
    }),
    verdict.n,
    verdict.alpha,
  );
  db.query("UPDATE eval_run SET finished_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    runId,
  );

  return { runId, manifest, manifestHash, verdict, quarantine };
};

// EVT-3 / EVP-6 / EVP-7: ledger entries come only from completed claude-
// executor runs; command runs are evidence about the runner, not the pack.
export const writeLedgerEntry = (
  db: Database,
  args: {
    runId: string;
    pack: string;
    version: string;
    ledgerDir: string;
  },
): string => {
  const run = db
    .query(
      "SELECT executor, suite_id, suite_version, manifest_hash, finished_at, model_versions FROM eval_run WHERE id = ?",
    )
    .get(args.runId) as {
    executor: string;
    suite_id: string;
    suite_version: string;
    manifest_hash: string;
    finished_at: string | null;
    model_versions: string;
  } | null;
  if (!run) throw new Error(`unknown run: ${args.runId}`);
  if (run.executor !== "claude")
    throw new Error(
      `refusing to publish run ${args.runId}: executor "${run.executor}" is not publishable; ledger accepts executor "claude" only (EVP-7)`,
    );
  if (!run.finished_at)
    throw new Error(`refusing to publish run ${args.runId}: run not finished`);
  const models = JSON.parse(run.model_versions) as Record<string, string>;
  if (models.session_model)
    throw new Error(
      `refusing to publish run ${args.runId}: session model override "${models.session_model}" — overridden runs are proxy evidence and never reach the ledger (EVP-8)`,
    );
  const v = db
    .query("SELECT decision, deltas, n, alpha FROM verdict WHERE run_id = ?")
    .get(args.runId) as {
    decision: string;
    deltas: string;
    n: number;
    alpha: number;
  } | null;
  if (!v) throw new Error(`no verdict for run: ${args.runId}`);
  const deltas = JSON.parse(v.deltas) as {
    fpar: Verdict["fpar_delta"];
    cost_pct: Verdict["cost_delta_pct"];
  };
  const entry = LedgerEntry.parse({
    schema_version: 1,
    pack: args.pack,
    version: args.version,
    run_manifest_hash: run.manifest_hash,
    suite: `${run.suite_id}@${run.suite_version}`,
    verdict: v.decision as VerdictDecision,
    fpar_delta: deltas.fpar,
    cost_delta_pct: deltas.cost_pct,
    n: v.n,
    date: new Date().toISOString(),
  });
  const dir = join(args.ledgerDir, args.pack);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${args.version}.json`);
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`);
  return path;
};

// EVP-6 verification half: an entry must match the run manifest it names.
export const verifyLedgerEntry = (
  db: Database,
  entryPath: string,
): { ok: boolean; problems: string[] } => {
  const entry = LedgerEntry.parse(JSON.parse(readFileSync(entryPath, "utf8")));
  const run = db
    .query("SELECT id FROM eval_run WHERE manifest_hash = ?")
    .get(entry.run_manifest_hash) as { id: string } | null;
  if (!run) return { ok: false, problems: ["no run with named manifest hash"] };
  const v = db
    .query("SELECT decision, deltas, n FROM verdict WHERE run_id = ?")
    .get(run.id) as { decision: string; deltas: string; n: number } | null;
  if (!v) return { ok: false, problems: ["run has no verdict"] };
  const deltas = JSON.parse(v.deltas) as {
    fpar: Verdict["fpar_delta"];
    cost_pct: Verdict["cost_delta_pct"];
  };
  const problems: string[] = [];
  if (entry.verdict !== v.decision) problems.push("verdict mismatch");
  if (entry.n !== v.n) problems.push("n mismatch");
  if (canonicalJson(entry.fpar_delta) !== canonicalJson(deltas.fpar))
    problems.push("fpar_delta mismatch");
  if (canonicalJson(entry.cost_delta_pct) !== canonicalJson(deltas.cost_pct))
    problems.push("cost_delta_pct mismatch");
  return { ok: problems.length === 0, problems };
};
