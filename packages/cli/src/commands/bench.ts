import { join } from "node:path";
import {
  DEFAULT_DB_PATH,
  runBench as kernelRunBench,
  openDb,
} from "@kelson/kernel";
import {
  BenchReport,
  Executor,
  Lockfile,
  SandboxProfile,
} from "@kelson/schemas";
import { fail } from "../agent/common.js";
import { panel, renderVerdict, table } from "../components/render.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";

// UX-18 (F-085): the CLI dispatches to the exported kernel entry — this
// re-export is the identity the obligation test checks against.
export const BENCH_ENTRY = kernelRunBench;

const parseArgs = (
  argv: string[],
): { positional: string[]; named: Record<string, string | true> } => {
  const positional: string[] = [];
  const named: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        named[a.slice(2)] = next;
        i++;
      } else named[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, named };
};

// UX-18: `kelson bench --suite <dir> [--agents a,b] [--repeats n] [--seed s]
// [--json]` — an EVP-11 cross-agent run through the kernel entry point.
export const benchCommand = async (argv: string[]): Promise<void> => {
  const { named } = parseArgs(argv);
  const suiteDir =
    typeof named.suite === "string"
      ? named.suite
      : fail("--suite <dir> is required");
  const agentNames = (
    typeof named.agents === "string" ? named.agents : "api,claude"
  ).split(",");
  if (agentNames.length !== 2)
    return fail(
      `--agents takes exactly two comma-separated executors [candidate,baseline]; got ${agentNames.length}`,
    );
  const parsedAgents = agentNames.map((a) => {
    const p = Executor.safeParse(a.trim());
    if (!p.success)
      return fail(
        `unknown executor: ${a.trim()} (have: ${Executor.options.join(", ")})`,
      );
    return p.data;
  }) as [Executor, Executor];
  const isolation =
    typeof named.profile === "string" ? named.profile : "worktree";
  const profile = SandboxProfile.parse({
    isolation,
    network:
      isolation === "container"
        ? { policy: "deny", allowlist: [] }
        : { policy: "inherit" },
  });
  const lockfilePath =
    typeof named.lockfile === "string"
      ? named.lockfile
      : join(process.cwd(), "kelson.lock");
  let lockfile: Lockfile;
  try {
    lockfile = Lockfile.parse(JSON.parse(await Bun.file(lockfilePath).text()));
  } catch (e) {
    return fail(
      `cannot load lockfile ${lockfilePath}: ${(e as Error).message}`,
    );
  }

  const db = openDb(typeof named.db === "string" ? named.db : DEFAULT_DB_PATH);
  try {
    // EVP-9: the composition root injects the native executor.
    const { apiExecutor } = await import("@kelson/agent");
    let result: Awaited<ReturnType<typeof BENCH_ENTRY>>;
    try {
      result = await BENCH_ENTRY(db, {
        suiteDir,
        executors: parsedAgents,
        lockfile,
        profile,
        extraExecutors: { api: apiExecutor },
        ...(typeof named.seed === "string" ? { seed: Number(named.seed) } : {}),
        ...(typeof named.repeats === "string"
          ? { repeats: Number(named.repeats) }
          : {}),
        ...(typeof named.snapshots === "string"
          ? { snapshotStoreDir: named.snapshots }
          : {}),
        // EVP-11: same model to both agents (PRD-S1 comparison basis).
        ...(typeof named.model === "string" ? { model: named.model } : {}),
      });
    } catch (e) {
      // UX-18: a refusal exits non-zero with a kelson: diagnostic, not a
      // raw stack (pre-flight refusals are expected operator feedback).
      return fail((e as Error).message);
    }

    const report = BenchReport.parse({
      run_id: result.runId,
      suite: result.manifest.suite,
      candidate: result.manifest.executor_candidate,
      baseline: result.manifest.executor_baseline,
      rows: result.rows,
      verdict: result.verdict,
      manifest_hash: result.manifestHash,
      schema_version: 1,
    });
    if (named.json === true) {
      emitJson(report);
      return;
    }
    // UX §7: symbols accompany color — ✓/✗ never bare color.
    const mark = (fpar: number): string => (fpar === 1 ? "✓ pass" : "✗ fail");
    const musd = (v: number): string => `${Math.round(v)} µ$`;
    const matrix = table(
      [
        { header: "task" },
        { header: report.candidate },
        { header: "cost", align: "right" },
        { header: report.baseline },
        { header: "cost", align: "right" },
      ],
      report.rows.map((r) => [
        r.task_id,
        mark(r.candidate_fpar),
        musd(r.candidate_cost_micro_usd),
        mark(r.baseline_fpar),
        musd(r.baseline_cost_micro_usd),
      ]),
    );
    const excluded = result.excludedTaskIds.length
      ? `\nexcluded (quarantined): ${result.excludedTaskIds.join(", ")}`
      : "";
    write(
      panel(
        `bench ${report.candidate} vs ${report.baseline} — ${report.suite}`,
        `${matrix}\n\n${renderVerdict(report.verdict, result.minSample)}${excluded}\nmanifest: ${report.manifest_hash.slice(0, 19)}…`,
      ),
    );
  } finally {
    db.close();
  }
};
