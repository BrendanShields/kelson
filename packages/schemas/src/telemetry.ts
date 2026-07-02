import { z } from "zod";
import { IsoUtc, MicroUsd, SchemaVersion, Sha256, Ulid } from "./scalars.ts";

export const SessionStatus = z.enum(["complete", "incomplete", "degraded"]);
export const SdlcStep = z.enum([
  "feedback",
  "ideation",
  "planning",
  "spec",
  "build",
  "verify",
]);
export const Effort = z.enum(["low", "medium", "high"]);
export const TaskState = z.enum([
  "open",
  "in_progress",
  "delivered",
  "accepted",
  "corrected",
  "abandoned",
]);
export const AcceptanceSignal = z.enum(["approval", "merge_clean"]);
export const InterventionClass = z.enum([
  "correction",
  "clarification",
  "approval",
]);
export const BudgetOverrun = z.enum(["none", "soft", "paused"]);

export const Session = z.object({
  id: Ulid,
  repo: z.string().min(1),
  lockfile_hash: Sha256,
  harness_version: z.string().min(1),
  schema_version: SchemaVersion,
  status: SessionStatus,
  trace_id: z.string().nullable(),
  started_at: IsoUtc,
  ended_at: IsoUtc.nullable(),
});

export const Task = z.object({
  id: Ulid,
  repo: z.string().min(1),
  spec_clause_refs: z.array(z.string()),
  state: TaskState,
  acceptance_signal: AcceptanceSignal.nullable(),
  correction_count: z.number().int().nonnegative(),
  opened_at: IsoUtc,
  delivered_at: IsoUtc.nullable(),
  closed_at: IsoUtc.nullable(),
});

export const StepEvent = z.object({
  id: Ulid,
  task_id: Ulid,
  session_id: Ulid,
  sdlc_step: SdlcStep,
  model: z.string().min(1),
  effort: Effort,
  agent_id: z.string().min(1),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  tokens_cache_read: z.number().int().nonnegative(),
  tokens_cache_write: z.number().int().nonnegative(),
  // Keys are identifier tokens (ERD: price classes / model ids). Zod v4
  // additionally strips "__proto__" from records before key validation, so
  // proto-polluting keys can never reach storage — stripped, not rejected.
  unit_prices: z.record(
    z.string().regex(/^[a-z][a-z0-9_.:-]*$/),
    z.number().nonnegative(),
  ),
  cost_micro_usd: MicroUsd,
  budget_tokens: z.number().int().positive(),
  overrun: BudgetOverrun,
  span_id: z.string().nullable(),
  schema_version: SchemaVersion,
});

export const InterventionEvent = z.object({
  id: Ulid,
  task_id: Ulid,
  session_id: Ulid,
  class: InterventionClass,
  artifact_hash: Sha256.nullable(),
  at: IsoUtc,
  schema_version: SchemaVersion,
});

export type Session = z.infer<typeof Session>;
export type Task = z.infer<typeof Task>;
export type StepEvent = z.infer<typeof StepEvent>;
export type InterventionEvent = z.infer<typeof InterventionEvent>;
