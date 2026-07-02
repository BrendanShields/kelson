import { describe, expect, it } from "bun:test";
import { OverrunAttribution } from "@kelson/schemas";
import {
  BudgetMonitor,
  budgetEvents,
  isPausedForTriage,
} from "../../src/budget.ts";
import { openDb } from "../../src/storage.ts";

export const identity = (
  over: Partial<ConstructorParameters<typeof BudgetMonitor>[1]> = {},
) => ({
  taskId: "t1",
  stepId: "s1",
  attempt: 0,
  ruleId: "rule:0",
  policyHash: `sha256:${"0".repeat(64)}`,
  modelId: "claude-sonnet-5",
  escalationDepth: 0,
  budgetTokens: 1000,
  ...over,
});

describe("CTX-4: budget attached per step; overrun recorded; 2× pauses for triage rather than burning on", () => {
  it("a runaway fixture step pauses at 2× with a triage prompt; the overrun event carries attribution", () => {
    const db = openDb(":memory:");
    const monitor = new BudgetMonitor(db, identity());
    expect(monitor.record(900)).toBe("running");
    expect(monitor.record(300)).toBe("running"); // 1200 > 1x: overrun, continues
    expect(monitor.record(900)).toBe("paused"); // 2100 >= 2x: pause
    expect(isPausedForTriage(db, "s1")).toBe(true);
    expect(() => monitor.record(1)).toThrow(/paused for triage/);

    const events = budgetEvents(db, "s1");
    expect(events.map((e) => e.kind)).toEqual([
      "overrun",
      "overrun",
      "triage_requested",
    ]);
    const twoX = events[1];
    if (twoX?.kind !== "overrun") throw new Error("unreachable");
    expect(twoX.threshold).toBe(2);
    expect(OverrunAttribution.safeParse(twoX.attribution).success).toBe(true);
    expect(twoX.attribution.ratio).toBeCloseTo(2.1, 10);
    expect(twoX.attribution.rule_id).toBe("rule:0");
    expect(twoX.attribution.model_id).toBe("claude-sonnet-5");
    const triage = events[2];
    if (triage?.kind !== "triage_requested") throw new Error("unreachable");
    expect(triage.options).toEqual(["continue", "escalate", "re_spec"]);
    db.close();
  });

  it("1× overrun is record-and-continue, latched once per attempt", () => {
    const db = openDb(":memory:");
    const monitor = new BudgetMonitor(db, identity({ stepId: "s2" }));
    expect(monitor.record(1100)).toBe("running");
    expect(monitor.record(100)).toBe("running");
    const overruns = budgetEvents(db, "s2").filter((e) => e.kind === "overrun");
    expect(overruns).toHaveLength(1);
    expect(isPausedForTriage(db, "s2")).toBe(false);
    db.close();
  });
});
