import { z } from "zod";
import {
  IsoUtc,
  KebabName,
  MicroUsd,
  SchemaVersion,
  Semver,
  Sha256,
  Ulid,
} from "./scalars.ts";

export const Executor = z.enum(["claude", "command"]);
export const RunKind = z.enum(["ablate", "compare"]);
export const Side = z.enum(["A", "B"]);
export const VerdictDecision = z.enum([
  "helps",
  "hurts",
  "no_effect",
  "underpowered",
]);
export const SuiteRole = z.enum(["gating", "staging"]);

export const TaskCheck = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("obligations") }),
  z.strictObject({ kind: z.literal("command"), run: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("artifact_exists"),
    path: z.string().min(1),
  }),
]);

// EVP §1 task.yaml
export const BenchmarkTask = z.strictObject({
  schema_version: SchemaVersion,
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  statement: z.string().min(1),
  snapshot: Sha256,
  checks: z.array(TaskCheck).min(1),
  budget_ceiling_musd: MicroUsd,
  timeout_minutes: z.number().positive(),
  declared_nondeterminism: z.array(z.string()).default([]),
  session_command: z.string().min(1).nullable().default(null),
});

// SEC-3: isolation level + network policy, recorded on every run manifest.
export const SandboxProfile = z.strictObject({
  isolation: z.enum(["worktree", "container"]),
  network: z.discriminatedUnion("policy", [
    z.strictObject({ policy: z.literal("inherit") }),
    z.strictObject({
      policy: z.literal("deny"),
      allowlist: z.array(z.string().min(1)).default([]),
    }),
  ]),
});

// EVAL-4 + SEC-3 + EVP-7: everything needed to reproduce the comparison.
// Deliberately excludes the run id — the manifest hash identifies the
// comparison's configuration, so identical re-runs share it.
export const RunManifest = z.strictObject({
  schema_version: SchemaVersion,
  kind: RunKind,
  suite: z.string().min(1),
  suite_version: z.string().min(1),
  config_a: Sha256,
  config_b: Sha256,
  seed: z.number().int().nonnegative(),
  repeats: z.number().int().positive(),
  executor: Executor,
  sandbox_profile: SandboxProfile,
  model_versions: z.record(
    z.string().regex(/^[a-z][a-z0-9_.:-]*$/),
    z.string().min(1),
  ),
  tasks: z.array(z.strictObject({ id: z.string().min(1), snapshot: Sha256 })),
});

export const CheckResult = z.strictObject({
  kind: z.enum(["obligations", "command", "artifact_exists"]),
  passed: z.boolean(),
  detail: z.string().nullable(),
});

export const EvalTaskResult = z.strictObject({
  id: Ulid,
  run_id: Ulid,
  bench_task_id: z.string().min(1),
  side: Side,
  repeat_index: z.number().int().nonnegative(),
  fpar_pass: z.boolean(),
  cost_micro_usd: MicroUsd,
  check_results: z.array(CheckResult),
  raw_ref: z.string().nullable(),
  schema_version: SchemaVersion,
});

export const Delta = z.strictObject({
  mean: z.number(),
  ci95: z.tuple([z.number(), z.number()]),
});

// EVT-1: never a bare pass/fail — effect sizes and CIs always present.
export const Verdict = z.strictObject({
  id: Ulid,
  run_id: Ulid,
  decision: VerdictDecision,
  fpar_delta: Delta,
  cost_delta_pct: Delta,
  n: z.number().int().nonnegative(),
  alpha: z.number().positive().lt(1),
  bootstrap_resamples: z.number().int().positive(),
  quarantined_tasks: z.array(z.string()).default([]),
});

// EVP §7 ledger entry
export const LedgerEntry = z.strictObject({
  schema_version: SchemaVersion,
  pack: KebabName,
  version: Semver,
  run_manifest_hash: Sha256,
  suite: z.string().min(1),
  verdict: VerdictDecision,
  fpar_delta: Delta,
  cost_delta_pct: Delta,
  n: z.number().int().nonnegative(),
  date: IsoUtc,
});

export const EvalSuite = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  role: SuiteRole,
  // EVAL-2: the gate runs "at no less than the suite's configured minimum
  // sample size" — this is that configuration; absent → the EVP §5 default.
  min_sample: z.number().int().min(6).optional(),
});

export type Executor = z.infer<typeof Executor>;
export type RunKind = z.infer<typeof RunKind>;
export type Side = z.infer<typeof Side>;
export type VerdictDecision = z.infer<typeof VerdictDecision>;
export type SuiteRole = z.infer<typeof SuiteRole>;
export type TaskCheck = z.infer<typeof TaskCheck>;
export type BenchmarkTask = z.infer<typeof BenchmarkTask>;
export type SandboxProfile = z.infer<typeof SandboxProfile>;
export type RunManifest = z.infer<typeof RunManifest>;
export type CheckResult = z.infer<typeof CheckResult>;
export type EvalTaskResult = z.infer<typeof EvalTaskResult>;
export type Delta = z.infer<typeof Delta>;
export type Verdict = z.infer<typeof Verdict>;
export type LedgerEntry = z.infer<typeof LedgerEntry>;
export type EvalSuite = z.infer<typeof EvalSuite>;
