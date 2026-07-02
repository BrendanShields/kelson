import { describe, expect, it } from "bun:test";
import { escalate, route } from "../../src/routing.ts";
import { openDb } from "../../src/storage.ts";
import { POLICY, REGISTRY } from "../routing-helpers.ts";

const MECH_VECTOR = {
  step: "build",
  tier: "T0",
  size: "S",
  lang: "typescript",
  novelty: 0.1,
  novelty_bucket: "low",
  task_type: "mechanical",
  repo: "r",
} as const;

describe("RTR-2: a verification failure escalates to the next ladder entry, recorded as a routing-regret event", () => {
  it("an injected failure at the cheap tier produces exactly one escalation and one regret event", () => {
    const db = openDb(":memory:");
    const initial = route(db, {
      policy: POLICY,
      registry: REGISTRY,
      vector: MECH_VECTOR,
      taskId: "t1",
      stepId: "s1",
    });
    expect(initial.target).toBe("small");

    const outcome = escalate(db, POLICY, initial);
    expect(outcome.kind).toBe("escalated");
    if (outcome.kind !== "escalated") throw new Error("unreachable");
    expect(outcome.decision.target).toBe("mid-tier");
    expect(outcome.decision.kind).toBe("escalation");
    expect(outcome.decision.regret).toBe(true);
    // Budgets travel with the rule: mid-tier's own budget, not small's 8k.
    expect(outcome.decision.budget_tokens).toBe(20000);

    const rows = db
      .query(
        "SELECT kind, regret FROM routing_decision WHERE task_id = 't1' ORDER BY rowid",
      )
      .all() as { kind: string; regret: number }[];
    expect(rows).toEqual([
      { kind: "initial", regret: 0 },
      { kind: "escalation", regret: 1 },
    ]);
    db.close();
  });
});
