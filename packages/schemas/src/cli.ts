import { z } from "zod";
import { Executor, Verdict } from "./eval.ts";
import { SchemaVersion } from "./scalars.ts";

// UX-1: machine output for `kelson init`.
export const InitResult = z.object({
  store_path: z.string().min(1),
  lockfile: z.enum(["created", "existing"]),
  hooked: z.array(z.string().min(1)),
  schema_version: SchemaVersion,
});
export type InitResult = z.infer<typeof InitResult>;

// UX-1: machine output for `kelson pack lint` (PACK-3).
export const PackLintResult = z.object({
  ok: z.boolean(),
  required_bump: z.enum(["major", "minor", "patch", "none"]),
  prev_version: z.string().min(1),
  next_version: z.string().min(1),
  schema_version: SchemaVersion,
});
export type PackLintResult = z.infer<typeof PackLintResult>;

// UX-18: one per-task row of the bench matrix (EVP-11 pairing inputs).
export const BenchTaskRow = z.object({
  task_id: z.string().min(1),
  // task-level majority FPAR per agent (strict majority over repeats)
  candidate_fpar: z.number().int().min(0).max(1),
  baseline_fpar: z.number().int().min(0).max(1),
  // mean micro-USD over repeats — a mean of integers may be fractional
  candidate_cost_micro_usd: z.number().nonnegative(),
  baseline_cost_micro_usd: z.number().nonnegative(),
});
export type BenchTaskRow = z.infer<typeof BenchTaskRow>;

// UX-1/UX-18: machine output for `kelson bench`.
export const BenchReport = z.object({
  run_id: z.string().min(1),
  suite: z.string().min(1),
  candidate: Executor,
  baseline: Executor,
  rows: z.array(BenchTaskRow),
  verdict: Verdict,
  manifest_hash: z.string().min(1),
  schema_version: SchemaVersion,
});
export type BenchReport = z.infer<typeof BenchReport>;
