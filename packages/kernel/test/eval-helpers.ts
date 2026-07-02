import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BenchmarkTask, Lockfile, SandboxProfile } from "@kelson/schemas";
import { storeSnapshot } from "../src/snapshots.ts";
import { ulid } from "../src/ulid.ts";

export const tmpDir = (): string => mkdtempSync(join(tmpdir(), "kelson-test-"));

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@kelson.test",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@kelson.test",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  HOME: tmpdir(),
  PATH: process.env.PATH ?? "",
};

export const makeRepo = (files: Record<string, string>): string => {
  const dir = tmpDir();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const git = (args: string[]) => {
    const res = spawnSync("git", args, {
      cwd: dir,
      env: GIT_ENV,
      stdio: "pipe",
    });
    if (res.status !== 0)
      throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  };
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
  return dir;
};

export const makeSnapshot = (
  files: Record<string, string>,
  storeDir: string,
): string => storeSnapshot(makeRepo(files), storeDir);

export type TaskOverrides = Partial<BenchmarkTask> & {
  id: string;
  snapshot: string;
};

export const baseTask = (over: TaskOverrides): BenchmarkTask => ({
  schema_version: 1,
  statement: "fixture task",
  checks: [{ kind: "command", run: "true" }],
  budget_ceiling_musd: 10_000_000,
  timeout_minutes: 5,
  declared_nondeterminism: [],
  session_command: "true",
  ...over,
});

// task.yaml/suite.yaml written as JSON — a strict YAML subset Bun.YAML reads.
export const makeSuite = (
  tasks: BenchmarkTask[],
  meta: { id?: string; version?: string } = {},
): string => {
  const dir = tmpDir();
  writeFileSync(
    join(dir, "suite.yaml"),
    JSON.stringify({
      id: meta.id ?? "fixture-suite",
      version: meta.version ?? "1",
      role: "staging",
    }),
  );
  for (const t of tasks) {
    mkdirSync(join(dir, t.id));
    writeFileSync(join(dir, t.id, "task.yaml"), JSON.stringify(t));
  }
  return dir;
};

export const lockWith = (
  packs: { name: string; enabled: boolean }[],
): Lockfile => ({
  schema_version: 1,
  parent_hash: null,
  entries: packs.map((p) => ({
    name: p.name,
    version: "1.0.0",
    hash: `sha256:${"0".repeat(64)}`,
    enabled: p.enabled,
  })),
});

export const WORKTREE: SandboxProfile = {
  isolation: "worktree",
  network: { policy: "inherit" },
};

// Fast gate settings for fixtures — the statistical obligations (EVAL-2)
// exercise the real defaults directly on gate().
export const FAST_GATE = { resamples: 300, minSample: 2 };

// Session commands with deterministic, injectable effects:
export const CMD = {
  // pack effect on cost: enabled "effectpack" halves spend
  costEffect:
    'case ",$KELSON_ENABLED_PACKS," in *,effectpack,*) printf 100 > "$KELSON_COST_FILE";; *) printf 200 > "$KELSON_COST_FILE";; esac',
  // pack effect on fpar: task only succeeds with the pack enabled
  fparEffect:
    'case ",$KELSON_ENABLED_PACKS," in *,effectpack,*) exit 0;; *) exit 1;; esac',
  // deterministic 50% pass keyed on the derived task seed (EVP-5 fixture)
  seededFlaky: "[ $((KELSON_SEED % 2)) -eq 0 ]",
  cost: (musd: string) => `printf '${musd}' > "$KELSON_COST_FILE"`,
} as const;

// Ledger generation requires a completed claude-executor run (EVP-7); the
// run/verdict rows are seeded directly — executing a real claude session is
// the exit-criterion demo's job, not a unit obligation's.
export const seedClaudeRun = (db: Database): string => {
  const runId = ulid();
  db.query(
    `INSERT INTO eval_run (id, kind, suite_id, suite_version, config_a, config_b, seed, executor, model_versions, sandbox_profile, manifest_hash, started_at, finished_at)
     VALUES (?, 'ablate', 'seed', '1', ?, ?, 0, 'claude', '{}', '{}', ?, ?, ?)`,
  ).run(
    runId,
    `sha256:${"a".repeat(64)}`,
    `sha256:${"b".repeat(64)}`,
    `sha256:${"c".repeat(64)}`,
    "2026-07-02T00:00:00Z",
    "2026-07-02T01:00:00Z",
  );
  db.query(
    "INSERT INTO verdict (id, run_id, decision, deltas, n, alpha) VALUES (?, ?, 'helps', ?, 24, 0.05)",
  ).run(
    ulid(),
    runId,
    JSON.stringify({
      fpar: { mean: 0.07, ci95: [0.02, 0.12] },
      cost_pct: { mean: -11, ci95: [-17, -5] },
    }),
  );
  return runId;
};
