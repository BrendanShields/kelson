import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  ChangelogEntry,
  EVIDENCE_FILES,
  EVIDENCE_TABLES,
  type EvidenceLink,
  type Lockfile,
  LoopEvent,
  Proposal,
  type ProposalDiff,
  type ProposalState,
} from "@kelson/schemas";
import { hashContent } from "./artifacts.ts";
import { canonicalJson, hashLockfile } from "./packs.ts";
import { aggregateReplays } from "./replay.ts";
import { gate } from "./stats.ts";
import { ulid } from "./ulid.ts";

// The single transition relation — the TLA+ model (specs/tla/KelsonLoop.tla)
// and the LOOP-5 conformance test both transcribe exactly this table.
export const TRANSITIONS: Record<ProposalState, ProposalState[]> = {
  proposed: ["gated"],
  gated: ["approved", "rejected"],
  approved: ["applied"],
  rejected: [],
  applied: ["monitoring"],
  monitoring: ["stable", "reverted"],
  stable: [],
  reverted: ["quarantined"],
  quarantined: ["proposed"],
};

// I2: bounded monitoring concurrency so regressions stay attributable.
export const MONITORING_CAP = 3;

// LOOP-4 / I4: the loop has no write path to these; enforced here at the
// kernel boundary (write ACL), never by prompt rules. Eval-suite protection
// is by role: any suite with role "gating" is protected.
export const PROTECTED_TARGETS = new Set([
  "kernel",
  "loop-spec",
  "eval-thresholds",
  "edit-budget",
]);

// LOOP-10: per-cycle textual learning rate. The default is SkillOpt's
// ablation-backed L=4 (arXiv:2605.23904); the floor is the hard schema floor.
// No persisted budget config exists yet — the "edit-budget" PROTECTED_TARGETS
// entry reserves the name; any future persisted budget surface must join
// PROTECTED_TARGETS and the LOOP-4/EVAL-6 obligation matrix.
export const EDIT_BUDGET_DEFAULT = 4;
export const EDIT_BUDGET_FLOOR = 1;
export const REJECTION_WINDOW = 20;

export const loopEvent = (
  db: Database,
  kind: LoopEvent["kind"],
  proposalId: string | null,
  payload: Record<string, unknown>,
): void => {
  const event = LoopEvent.parse({
    id: ulid(),
    proposal_id: proposalId,
    kind,
    payload,
    at: new Date().toISOString(),
    schema_version: 1,
  });
  db.query(
    "INSERT INTO loop_event (id, proposal_id, kind, payload, at, schema_version) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    event.id,
    event.proposal_id,
    event.kind,
    JSON.stringify(event.payload),
    event.at,
    event.schema_version,
  );
};

// LOOP-8: resolve against exactly the stated table/file; all-or-nothing.
export const resolveEvidence = (
  db: Database,
  links: EvidenceLink[],
  repoRoot: string,
): { ok: boolean; results: { link: string; resolved: boolean }[] } => {
  const results = links.map((link) => {
    if (link.startsWith("ev:db/")) {
      const [, table, id] = link.split("/");
      if (!EVIDENCE_TABLES.includes(table as (typeof EVIDENCE_TABLES)[number]))
        return { link, resolved: false };
      const row = db
        .query(`SELECT 1 FROM ${table} WHERE id = ?`)
        .get(id as string);
      return { link, resolved: row !== null };
    }
    const [path, recordId] = link.slice("ev:file/".length).split("#");
    if (!EVIDENCE_FILES.includes(path as (typeof EVIDENCE_FILES)[number]))
      return { link, resolved: false };
    try {
      const doc = JSON.parse(readFileSync(`${repoRoot}/${path}`, "utf8")) as {
        findings?: { id: string }[];
      };
      return {
        link,
        resolved: (doc.findings ?? []).some((f) => f.id === recordId),
      };
    } catch {
      return { link, resolved: false };
    }
  });
  return { ok: results.every((r) => r.resolved), results };
};

const readProposal = (db: Database, id: string): Proposal => {
  const row = db.query("SELECT * FROM proposal WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;
  if (!row) throw new Error(`unknown proposal: ${id}`);
  return Proposal.parse({
    ...row,
    diff: JSON.parse(row.diff as string),
    evidence: JSON.parse(row.evidence as string),
  });
};

export const getProposal = readProposal;

export const diffHash = (diff: ProposalDiff): string =>
  hashContent(canonicalJson(diff));

export interface CreateProposalArgs {
  targetPack: string;
  diff: ProposalDiff;
  evidence: EvidenceLink[];
  rationale: string;
  createdBy: "loop" | "human";
  repoRoot: string;
  gatingSuiteIds?: string[];
  // LOOP-11: the cycle's snapshot watermark — REQUIRED so the typechecker
  // enumerates every emitter; createProposal never derives it itself (a
  // per-insert query would let a mid-cycle rejection split one cycle's
  // watermarks, the exact drift the snapshot semantics forbid).
  rejectionsSeenThrough: string | null;
}

export const createProposal = (
  db: Database,
  args: CreateProposalArgs,
): Proposal => {
  // LOOP-4: audited structural rejection, not an exception path the caller
  // can forget — the event lands before the throw.
  const protectedTarget =
    PROTECTED_TARGETS.has(args.targetPack) ||
    (args.gatingSuiteIds ?? []).includes(args.targetPack);
  if (args.createdBy === "loop" && protectedTarget) {
    loopEvent(db, "acl_rejected", null, {
      target_pack: args.targetPack,
      reason: "protected surface (LOOP-4)",
    });
    throw new Error(
      `loop-originated proposal targeting protected surface "${args.targetPack}" rejected (LOOP-4)`,
    );
  }
  const hash = diffHash(args.diff);
  const quarantined = db
    .query(
      "SELECT id FROM proposal WHERE diff_hash = ? AND state = 'quarantined'",
    )
    .get(hash) as { id: string } | null;
  if (quarantined)
    throw new Error(
      `diff content-hash matches quarantined proposal ${quarantined.id} — release it first (LOOP-9)`,
    );
  const check = resolveEvidence(db, args.evidence, args.repoRoot);
  if (!check.ok) {
    loopEvent(db, "evidence_check", null, { outcome: "rejected", ...check });
    throw new Error(
      `unresolvable evidence links: ${check.results
        .filter((r) => !r.resolved)
        .map((r) => r.link)
        .join(", ")} (LOOP-1/LOOP-8)`,
    );
  }
  const now = new Date().toISOString();
  const proposal = Proposal.parse({
    id: ulid(),
    target_pack: args.targetPack,
    diff: args.diff,
    diff_hash: hash,
    evidence: args.evidence,
    rationale: args.rationale,
    created_by: args.createdBy,
    state: "proposed",
    quarantine_reason: null,
    rejections_seen_through: args.rejectionsSeenThrough,
    created_at: now,
    updated_at: now,
    schema_version: 1,
  });
  db.query(
    `INSERT INTO proposal (id, target_pack, diff, diff_hash, evidence, rationale, created_by, state, quarantine_reason, rejections_seen_through, created_at, updated_at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    proposal.id,
    proposal.target_pack,
    JSON.stringify(proposal.diff),
    proposal.diff_hash,
    JSON.stringify(proposal.evidence),
    proposal.rationale,
    proposal.created_by,
    proposal.state,
    null,
    proposal.rejections_seen_through,
    now,
    now,
    1,
  );
  loopEvent(db, "proposal_created", proposal.id, {
    target_pack: proposal.target_pack,
    diff_hash: proposal.diff_hash,
    evidence_count: proposal.evidence.length,
  });
  loopEvent(db, "evidence_check", proposal.id, {
    outcome: "resolved",
    ...check,
  });
  return proposal;
};

// LOOP-11 rejection history: one entry per proposal currently rejected or
// quarantined, recency by the proposal row's rowid (NOT the rejecting
// transition's time), newest first, window exactly REJECTION_WINDOW. The
// basis is the reason recorded by the transition that entered the current
// state (quarantine_reason is that column — transition() writes every
// reason there, not only quarantine's).
export interface RejectionEntry {
  id: string;
  target_pack: string;
  summary: string;
  basis: string | null;
  state: "rejected" | "quarantined";
}

export interface RejectionHistory {
  entries: RejectionEntry[];
  // ULID id (not integer rowid) of the newest entry; null when empty.
  seenThrough: string | null;
}

export const assembleRejectionHistory = (db: Database): RejectionHistory => {
  const entries = db
    .query(
      `SELECT id, target_pack, rationale AS summary, quarantine_reason AS basis, state
       FROM proposal WHERE state IN ('rejected', 'quarantined')
       ORDER BY rowid DESC LIMIT ${REJECTION_WINDOW}`,
    )
    .all() as RejectionEntry[];
  return { entries, seenThrough: entries[0]?.id ?? null };
};

export interface CycleDraft {
  targetPack: string;
  diff: ProposalDiff;
  evidence: EvidenceLink[];
  rationale: string;
  // LOOP-10 rank key — |FPAR delta| for v1 ledger drafts; higher emits first.
  expected_effect: number;
}

// LOOP-10 + LOOP-11: one compiler emission cycle. Ranks by expected effect,
// clips to the edit budget (clipped candidates get no row and no state —
// their evidence stays minable), snapshots the rejection history ONCE, and
// stamps every emitted proposal with the identical watermark. `history` is
// injectable so tests can prove the snapshot semantics (a mid-cycle
// rejection must not split a cycle's watermarks).
export const emitProposalCycle = (
  db: Database,
  args: {
    drafts: CycleDraft[];
    createdBy: "loop" | "human";
    repoRoot: string;
    gatingSuiteIds?: string[];
    editBudget?: number;
    history?: RejectionHistory;
  },
): { proposals: Proposal[]; clipped: number; history: RejectionHistory } => {
  const budget = args.editBudget ?? EDIT_BUDGET_DEFAULT;
  if (!Number.isInteger(budget) || budget < EDIT_BUDGET_FLOOR)
    throw new Error(
      `edit budget must be an integer >= ${EDIT_BUDGET_FLOOR}, got ${budget} (LOOP-10)`,
    );
  const history = args.history ?? assembleRejectionHistory(db);
  const ranked = [...args.drafts].sort(
    (a, b) => b.expected_effect - a.expected_effect,
  );
  const emitted = ranked.slice(0, budget).map((draft) =>
    createProposal(db, {
      targetPack: draft.targetPack,
      diff: draft.diff,
      evidence: draft.evidence,
      rationale: draft.rationale,
      createdBy: args.createdBy,
      repoRoot: args.repoRoot,
      ...(args.gatingSuiteIds ? { gatingSuiteIds: args.gatingSuiteIds } : {}),
      rejectionsSeenThrough: history.seenThrough,
    }),
  );
  return {
    proposals: emitted,
    clipped: Math.max(0, ranked.length - budget),
    history,
  };
};

export const transition = (
  db: Database,
  id: string,
  to: ProposalState,
  meta: { actor: "loop" | "human" | "auto"; reason?: string } & Record<
    string,
    unknown
  >,
): Proposal => {
  const proposal = readProposal(db, id);
  if (!TRANSITIONS[proposal.state].includes(to))
    throw new Error(
      `illegal transition ${proposal.state} -> ${to} for proposal ${id} (state machine §9.2)`,
    );
  // LOOP-2: a loop-originated diff approves only on a passing gate basis or
  // an explicit human override naming what it overrides.
  if (to === "approved" && proposal.created_by === "loop") {
    const basis = meta.gate_basis as { auto_approvable?: boolean } | undefined;
    const humanOverride =
      meta.actor === "human" && typeof meta.reason === "string";
    if (!basis?.auto_approvable && !humanOverride)
      throw new Error(
        `loop-originated proposal ${id} needs a passing gate basis or a recorded human override to approve (LOOP-2)`,
      );
  }
  if (to === "monitoring") {
    // Exclude this proposal's own just-inserted record — the TLA+ Monitor(p)
    // action is enabled when OTHERS currently monitoring < K.
    const open = db
      .query(
        "SELECT COUNT(*) AS n FROM monitor_record WHERE status = 'open' AND proposal_id != ?",
      )
      .get(id) as { n: number };
    if (open.n >= MONITORING_CAP)
      throw new Error(
        `monitoring cap ${MONITORING_CAP} reached (I2) — close a window before applying more`,
      );
  }
  const now = new Date().toISOString();
  // LOOP-11: entering a rejection-family state OVERWRITES the stored reason
  // (null when the entering transition carries none) — COALESCE here would
  // surface a stale earlier reason (e.g. an approval override) as the basis.
  const entersRejection =
    to === "rejected" || to === "reverted" || to === "quarantined";
  db.query(
    entersRejection
      ? "UPDATE proposal SET state = ?, updated_at = ?, quarantine_reason = ? WHERE id = ?"
      : "UPDATE proposal SET state = ?, updated_at = ?, quarantine_reason = COALESCE(?, quarantine_reason) WHERE id = ?",
  ).run(to, now, (meta.reason as string) ?? null, id);
  loopEvent(db, "state_transition", id, {
    from: proposal.state,
    to,
    ...meta,
  });
  return readProposal(db, id);
};

// LOOP-8 pre-gate re-check: files may have changed since creation.
export const enterGate = (
  db: Database,
  id: string,
  repoRoot: string,
): Proposal => {
  const proposal = readProposal(db, id);
  const check = resolveEvidence(db, proposal.evidence, repoRoot);
  loopEvent(db, "evidence_check", id, {
    outcome: check.ok ? "resolved" : "rejected",
    phase: "pre_gate",
    ...check,
  });
  if (!check.ok) {
    transition(db, id, "gated", { actor: "auto" });
    return transition(db, id, "rejected", {
      actor: "auto",
      reason: "evidence unresolvable pre-gate (LOOP-8)",
    });
  }
  return transition(db, id, "gated", { actor: "auto" });
};

const applyOps = (lockfile: Lockfile, diff: ProposalDiff): Lockfile => ({
  ...lockfile,
  entries: lockfile.entries.map((e) => {
    const op = diff.ops.find((o) => o.pack === e.name);
    if (!op) return e;
    return { ...e, enabled: op.op === "enable" };
  }),
});

const invertOps = (diff: ProposalDiff): ProposalDiff => ({
  kind: "lockfile",
  ops: diff.ops.map((o) => ({
    op: o.op === "enable" ? ("disable" as const) : ("enable" as const),
    pack: o.pack,
  })),
});

// PACK-5: the writer refuses anything but seq = last + 1.
export const appendChangelog = (
  path: string,
  entry: Omit<ChangelogEntry, "seq">,
): ChangelogEntry => {
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    : [];
  const last = lines.length
    ? ChangelogEntry.parse(JSON.parse(lines[lines.length - 1] as string)).seq
    : 0;
  const full = ChangelogEntry.parse({ ...entry, seq: last + 1 });
  appendFileSync(path, `${JSON.stringify(full)}\n`);
  return full;
};

export const readChangelog = (path: string): ChangelogEntry[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => ChangelogEntry.parse(JSON.parse(l)))
    : [];

export interface ApplyContext {
  lockfilePath: string;
  changelogPath: string;
}

// LOOP-2 apply: new child lockfile; changelog entry sufficient to revert in
// one command. Proposal must be approved (I1 is structural via TRANSITIONS).
export const applyProposal = (
  db: Database,
  id: string,
  ctx: ApplyContext,
): { proposal: Proposal; lockfileAfter: string } => {
  const proposal = readProposal(db, id);
  if (proposal.state !== "approved")
    throw new Error(
      `apply requires state approved, got ${proposal.state} (I1)`,
    );
  const lockfile = JSON.parse(
    readFileSync(ctx.lockfilePath, "utf8"),
  ) as Lockfile;
  const before = hashLockfile(lockfile);
  const after = applyOps(lockfile, proposal.diff);
  after.parent_hash = before;
  const afterHash = hashLockfile(after);
  writeFileSync(ctx.lockfilePath, `${JSON.stringify(after, null, 2)}\n`);
  appendChangelog(ctx.changelogPath, {
    at: new Date().toISOString(),
    action: "apply",
    proposal_id: id,
    lockfile_before: before,
    lockfile_after: afterHash,
    evidence_summary: proposal.rationale.slice(0, 200),
  });
  transition(db, id, "applied", { actor: "auto", lockfile_after: afterHash });
  return { proposal: readProposal(db, id), lockfileAfter: afterHash };
};

// LOOP-2 revert: inverse ops applied to the CURRENT lockfile — later diffs
// survive; the result equals the pre-apply hash only when nothing intervened.
export const revertProposal = (
  db: Database,
  id: string,
  ctx: ApplyContext,
  meta: { actor: "human" | "auto"; reason: string },
): { lockfileAfter: string } => {
  const proposal = readProposal(db, id);
  const lockfile = JSON.parse(
    readFileSync(ctx.lockfilePath, "utf8"),
  ) as Lockfile;
  const before = hashLockfile(lockfile);
  const after = applyOps(lockfile, invertOps(proposal.diff));
  after.parent_hash = before;
  const afterHash = hashLockfile(after);
  writeFileSync(ctx.lockfilePath, `${JSON.stringify(after, null, 2)}\n`);
  appendChangelog(ctx.changelogPath, {
    at: new Date().toISOString(),
    action: "revert",
    proposal_id: id,
    lockfile_before: before,
    lockfile_after: afterHash,
    evidence_summary: meta.reason.slice(0, 200),
  });
  transition(db, id, "reverted", { ...meta });
  transition(db, id, "quarantined", { ...meta, reason: meta.reason });
  return { lockfileAfter: afterHash };
};

export const releaseQuarantined = (
  db: Database,
  id: string,
  actor: "human",
): Proposal => {
  loopEvent(db, "quarantine_release", id, { actor });
  return transition(db, id, "proposed", {
    actor,
    reason: "human release — must re-pass the full gate (LOOP-9)",
  });
};

// A lockfile "contains" a proposal's diff when it is the apply's
// lockfile_after or a descendant, and not the revert's lockfile_after or a
// descendant — derived from the changelog chain.
export const lockfileContains = (
  changelog: ChangelogEntry[],
  lockfileHash: string,
  proposalId: string,
): boolean => {
  let contains = false;
  for (const entry of changelog) {
    if (entry.proposal_id === proposalId) contains = entry.action === "apply";
    if (entry.lockfile_after === lockfileHash) return contains;
  }
  return false;
};

// LOOP-6: only gating-role suites feed gate math — a staged suite run can
// never approve anything. EVP §5: the gate always evaluates the CANDIDATE
// configuration as side A — stored runs with reversed sides are side-swapped
// and the decision table recomputed from per-task results.
export interface GateBasis {
  benchmark: { decision: string; run_id: string; suite_role: string };
  replay: { vetoed: boolean; decision: string; valid_n: number };
  auto_approvable: boolean;
}

export const evaluateGate = (
  db: Database,
  args: {
    runId: string;
    replayConfig: string;
    // REQUIRED: the stored run side holding the CANDIDATE configuration; "B"
    // side-swaps the per-task pairs before the decision table recomputes
    // (EVP §5). No default — a caller that does not know which side holds
    // the candidate cannot gate soundly.
    candidateSide: "A" | "B";
    minSample?: number;
  },
): GateBasis => {
  const run = db
    .query(
      "SELECT r.id, r.suite_id, r.suite_version, r.seed, s.role FROM eval_run r JOIN eval_suite s ON s.id = r.suite_id AND s.version = r.suite_version WHERE r.id = ?",
    )
    .get(args.runId) as { id: string; role: string; seed: number } | null;
  if (!run) throw new Error(`unknown eval run: ${args.runId}`);
  if (run.role !== "gating")
    throw new Error(
      `run ${args.runId} belongs to a ${run.role} suite — staged suites never gate (LOOP-6)`,
    );
  const side = args.candidateSide;
  const rows = db
    .query(
      "SELECT bench_task_id, side, fpar_pass, cost_micro_usd, schema_version FROM eval_task_result WHERE run_id = ? ORDER BY rowid",
    )
    .all(args.runId) as {
    bench_task_id: string;
    side: "A" | "B";
    fpar_pass: number;
    cost_micro_usd: number;
  }[];
  const versions = new Set(
    rows.map((r) => (r as { schema_version?: number }).schema_version ?? 1),
  );
  if (versions.size > 1)
    throw new Error(
      `cross-schema-version eval comparison refused (OSS-6): task results carry versions ${[...versions].join(", ")} — migrate or re-run; never silently coerce`,
    );
  const byTask = new Map<string, { A: typeof rows; B: typeof rows }>();
  for (const r of rows) {
    const acc = byTask.get(r.bench_task_id) ?? { A: [], B: [] };
    acc[r.side].push(r);
    byTask.set(r.bench_task_id, acc);
  }
  const majority = (xs: typeof rows) =>
    xs.filter((x) => x.fpar_pass === 1).length * 2 > xs.length ? 1 : 0;
  const meanCost = (xs: typeof rows) =>
    xs.length === 0
      ? 0
      : xs.reduce((a, x) => a + x.cost_micro_usd, 0) / xs.length;
  const pairs = [...byTask.entries()]
    .filter(([, acc]) => acc.A.length > 0 && acc.B.length > 0)
    .map(([task_id, acc]) => {
      const cand = side === "A" ? acc.A : acc.B;
      const other = side === "A" ? acc.B : acc.A;
      return {
        task_id,
        fpar_a: majority(cand),
        fpar_b: majority(other),
        cost_a: meanCost(cand),
        cost_b: meanCost(other),
      };
    });
  const decision = gate(pairs, {
    seed: run.seed,
    ...(args.minSample !== undefined ? { minSample: args.minSample } : {}),
  });
  const replay = aggregateReplays(db, args.replayConfig);
  return {
    benchmark: {
      decision: decision.decision,
      run_id: args.runId,
      suite_role: run.role,
    },
    replay: {
      vetoed: replay.vetoed,
      decision: replay.decision,
      valid_n: replay.valid_n,
    },
    auto_approvable: decision.decision === "helps" && !replay.vetoed,
  };
};
