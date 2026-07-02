import { z } from "zod";
import { IsoUtc, KebabName, SchemaVersion, Sha256, Ulid } from "./scalars.ts";

// LOOP-8: exactly two link grammars; a link that misstates its location is a
// wrong claim, so the table/file is part of the grammar.
export const EVIDENCE_TABLES = [
  "step_event",
  "routing_decision",
  "budget_event",
  "drift_event",
  "eval_task_result",
  "verdict",
  "eval_run",
  "bundle_event",
] as const;

export const EVIDENCE_FILES = [".kelson/findings.json"] as const;

const dbLink = new RegExp(
  `^ev:db/(${EVIDENCE_TABLES.join("|")})/[0-9A-HJKMNP-TV-Z]{26}$`,
);
const fileLink = new RegExp(
  `^ev:file/(${EVIDENCE_FILES.map((f) => f.replaceAll(".", "\\.")).join("|")})#F-\\d{3,}$`,
);

export const EvidenceLink = z
  .string()
  .refine((s) => dbLink.test(s) || fileLink.test(s), {
    message:
      "evidence link must be ev:db/<table>/<ulid> or ev:file/<allowlisted-path>#F-<n>",
  });

export const ProposalState = z.enum([
  "proposed",
  "gated",
  "approved",
  "rejected",
  "applied",
  "monitoring",
  "stable",
  "reverted",
  "quarantined",
]);

// v1 diffs are lockfile-level operations; the inverse is mechanical (LOOP-2).
export const LockfileOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("enable"), pack: KebabName }),
  z.strictObject({ op: z.literal("disable"), pack: KebabName }),
]);

export const ProposalDiff = z.strictObject({
  kind: z.literal("lockfile"),
  ops: z.array(LockfileOp).min(1),
});

export const Proposal = z.strictObject({
  id: Ulid,
  target_pack: KebabName,
  diff: ProposalDiff,
  diff_hash: Sha256,
  evidence: z.array(EvidenceLink).min(1),
  rationale: z.string().min(1),
  created_by: z.enum(["loop", "human"]),
  state: ProposalState,
  quarantine_reason: z.string().nullable(),
  created_at: IsoUtc,
  updated_at: IsoUtc,
  schema_version: SchemaVersion,
});

// PACK-5 (.kelson/changelog.jsonl): seq must equal last+1, append-only.
export const ChangelogEntry = z.strictObject({
  seq: z.number().int().positive(),
  at: IsoUtc,
  action: z.enum(["apply", "revert", "human_change"]),
  proposal_id: Ulid.nullable(),
  lockfile_before: Sha256,
  lockfile_after: Sha256,
  evidence_summary: z.string().min(1),
});

// EVP §4: a replay may gate only when all three validity rules hold.
export const ReplayValidity = z.enum(["valid", "advisory"]);
export const AdvisoryReason = z.enum([
  "snapshot_hash_mismatch",
  "model_mismatch",
  "source_session_not_complete",
]);

export const ReplayRecord = z.strictObject({
  id: Ulid,
  source_session_id: z.string().min(1),
  snapshot_ref: Sha256,
  config: Sha256,
  run_id: Ulid.nullable(),
  outcome: z.strictObject({
    fpar_pass: z.boolean(),
    cost_micro_usd: z.number().int().nonnegative(),
    original_fpar_pass: z.boolean(),
    original_cost_micro_usd: z.number().int().nonnegative(),
  }),
  validity: ReplayValidity,
  advisory_reason: AdvisoryReason.nullable(),
  at: IsoUtc,
  schema_version: SchemaVersion,
});

// LOOP-9: baseline frozen at apply; conjunctive window closure.
export const MonitorStatus = z.enum([
  "open",
  "cleared",
  "reverted",
  "abandoned",
]);

export const MonitorRecord = z.strictObject({
  proposal_id: Ulid,
  applied_at: IsoUtc,
  lockfile_after: Sha256,
  baseline_session_ids: z.array(z.string()),
  baseline_insufficient: z.boolean(),
  status: MonitorStatus,
  check_seq: z.number().int().nonnegative(),
  stalled_notified: z.boolean(),
  closed_at: IsoUtc.nullable(),
  schema_version: SchemaVersion,
});

export const LoopEvent = z.strictObject({
  id: Ulid,
  proposal_id: Ulid.nullable(),
  kind: z.enum([
    "proposal_created",
    "evidence_check",
    "acl_rejected",
    "state_transition",
    "monitor_opened",
    "monitor_check",
    "monitor_check_skipped",
    "regression_detected",
    "monitor_stalled",
    "monitor_closed",
    "quarantine_release",
  ]),
  payload: z.record(z.string(), z.unknown()),
  at: IsoUtc,
  schema_version: SchemaVersion,
});

export type EvidenceLink = z.infer<typeof EvidenceLink>;
export type ProposalState = z.infer<typeof ProposalState>;
export type LockfileOp = z.infer<typeof LockfileOp>;
export type ProposalDiff = z.infer<typeof ProposalDiff>;
export type Proposal = z.infer<typeof Proposal>;
export type ChangelogEntry = z.infer<typeof ChangelogEntry>;
export type ReplayValidity = z.infer<typeof ReplayValidity>;
export type AdvisoryReason = z.infer<typeof AdvisoryReason>;
export type ReplayRecord = z.infer<typeof ReplayRecord>;
export type MonitorStatus = z.infer<typeof MonitorStatus>;
export type MonitorRecord = z.infer<typeof MonitorRecord>;
export type LoopEvent = z.infer<typeof LoopEvent>;
