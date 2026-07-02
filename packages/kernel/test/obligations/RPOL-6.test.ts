import { describe, expect, it } from "bun:test";
import {
  BudgetMonitor,
  budgetEvents,
  isPausedForTriage,
  stepTriageState,
} from "../../src/budget.ts";
import { openDb } from "../../src/storage.ts";
import { identity } from "./CTX-4.test.ts";

describe("RPOL-6: latched thresholds, durable pause, one-budget continue headroom, headless escalate-then-block, attribution everywhere", () => {
  it("a burst crossing both thresholds yields exactly two overrun events then one pause", () => {
    const db = openDb(":memory:");
    const monitor = new BudgetMonitor(db, identity({ stepId: "s1" }));
    expect(monitor.record(900)).toBe("running"); // 0.9x — nothing
    expect(monitor.record(1600)).toBe("paused"); // 2.5x in one burst
    const kinds = budgetEvents(db, "s1").map((e) => e.kind);
    expect(kinds).toEqual(["overrun", "overrun", "triage_requested"]);
    const [one, two] = budgetEvents(db, "s1");
    if (one?.kind !== "overrun" || two?.kind !== "overrun")
      throw new Error("unreachable");
    expect(one.threshold).toBe(1);
    expect(two.threshold).toBe(2);
    // Overshoot recorded honestly, never clamped.
    expect(two.attribution.ratio).toBeCloseTo(2.5, 10);
    db.close();
  });

  it("continue grants exactly one further budget of headroom", () => {
    const db = openDb(":memory:");
    const monitor = new BudgetMonitor(db, identity({ stepId: "s2" }));
    monitor.record(2100); // paused at 2.1x
    monitor.resolve("continue", "human");
    expect(monitor.paused).toBe(false);
    // Next pause at 2100 + 1000 = 3100.
    expect(monitor.record(900)).toBe("running"); // 3000 < 3100
    expect(monitor.record(200)).toBe("paused"); // 3200 >= 3100
    // Threshold overrun events stay latched — only the triage re-fires.
    const kinds = budgetEvents(db, "s2").map((e) => e.kind);
    expect(kinds).toEqual([
      "overrun",
      "overrun",
      "triage_requested",
      "triage_resolved",
      "triage_requested",
    ]);
    db.close();
  });

  it("headless resolution escalates under the cap with actor auto", () => {
    const db = openDb(":memory:");
    const monitor = new BudgetMonitor(
      db,
      identity({ stepId: "s3", escalationDepth: 1 }),
    );
    monitor.record(2000);
    expect(monitor.resolveHeadless()).toBe("escalate");
    const resolved = budgetEvents(db, "s3").at(-1);
    if (resolved?.kind !== "triage_resolved") throw new Error("unreachable");
    expect(resolved.action).toBe("escalate");
    expect(resolved.actor).toBe("auto");
    expect(resolved.reason).toBe("headless_default");
    db.close();
  });

  it("headless resolution blocks at the cap — never hangs, never burns on", () => {
    const db = openDb(":memory:");
    const monitor = new BudgetMonitor(
      db,
      identity({ stepId: "s4", escalationDepth: 2 }),
    );
    monitor.record(2000);
    expect(monitor.resolveHeadless()).toBe("block");
    const resolved = budgetEvents(db, "s4").at(-1);
    if (resolved?.kind !== "triage_resolved") throw new Error("unreachable");
    expect(resolved.action).toBe("block");
    expect(resolved.reason).toBe("escalation_cap");
    // Blocked is not resumed: the step stays unrunnable.
    expect(monitor.paused).toBe(true);
    db.close();
  });

  it("threshold boundaries: exactly 1× emits nothing (strictly exceeds); exactly 2× pauses (inclusive)", () => {
    const db = openDb(":memory:");
    const monitor = new BudgetMonitor(db, identity({ stepId: "s6" }));
    expect(monitor.record(1000)).toBe("running"); // == budget: no overrun
    expect(budgetEvents(db, "s6")).toHaveLength(0);
    expect(monitor.record(1000)).toBe("paused"); // == 2x: inclusive pause
    expect(budgetEvents(db, "s6").map((e) => e.kind)).toEqual([
      "overrun",
      "overrun",
      "triage_requested",
    ]);
    db.close();
  });

  it("blocked is durable: derivable from the event stream by another process", () => {
    const db = openDb(":memory:");
    const monitor = new BudgetMonitor(
      db,
      identity({ stepId: "s7", escalationDepth: 2 }),
    );
    monitor.record(2000);
    expect(stepTriageState(db, "s7")).toBe("paused");
    monitor.resolveHeadless();
    expect(stepTriageState(db, "s7")).toBe("blocked");
    db.close();
  });

  it("every overrun event carries the full attribution set; the pause is durable across process state", () => {
    const db = openDb(":memory:");
    const monitor = new BudgetMonitor(db, identity({ stepId: "s5" }));
    monitor.record(2200);
    for (const e of budgetEvents(db, "s5"))
      if (e.kind === "overrun")
        expect(Object.keys(e.attribution).sort()).toEqual(
          [
            "attempt",
            "budget_tokens",
            "escalation_depth",
            "model_id",
            "policy_hash",
            "ratio",
            "rule_id",
            "step_id",
            "task_id",
            "used_tokens",
          ].sort(),
        );
    // Derived from the event stream, not the monitor instance.
    expect(isPausedForTriage(db, "s5")).toBe(true);
    db.close();
  });
});
