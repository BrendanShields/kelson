import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AdvisoryReason, ReplayRecord } from "@kelson/schemas";
import { hashContent } from "./artifacts.ts";
import { type PairedResult, replayVeto } from "./stats.ts";
import { ulid } from "./ulid.ts";

// EVP §4 rule 1: the bundle must restore bit-identically.
export const verifySnapshot = (hash: string, storeDir: string): boolean => {
  const path = join(storeDir, `${hash.replace("sha256:", "")}.bundle`);
  if (!existsSync(path)) return false;
  return hashContent(readFileSync(path)) === hash;
};

export interface ReplayValidityInput {
  snapshotHash: string;
  storeDir: string;
  originalStatus: "complete" | "incomplete" | "degraded";
  originalModels: string[];
  candidateModels: string[];
}

// EVP-3: the three validity rules; any failure → advisory, never gate math.
export const validateReplay = (
  input: ReplayValidityInput,
): { validity: "valid" | "advisory"; reason: AdvisoryReason | null } => {
  if (!verifySnapshot(input.snapshotHash, input.storeDir))
    return { validity: "advisory", reason: "snapshot_hash_mismatch" };
  if (input.originalStatus !== "complete")
    return { validity: "advisory", reason: "source_session_not_complete" };
  const same =
    input.originalModels.length === input.candidateModels.length &&
    input.originalModels.every((m) => input.candidateModels.includes(m));
  // Cross-model replays inform, never gate — advisory either way on mismatch.
  if (!same) return { validity: "advisory", reason: "model_mismatch" };
  return { validity: "valid", reason: null };
};

export const recordReplay = (
  db: Database,
  record: Omit<ReplayRecord, "id" | "at" | "schema_version">,
): ReplayRecord => {
  const full = ReplayRecord.parse({
    ...record,
    id: ulid(),
    at: new Date().toISOString(),
    schema_version: 1,
  });
  db.query(
    `INSERT INTO replay_record (id, source_session_id, snapshot_ref, config, run_id, outcome, validity, advisory_reason, at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    full.id,
    full.source_session_id,
    full.snapshot_ref,
    full.config,
    full.run_id,
    JSON.stringify(full.outcome),
    full.validity,
    full.advisory_reason,
    full.at,
    full.schema_version,
  );
  return full;
};

export interface ReplayAggregate {
  vetoed: boolean;
  decision: string;
  valid_n: number;
  advisory_n: number;
  session_ids: string[];
}

// EVAL-5 + EVP §5.1: replays pair each task against its own original
// outcome; advisory records are reported but excluded from gate math.
export const aggregateReplays = (
  db: Database,
  config: string,
): ReplayAggregate => {
  const rows = db
    .query("SELECT * FROM replay_record WHERE config = ? ORDER BY rowid")
    .all(config) as Record<string, unknown>[];
  const records = rows.map((r) =>
    ReplayRecord.parse({ ...r, outcome: JSON.parse(r.outcome as string) }),
  );
  const valid = records.filter((r) => r.validity === "valid");
  const pairs: PairedResult[] = valid.map((r) => ({
    task_id: r.source_session_id,
    fpar_a: r.outcome.fpar_pass ? 1 : 0,
    fpar_b: r.outcome.original_fpar_pass ? 1 : 0,
    cost_a: r.outcome.cost_micro_usd,
    cost_b: r.outcome.original_cost_micro_usd,
  }));
  const { vetoed, outcome } = replayVeto(pairs);
  return {
    vetoed,
    decision: outcome.decision,
    valid_n: valid.length,
    advisory_n: records.length - valid.length,
    session_ids: valid.map((r) => r.source_session_id),
  };
};
