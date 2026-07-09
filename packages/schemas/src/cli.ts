import { z } from "zod";
import { Authority, DriftDirection } from "./artifacts.ts";
import {
  Delta,
  EvalRunKind,
  Executor,
  Verdict,
  VerdictDecision,
} from "./eval.ts";
import { ReplayRecord } from "./loop.ts";
import { AgentRegistryEntry } from "./routing.ts";
import { IsoUtc, SchemaVersion, Ulid } from "./scalars.ts";

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

// UX-19: one probed component of `kelson doctor`.
export const DoctorComponent = z.object({
  name: z.enum(["store", "lockfile", "auth", "telemetry"]),
  status: z.enum(["pass", "warn", "fail"]),
  detail: z.string().min(1),
  // UX-P5: a failing component names the one command/action that fixes it.
  fix: z.string().min(1).nullable(),
});
export type DoctorComponent = z.infer<typeof DoctorComponent>;

// UX-1/UX-19: machine output for `kelson doctor`.
export const DoctorReport = z.object({
  ok: z.boolean(),
  components: z.array(DoctorComponent),
  schema_version: SchemaVersion,
});
export type DoctorReport = z.infer<typeof DoctorReport>;

// UX-20: divergence_report rows as the CLI renders them. Outcomes mirror the
// kernel's divergence Outcome union (values are arbitrary JSON).
export const DivergenceOutcome = z.union([
  z.object({ tag: z.literal("returned"), value: z.unknown() }),
  z.object({ tag: z.literal("threw"), errorName: z.string().min(1) }),
]);
export type DivergenceOutcome = z.infer<typeof DivergenceOutcome>;

export const DivergenceEntryView = z.object({
  clause_id: z.string().min(1),
  probe_input: z.record(z.string(), z.unknown()),
  differing_path: z.string(),
  outcome_a: DivergenceOutcome,
  outcome_b: DivergenceOutcome,
  redacted_paths: z.array(z.string()),
});
export type DivergenceEntryView = z.infer<typeof DivergenceEntryView>;

export const DivergenceReportRow = z.object({
  id: z.string().min(1),
  spec_hash: z.string().min(1),
  clause_ids: z.array(z.string().min(1)),
  entries: z.array(DivergenceEntryView),
  resolved: z.boolean(),
  at: IsoUtc,
});
export type DivergenceReportRow = z.infer<typeof DivergenceReportRow>;

// UX-1/UX-20: machine output for `kelson divergence list|show` (show emits a
// single-report envelope of the same shape).
export const DivergenceListResult = z.object({
  reports: z.array(DivergenceReportRow),
  schema_version: SchemaVersion,
});
export type DivergenceListResult = z.infer<typeof DivergenceListResult>;

// UX-21: machine output for `kelson pack new`.
export const PackNewResult = z.object({
  dir: z.string().min(1),
  files: z.array(z.string().min(1)),
  schema_version: SchemaVersion,
});
export type PackNewResult = z.infer<typeof PackNewResult>;

// UX-22: machine output for `kelson drift list`.
export const DriftSurvivalRow = z.object({
  logical_id: z.string().min(1),
  sessions_survived: z.number().int().nonnegative(),
});
export type DriftSurvivalRow = z.infer<typeof DriftSurvivalRow>;

export const DriftItemRow = z.object({
  artifact_id: z.string().min(1),
  module: z.string().min(1),
  direction: DriftDirection,
  authority: Authority,
  detected_at: IsoUtc,
});
export type DriftItemRow = z.infer<typeof DriftItemRow>;

// Collapsed counts stay split by authority — collapsing must not erase the
// §5.4 blocking/informational signal (divergence pin, F-150).
export const DriftModuleCount = z.object({
  module: z.string().min(1),
  blocking: z.number().int().nonnegative(),
  informational: z.number().int().nonnegative(),
});
export type DriftModuleCount = z.infer<typeof DriftModuleCount>;

export const DriftListResult = z.object({
  survival: z.array(DriftSurvivalRow),
  collapsed: z.boolean(),
  // empty when collapsed (fatigue budget: > 10 open items)
  items: z.array(DriftItemRow),
  modules: z.array(DriftModuleCount),
  schema_version: SchemaVersion,
});
export type DriftListResult = z.infer<typeof DriftListResult>;

// UX-23: machine output for `kelson eval report` — stored verdicts only.
export const EvalReportRow = z.object({
  run_id: Ulid,
  kind: EvalRunKind,
  suite_id: z.string().min(1),
  suite_version: z.string().min(1),
  finished_at: IsoUtc.nullable(),
  decision: VerdictDecision,
  fpar_delta: Delta,
  cost_delta_pct: Delta,
  n: z.number().int().nonnegative(),
  alpha: z.number().positive(),
});
export type EvalReportRow = z.infer<typeof EvalReportRow>;

export const EvalReportResult = z.object({
  runs: z.array(EvalReportRow),
  schema_version: SchemaVersion,
});
export type EvalReportResult = z.infer<typeof EvalReportResult>;

// UX-23: machine output for `kelson eval replay` — the recorded link.
export const ReplayResult = z.object({
  record: ReplayRecord,
  schema_version: SchemaVersion,
});
export type ReplayResult = z.infer<typeof ReplayResult>;

// UX-24: machine output for `kelson agents list`.
export const AgentsListResult = z.object({
  registry_dir: z.string().min(1),
  agents: z.array(AgentRegistryEntry),
  schema_version: SchemaVersion,
});
export type AgentsListResult = z.infer<typeof AgentsListResult>;

// UX-26: machine output for `kelson index rebuild` (count semantics
// divergence-pinned 2026-07-06, F-151).
export const IndexRebuildResult = z.object({
  ingested: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  discrepancies: z.number().int().nonnegative(),
  schema_version: SchemaVersion,
});
export type IndexRebuildResult = z.infer<typeof IndexRebuildResult>;

// UX-27: one table's row count as `kelson db stats|backup` reports it.
export const DbTableCount = z.object({
  name: z.string().min(1),
  rows: z.number().int().nonnegative(),
});
export type DbTableCount = z.infer<typeof DbTableCount>;

// UX-1/UX-27: machine output for `kelson db stats`.
export const DbStatsResult = z.object({
  path: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  tables: z.array(DbTableCount),
  schema_version: SchemaVersion,
});
export type DbStatsResult = z.infer<typeof DbStatsResult>;

// UX-1/UX-27: machine output for `kelson db backup <dest>`.
export const DbBackupResult = z.object({
  source: z.string().min(1),
  dest: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  tables: z.array(DbTableCount),
  schema_version: SchemaVersion,
});
export type DbBackupResult = z.infer<typeof DbBackupResult>;
