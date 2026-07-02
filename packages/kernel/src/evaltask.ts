import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkTask, CheckResult, Executor } from "@kelson/schemas";
import { compileSpec } from "./kelspec.ts";
import type { Workspace } from "./sandbox.ts";

export interface SessionOutcome {
  ok: boolean;
  cost_micro_usd: number;
  detail: string | null;
  raw_ref: string | null;
}

export interface ExecContext {
  task: BenchmarkTask;
  workspace: Workspace;
  timeoutMs: number;
  // Pack toggles for this side, materialized before the session runs.
  sideEnv: Record<string, string>;
}

export type ExecutorFn = (ctx: ExecContext) => SessionOutcome;

// EVP-7 (divergence-pinned): cost file must be a bare non-negative integer;
// malformed content records 0 with a warning detail, absence records 0
// silently (the sanctioned no-cost case).
const readCostFile = (
  path: string,
): { cost: number; warning: string | null } => {
  if (!existsSync(path)) return { cost: 0, warning: null };
  const raw = readFileSync(path, "utf8").trim();
  if (/^\d+$/.test(raw)) return { cost: Number(raw), warning: null };
  return {
    cost: 0,
    warning: `KELSON_COST_FILE unparseable as non-negative integer micro-USD (${JSON.stringify(raw)}); recording cost 0`,
  };
};

export const commandExecutor: ExecutorFn = (ctx) => {
  if (ctx.task.session_command === null)
    throw new Error(
      `executor "command" requires session_command; missing in task ${ctx.task.id}`,
    );
  const costFileHost = join(ctx.workspace.dir, ".kelson-cost");
  // Inside a container the workspace mounts at /workspace, so the env var
  // must name the sandbox-side path; the runner reads the host side.
  const costFileEnv =
    ctx.workspace.profile.isolation === "container"
      ? "/workspace/.kelson-cost"
      : costFileHost;
  const res = ctx.workspace.exec(ctx.task.session_command, {
    timeoutMs: ctx.timeoutMs,
    env: { KELSON_COST_FILE: costFileEnv, ...ctx.sideEnv },
  });
  const { cost, warning } = readCostFile(costFileHost);
  const detail =
    [
      res.timedOut ? "session timed out" : null,
      res.exitCode !== 0 && !res.timedOut
        ? `session_command exited ${res.exitCode}`
        : null,
      warning,
    ]
      .filter(Boolean)
      .join("; ") || null;
  return {
    ok: res.exitCode === 0 && !res.timedOut,
    cost_micro_usd: cost,
    detail,
    raw_ref: null,
  };
};

// Headless Claude Code session. Auth/config pass through explicitly — the
// worktree profile's temp HOME hides ~/.claude, so the operator's config dir
// is forwarded (worktree is a convenience tier, not a security boundary,
// SEC-1); the container profile never gets it.
// SEC-1's stated exception: the claude session process alone receives exactly
// this auth set — claude credentials are keyed to the operator account
// (keychain + ~/.claude.json). Checks and command sessions keep the temp HOME.
export const CLAUDE_AUTH_PASSTHROUGH = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HOME",
  "USER",
] as const;

export const claudeSessionEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of CLAUDE_AUTH_PASSTHROUGH)
    if (process.env[key]) env[key] = process.env[key] as string;
  return env;
};

export const claudeExecutor: ExecutorFn = (ctx) => {
  if (ctx.workspace.profile.isolation === "container")
    throw new Error(
      "claude executor under the container profile is not implemented yet — container runs use the command executor",
    );
  const passthrough = claudeSessionEnv();
  const res = ctx.workspace.exec(
    // Disposable detached workspace + temp HOME: skipping permission prompts
    // is the sandbox's point — a headless session cannot answer them. The
    // statement travels as an env var so the shell never parses its content.
    'claude -p "$KELSON_STATEMENT" --output-format json --dangerously-skip-permissions',
    {
      timeoutMs: ctx.timeoutMs,
      env: {
        ...passthrough,
        ...ctx.sideEnv,
        KELSON_STATEMENT: ctx.task.statement,
      },
    },
  );
  let cost = 0;
  let raw: string | null = null;
  let parsed = false;
  try {
    const out = JSON.parse(res.stdout) as {
      total_cost_usd?: number;
      result?: string;
    };
    cost = Math.round((out.total_cost_usd ?? 0) * 1_000_000);
    raw = res.stdout;
    parsed = true;
  } catch {
    // EVP §2.1: a zero-exit session with unparseable output is a session
    // failure, never a silent zero-cost pass.
  }
  return {
    ok: res.exitCode === 0 && !res.timedOut && parsed,
    cost_micro_usd: cost,
    detail: res.timedOut
      ? "session timed out"
      : res.exitCode !== 0
        ? `claude exited ${res.exitCode}: ${res.stderr.slice(0, 400)}`
        : parsed
          ? null
          : `claude exited 0 but produced no parseable result JSON: ${res.stdout.slice(0, 200)}`,
    raw_ref: raw,
  };
};

export const EXECUTORS: Record<Executor, ExecutorFn> = {
  command: commandExecutor,
  claude: claudeExecutor,
};

const runCheck = (
  check: BenchmarkTask["checks"][number],
  workspace: Workspace,
): CheckResult => {
  switch (check.kind) {
    case "obligations": {
      // EVP §1: every kelspec in the workspace compiles (SPEC-1); property
      // execution against the impl needs Phase 3 harness wiring.
      const dir = join(workspace.dir, "docs", "kelspec");
      if (!existsSync(dir))
        return {
          kind: "obligations",
          passed: true,
          detail: "no kelspec files",
        };
      const failures: string[] = [];
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".spec.md"))) {
        const res = compileSpec(readFileSync(join(dir, f), "utf8"), {
          file: join("docs", "kelspec", f),
          rootDir: workspace.dir,
        });
        if (!res.ok)
          failures.push(`${f}: ${res.errors.map((e) => e.message).join("; ")}`);
      }
      return {
        kind: "obligations",
        passed: failures.length === 0,
        detail: failures.join(" | ") || null,
      };
    }
    case "command": {
      const res = workspace.exec(check.run, { timeoutMs: 300_000 });
      return {
        kind: "command",
        passed: res.exitCode === 0,
        detail:
          res.exitCode === 0
            ? null
            : `exit ${res.exitCode}: ${(res.stderr || res.stdout).slice(0, 400)}`,
      };
    }
    case "artifact_exists": {
      const ok = existsSync(join(workspace.dir, check.path));
      return {
        kind: "artifact_exists",
        passed: ok,
        detail: ok ? null : `missing: ${check.path}`,
      };
    }
  }
};

export interface TaskRunOutcome {
  fpar_pass: boolean;
  cost_micro_usd: number;
  check_results: CheckResult[];
  raw_ref: string | null;
}

// EVP-1: fpar_pass = all checks passed within budget and timeout.
export const runTask = (
  task: BenchmarkTask,
  workspace: Workspace,
  executor: ExecutorFn,
  sideEnv: Record<string, string>,
): TaskRunOutcome => {
  const timeoutMs = task.timeout_minutes * 60_000;
  const session = executor({ task, workspace, timeoutMs, sideEnv });
  const checks: CheckResult[] = [];
  if (!session.ok)
    checks.push({
      kind: "command",
      passed: false,
      detail: `session failed: ${session.detail ?? "unknown"}`,
    });
  else for (const check of task.checks) checks.push(runCheck(check, workspace));
  if (session.cost_micro_usd > task.budget_ceiling_musd)
    checks.push({
      kind: "command",
      passed: false,
      detail: `budget breach: ${session.cost_micro_usd} > ceiling ${task.budget_ceiling_musd} micro-USD`,
    });
  return {
    fpar_pass: checks.every((c) => c.passed),
    cost_micro_usd: session.cost_micro_usd,
    check_results: checks,
    raw_ref: session.raw_ref,
  };
};
