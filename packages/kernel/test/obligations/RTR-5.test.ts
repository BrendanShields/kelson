import { describe, expect, it } from "bun:test";
import { BANDIT_DEFAULTS, recordOutcome } from "../../src/bandit.ts";
import { openDb } from "../../src/storage.ts";

describe("RTR-5: online updates adjust only selection weights — the write surface is structurally pinned", () => {
  it("the EMA update writes routing_weight.weight and appends outcomes; w0 = 0.5, alpha = 0.1", () => {
    const db = openDb(":memory:");
    const w1 = recordOutcome(db, "v1", "small", 1);
    expect(w1).toBeCloseTo(0.55, 10); // (1-0.1)*0.5 + 0.1*1
    const w2 = recordOutcome(db, "v1", "small", 0);
    expect(w2).toBeCloseTo(0.495, 10);
    const outcomes = db
      .query("SELECT COUNT(*) AS n FROM routing_outcome")
      .get() as { n: number };
    expect(outcomes.n).toBe(2);
    expect(BANDIT_DEFAULTS).toEqual({ epsilon: 0.05, alpha: 0.1, w0: 0.5 });
    db.close();
  });

  it("any mutation beyond the weight field is rejected at the storage layer", () => {
    const db = openDb(":memory:");
    recordOutcome(db, "v1", "small", 1);
    expect(() =>
      db
        .query("UPDATE routing_weight SET arm = 'frontier' WHERE arm = 'small'")
        .run(),
    ).toThrow(/only weight\/updated_at may change \(RTR-5\)/);
    expect(() =>
      db
        .query(
          "UPDATE routing_weight SET policy_version = 'v2' WHERE arm = 'small'",
        )
        .run(),
    ).toThrow(/RTR-5/);
    // The sanctioned write still works.
    db.query(
      "UPDATE routing_weight SET weight = 0.7 WHERE arm = 'small'",
    ).run();
    db.close();
  });

  it("routing_outcome is append-only — the bookkeeping cannot be rewritten either", () => {
    const db = openDb(":memory:");
    recordOutcome(db, "v1", "small", 1);
    expect(() =>
      db.query("UPDATE routing_outcome SET outcome = 0").run(),
    ).toThrow(/append-only/);
    db.close();
  });
});
