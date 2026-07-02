import { describe, expect, it } from "bun:test";
import { escalate, route } from "../../src/routing.ts";
import { openDb } from "../../src/storage.ts";
import { POLICY, REGISTRY } from "../routing-helpers.ts";

describe("RPOL-3: automatic escalations cap at 2 per step; a third failure goes to triage, not a retry", () => {
  it("three injected failures produce exactly two escalations, two regret events, one triage", () => {
    const db = openDb(":memory:");
    const initial = route(db, {
      policy: POLICY,
      registry: REGISTRY,
      vector: {
        step: "build",
        tier: "T0",
        size: "S",
        lang: "typescript",
        novelty: 0.1,
        novelty_bucket: "low",
        task_type: "mechanical",
        repo: "r",
      },
      taskId: "t1",
      stepId: "s1",
    });

    const first = escalate(db, POLICY, initial);
    expect(first.kind).toBe("escalated");
    if (first.kind !== "escalated") throw new Error("unreachable");
    const second = escalate(db, POLICY, first.decision);
    expect(second.kind).toBe("escalated");
    if (second.kind !== "escalated") throw new Error("unreachable");
    expect(second.decision.target).toBe("frontier");

    const third = escalate(db, POLICY, second.decision);
    expect(third).toEqual({ kind: "triage" });

    const regrets = db
      .query(
        "SELECT COUNT(*) AS n FROM routing_decision WHERE step_id = 's1' AND regret = 1",
      )
      .get() as { n: number };
    expect(regrets.n).toBe(2);
    db.close();
  });

  it("an exhausted ladder triages even under the cap", () => {
    const db = openDb(":memory:");
    const initial = route(db, {
      policy: POLICY,
      registry: REGISTRY,
      vector: {
        step: "build",
        tier: "T0",
        size: "M",
        lang: "typescript",
        novelty: 1,
        novelty_bucket: "high",
        task_type: "standard",
        repo: "r",
      },
      taskId: "t2",
      stepId: "s2",
    });
    // build/T0 rule: ladder [frontier] — one entry only.
    const first = escalate(db, POLICY, initial);
    expect(first.kind).toBe("escalated");
    if (first.kind !== "escalated") throw new Error("unreachable");
    expect(escalate(db, POLICY, first.decision)).toEqual({ kind: "triage" });
    db.close();
  });
});
