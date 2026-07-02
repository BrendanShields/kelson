import type { Database } from "bun:sqlite";
import { BudgetEvent, type OverrunAttribution } from "@kelson/schemas";
import { ulid } from "./ulid.ts";

const write = (db: Database, event: BudgetEvent): void => {
  BudgetEvent.parse(event);
  db.query(
    "INSERT INTO budget_event (id, step_id, kind, payload, at, schema_version) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    event.id,
    event.step_id,
    event.kind,
    JSON.stringify(event),
    event.at,
    event.schema_version,
  );
};

export type TriageAction = "continue" | "escalate" | "re_spec" | "block";

export interface MonitorIdentity {
  taskId: string;
  stepId: string;
  attempt: number;
  ruleId: string;
  policyHash: string;
  modelId: string;
  escalationDepth: number;
  budgetTokens: number;
}

// RPOL-6 §3.1: thresholds checked at accounting points with >=, latched once
// per attempt; 2× is a durable pause, not a blocked thread; `continue` grants
// exactly one further budget of headroom; headless default is escalate under
// the RPOL-3 cap, else block.
export class BudgetMonitor {
  private used = 0;
  private latched1 = false;
  private latched2 = false;
  private pauseAt: number;
  private pausedFlag = false;

  constructor(
    private db: Database,
    private id: MonitorIdentity,
  ) {
    this.pauseAt = 2 * id.budgetTokens;
  }

  get usedTokens(): number {
    return this.used;
  }
  get paused(): boolean {
    return this.pausedFlag;
  }

  private attribution(): OverrunAttribution {
    return {
      task_id: this.id.taskId,
      step_id: this.id.stepId,
      attempt: this.id.attempt,
      rule_id: this.id.ruleId,
      policy_hash: this.id.policyHash,
      model_id: this.id.modelId,
      escalation_depth: this.id.escalationDepth,
      budget_tokens: this.id.budgetTokens,
      used_tokens: this.used,
      ratio: this.used / this.id.budgetTokens,
    };
  }

  private overrun(threshold: 1 | 2): void {
    write(this.db, {
      id: ulid(),
      kind: "overrun",
      step_id: this.id.stepId,
      threshold,
      attribution: this.attribution(),
      at: new Date().toISOString(),
      schema_version: 1,
    });
  }

  // One accounting point: a model call completed. Returns the step state; a
  // burst crossing both thresholds emits the 1× then the 2× event, then the
  // pause — never a skipped threshold.
  record(tokens: number): "running" | "paused" {
    if (this.pausedFlag)
      throw new Error(
        `step ${this.id.stepId} is paused for triage — no further accounting until resolved`,
      );
    this.used += tokens;
    if (!this.latched1 && this.used > this.id.budgetTokens) {
      this.latched1 = true;
      this.overrun(1);
    }
    if (this.used >= this.pauseAt) {
      if (!this.latched2) {
        this.latched2 = true;
        this.overrun(2);
      }
      this.pausedFlag = true;
      write(this.db, {
        id: ulid(),
        kind: "triage_requested",
        step_id: this.id.stepId,
        options: ["continue", "escalate", "re_spec"],
        escalations_used: this.id.escalationDepth,
        at: new Date().toISOString(),
        schema_version: 1,
      });
      return "paused";
    }
    return "running";
  }

  resolve(
    action: TriageAction,
    actor: "human" | "auto",
    reason: string | null = null,
  ): void {
    if (!this.pausedFlag) throw new Error("step is not paused");
    write(this.db, {
      id: ulid(),
      kind: "triage_resolved",
      step_id: this.id.stepId,
      action,
      actor,
      reason,
      at: new Date().toISOString(),
      schema_version: 1,
    });
    if (action === "continue") {
      this.pauseAt = this.used + this.id.budgetTokens;
      this.pausedFlag = false;
    }
  }

  // Headless resolution: escalate while under the RPOL-3 cap, else block —
  // a headless step never hangs and never silently burns on.
  resolveHeadless(cap = 2): TriageAction {
    const action: TriageAction =
      this.id.escalationDepth < cap ? "escalate" : "block";
    this.resolve(
      action,
      "auto",
      action === "escalate" ? "headless_default" : "escalation_cap",
    );
    return action;
  }
}

// Durable pause: derived from the append-only event stream, not process state.
export const isPausedForTriage = (db: Database, stepId: string): boolean => {
  const row = db
    .query(
      // rowid = insertion order; ULIDs minted in the same millisecond don't sort.
      "SELECT kind FROM budget_event WHERE step_id = ? AND kind IN ('triage_requested', 'triage_resolved') ORDER BY rowid DESC LIMIT 1",
    )
    .get(stepId) as { kind: string } | null;
  return row?.kind === "triage_requested";
};

// §3.1: blocked is durable and operator-resumable — derived from the stream.
export const stepTriageState = (
  db: Database,
  stepId: string,
): "running" | "paused" | "blocked" => {
  const rows = db
    .query(
      "SELECT payload FROM budget_event WHERE step_id = ? AND kind IN ('triage_requested', 'triage_resolved') ORDER BY rowid DESC LIMIT 1",
    )
    .all(stepId) as { payload: string }[];
  const last = rows[0] ? (JSON.parse(rows[0].payload) as BudgetEvent) : null;
  if (!last) return "running";
  if (last.kind === "triage_requested") return "paused";
  if (last.kind === "triage_resolved" && last.action === "block")
    return "blocked";
  return "running";
};

export const budgetEvents = (db: Database, stepId: string): BudgetEvent[] =>
  (
    db
      .query(
        "SELECT payload FROM budget_event WHERE step_id = ? ORDER BY rowid",
      )
      .all(stepId) as { payload: string }[]
  ).map((r) => BudgetEvent.parse(JSON.parse(r.payload)));
