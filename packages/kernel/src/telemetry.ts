import type { Database } from "bun:sqlite";
import {
  InterventionEvent,
  Session as SessionSchema,
  StepEvent,
  Task as TaskSchema,
} from "@kelson/schemas";
import { ulid } from "./ulid.ts";

// TEL-2 note: this module (and this package) has no network path at all — the
// strongest form of "transmits nothing off-machine unless opted in". Opt-in
// sharing, when it exists, lives in a separate component behind TEL-3.

// Sessions start 'incomplete' and are promoted on clean end, so any collector
// death mid-session leaves the TEL-5-required marker with no cleanup code.
export const startSession = (
  db: Database,
  args: {
    repo: string;
    lockfile_hash: string;
    harness_version: string;
    trace_id?: string;
  },
): string => {
  const row = SessionSchema.parse({
    id: ulid(),
    repo: args.repo,
    lockfile_hash: args.lockfile_hash,
    harness_version: args.harness_version,
    schema_version: 1,
    status: "incomplete",
    trace_id: args.trace_id ?? null,
    started_at: new Date().toISOString(),
    ended_at: null,
  });
  db.query(
    `INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, trace_id, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.repo,
    row.lockfile_hash,
    row.harness_version,
    row.schema_version,
    row.status,
    row.trace_id,
    row.started_at,
    row.ended_at,
  );
  return row.id;
};

export const endSession = (db: Database, id: string): void => {
  db.query(
    "UPDATE session SET status = 'complete', ended_at = ? WHERE id = ? AND status = 'incomplete'",
  ).run(new Date().toISOString(), id);
};

export const markSessionDegraded = (db: Database, id: string): void => {
  db.query("UPDATE session SET status = 'degraded' WHERE id = ?").run(id);
};

// TEL-5/KERN-1: only 'complete' sessions may enter gate computations.
export const gateEligibleSessions = (db: Database): string[] =>
  (
    db
      .query("SELECT id FROM session WHERE status = 'complete' ORDER BY id")
      .all() as { id: string }[]
  ).map((r) => r.id);

export const ingestStepEvent = (db: Database, event: unknown): void => {
  const e = StepEvent.parse(event);
  db.query(
    `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort, agent_id,
       tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, unit_prices,
       cost_micro_usd, budget_tokens, overrun, span_id, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.task_id,
    e.session_id,
    e.sdlc_step,
    e.model,
    e.effort,
    e.agent_id,
    e.tokens_in,
    e.tokens_out,
    e.tokens_cache_read,
    e.tokens_cache_write,
    JSON.stringify(e.unit_prices),
    e.cost_micro_usd,
    e.budget_tokens,
    e.overrun,
    e.span_id,
    e.schema_version,
  );
};

export const ingestInterventionEvent = (db: Database, event: unknown): void => {
  const e = InterventionEvent.parse(event);
  db.transaction(() => {
    db.query(
      "INSERT INTO intervention_event (id, task_id, session_id, class, artifact_hash, at, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      e.id,
      e.task_id,
      e.session_id,
      e.class,
      e.artifact_hash,
      e.at,
      e.schema_version,
    );
    if (e.class === "correction")
      db.query(
        "UPDATE task SET correction_count = correction_count + 1 WHERE id = ?",
      ).run(e.task_id);
  })();
};

// TEL-5: capture failure must never abort the session's real work — and must
// leave a sticky marker so a later clean endSession cannot promote the
// session's partial records into gate eligibility.
export const safeIngest = (
  db: Database,
  sessionId: string,
  kind: "step" | "intervention",
  event: unknown,
): { ok: true } | { ok: false; error: string } => {
  try {
    if (kind === "step") ingestStepEvent(db, event);
    else ingestInterventionEvent(db, event);
    return { ok: true };
  } catch (err) {
    try {
      markSessionDegraded(db, sessionId);
    } catch {
      /* session stays 'incomplete' — still gate-ineligible */
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// TEL-7: legal transitions of the PRD §3 task lifecycle. Terminal states have
// no exits; acceptance always carries its signal.
type TaskState = (typeof TaskSchema.shape.state.options)[number];
const LEGAL_TRANSITIONS: Record<TaskState, TaskState[]> = {
  open: ["in_progress", "abandoned"],
  in_progress: ["delivered", "abandoned"],
  delivered: ["accepted", "corrected", "abandoned"],
  accepted: [],
  corrected: [],
  abandoned: [],
};
const TERMINAL: TaskState[] = ["accepted", "corrected", "abandoned"];

export const openTask = (
  db: Database,
  args: { repo: string; spec_clause_refs?: string[] },
): string => {
  const row = TaskSchema.parse({
    id: ulid(),
    repo: args.repo,
    spec_clause_refs: args.spec_clause_refs ?? [],
    state: "open",
    acceptance_signal: null,
    correction_count: 0,
    opened_at: new Date().toISOString(),
    delivered_at: null,
    closed_at: null,
  });
  db.query(
    "INSERT INTO task (id, repo, spec_clause_refs, state, opened_at) VALUES (?, ?, ?, 'open', ?)",
  ).run(row.id, row.repo, JSON.stringify(row.spec_clause_refs), row.opened_at);
  return row.id;
};

export const transitionTask = (
  db: Database,
  id: string,
  to: TaskState,
  opts?: { signal?: "approval" | "merge_clean" },
): void => {
  const row = db.query("SELECT state FROM task WHERE id = ?").get(id) as {
    state: TaskState;
  } | null;
  if (!row) throw new Error(`unknown task: ${id}`);
  if (!LEGAL_TRANSITIONS[row.state].includes(to))
    throw new Error(`illegal task transition ${row.state} -> ${to} (TEL-7)`);
  if (opts?.signal && to !== "accepted")
    throw new Error("a signal only justifies an accepted transition (TEL-7)");
  if (to === "accepted" && !opts?.signal)
    throw new Error("acceptance requires a signal (TEL-7)");
  if (opts?.signal === "merge_clean")
    throw new Error(
      "merge_clean requires the correction-window machinery (PRD §3(b)) — Phase 0 accepts 'approval' only",
    );
  const now = new Date().toISOString();
  db.query(
    `UPDATE task SET state = ?,
       acceptance_signal = COALESCE(?, acceptance_signal),
       delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
       closed_at = CASE WHEN ? THEN ? ELSE closed_at END
     WHERE id = ?`,
  ).run(
    to,
    opts?.signal ?? null,
    to,
    now,
    TERMINAL.includes(to) ? 1 : 0,
    now,
    id,
  );
};

export const getTask = (db: Database, id: string) => {
  const row = db.query("SELECT * FROM task WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;
  if (!row) return null;
  return TaskSchema.parse({
    ...row,
    spec_clause_refs: JSON.parse(row.spec_clause_refs as string),
  });
};
