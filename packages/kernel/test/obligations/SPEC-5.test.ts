import { describe, expect, it } from "bun:test";
import {
  recordDivergence,
  specBlockedByDivergence,
} from "../../src/divergence.ts";
import { openDb } from "../../src/storage.ts";

const SPEC_SOURCE = "# a spec with divergences\n";

describe("SPEC-5: a divergent spec routes back to planning with the inputs attached and cannot reach build", () => {
  it("an open divergence report blocks the spec; resolving it unblocks", () => {
    const db = openDb(":memory:");
    expect(specBlockedByDivergence(db, SPEC_SOURCE)).toBe(false);
    const reportId = recordDivergence(db, SPEC_SOURCE, {
      status: "diverged",
      seed: 7,
      entries: [
        {
          clause_id: "FEE-1",
          probe_input: { amount: 5, rate_bp: 1000 },
          differing_path: "$.fee",
          outcome_a: { tag: "returned", value: { fee: 1 } },
          outcome_b: { tag: "returned", value: { fee: 0 } },
          redacted_paths: [],
        },
      ],
    });
    // The divergent spec cannot reach build.
    expect(specBlockedByDivergence(db, SPEC_SOURCE)).toBe(true);
    // The divergent inputs travel with the report (mandatory-clause material).
    const row = db
      .query("SELECT entries, clause_ids FROM divergence_report WHERE id = ?")
      .get(reportId) as { entries: string; clause_ids: string };
    expect(JSON.parse(row.clause_ids)).toEqual(["FEE-1"]);
    expect(JSON.parse(row.entries)[0].probe_input).toEqual({
      amount: 5,
      rate_bp: 1000,
    });
    // Repair = resolve; the repaired spec can proceed.
    db.query("UPDATE divergence_report SET resolved = 1 WHERE id = ?").run(
      reportId,
    );
    expect(specBlockedByDivergence(db, SPEC_SOURCE)).toBe(false);
    db.close();
  });
});
