import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceLink, Proposal, ProposalDiff } from "@kelson/schemas";
import { type ApplyContext, createProposal, transition } from "../src/loop.ts";
import { ulid } from "../src/ulid.ts";
import { seedClaudeRun, tmpDir } from "./eval-helpers.ts";

export interface LoopCtx extends ApplyContext {
  repoRoot: string;
}

export const loopCtx = (): LoopCtx => {
  const repoRoot = tmpDir();
  mkdirSync(join(repoRoot, ".kelson"), { recursive: true });
  const lockfilePath = join(repoRoot, "kelson.lock");
  writeFileSync(
    lockfilePath,
    `${JSON.stringify(
      {
        schema_version: 1,
        parent_hash: null,
        entries: [
          {
            name: "ponytail",
            version: "4.7.0",
            hash: `sha256:${"0".repeat(64)}`,
            enabled: true,
          },
          {
            name: "routing-default",
            version: "0.1.0",
            hash: `sha256:${"1".repeat(64)}`,
            enabled: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repoRoot, ".kelson", "findings.json"),
    JSON.stringify({ findings: [{ id: "F-001" }, { id: "F-042" }] }),
  );
  return {
    repoRoot,
    lockfilePath,
    changelogPath: join(repoRoot, ".kelson", "changelog.jsonl"),
  };
};

// A resolvable db evidence link backed by real verdict/run rows.
export const seedVerdictEvidence = (db: Database): EvidenceLink[] => {
  const runId = seedClaudeRun(db);
  const verdict = db
    .query("SELECT id FROM verdict WHERE run_id = ?")
    .get(runId) as { id: string };
  return [`ev:db/verdict/${verdict.id}`, `ev:db/eval_run/${runId}`];
};

export const DISABLE_PONYTAIL: ProposalDiff = {
  kind: "lockfile",
  ops: [{ op: "disable", pack: "ponytail" }],
};

export const draftProposal = (
  db: Database,
  ctx: LoopCtx,
  over: Partial<Parameters<typeof createProposal>[1]> = {},
) =>
  createProposal(db, {
    targetPack: "ponytail",
    diff: DISABLE_PONYTAIL,
    evidence: seedVerdictEvidence(db),
    rationale: "fixture rationale",
    createdBy: "loop",
    repoRoot: ctx.repoRoot,
    ...over,
    rejectionsSeenThrough: over.rejectionsSeenThrough ?? null,
  });

// Drives a fresh proposal to rejected (or quarantined via the full legal
// path) so LOOP-11 history fixtures have real state-machine residents. The
// approved step's override reason is deliberately different from `reason` —
// a history basis equal to `reason` proves the entering transition's reason
// won, not an earlier one (COALESCE semantics).
export const seedRejected = (
  db: Database,
  ctx: LoopCtx,
  args: {
    rationale: string;
    reason: string;
    quarantine?: boolean;
    diff?: ProposalDiff;
  },
): Proposal => {
  const p = draftProposal(db, ctx, {
    rationale: args.rationale,
    ...(args.diff ? { diff: args.diff } : {}),
  });
  transition(db, p.id, "gated", { actor: "auto" });
  if (!args.quarantine)
    return transition(db, p.id, "rejected", {
      actor: "human",
      reason: args.reason,
    });
  transition(db, p.id, "approved", {
    actor: "human",
    reason: "fixture override — must not surface as basis",
  });
  transition(db, p.id, "applied", { actor: "auto" });
  transition(db, p.id, "monitoring", { actor: "auto" });
  transition(db, p.id, "reverted", { actor: "auto", reason: args.reason });
  return transition(db, p.id, "quarantined", {
    actor: "auto",
    reason: args.reason,
  });
};

let sessionCounter = 0;
export const seedSession = (
  db: Database,
  args: { lockfileHash: string; startedAt: string; status?: string },
): string => {
  const id = ulid();
  sessionCounter++;
  db.query(
    `INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, trace_id, started_at, ended_at)
     VALUES (?, 'r', ?, '0.1.0', 1, ?, NULL, ?, ?)`,
  ).run(
    id,
    args.lockfileHash,
    args.status ?? "complete",
    args.startedAt,
    args.startedAt,
  );
  return id;
};
