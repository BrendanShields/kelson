import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProposalState } from "@kelson/schemas";
import fc from "fast-check";
import { getProposal, TRANSITIONS, transition } from "../../src/loop.ts";
import { openMonitor } from "../../src/monitor.ts";
import { openDb } from "../../src/storage.ts";
import { draftProposal, loopCtx } from "../loop-helpers.ts";

// The model's transition relation, transcribed from specs/tla/KelsonLoop.tla
// action definitions — independently of src/loop.ts's TRANSITIONS table.
const MODEL: Record<string, string[]> = {
  proposed: ["gated"], // Gate
  gated: ["approved", "rejected"], // Approve | Reject
  approved: ["applied"], // Apply
  applied: ["monitoring"], // Monitor
  monitoring: ["stable", "reverted"], // Stabilize | Revert
  reverted: ["quarantined"], // Quarantine
  quarantined: ["proposed"], // Release
  rejected: [],
  stable: [],
};

const STATES = Object.keys(MODEL) as ProposalState[];

describe("LOOP-5: conformance checks link the TLA+ model's actions to the implementation's transitions", () => {
  it("the implementation's transition table equals the model's, and the model file declares each action", () => {
    expect(TRANSITIONS).toEqual(MODEL as typeof TRANSITIONS);
    const tla = readFileSync(
      join(import.meta.dir, "../../../../specs/tla/KelsonLoop.tla"),
      "utf8",
    );
    for (const action of [
      "Create",
      "Gate",
      "Approve",
      "Reject",
      "Apply",
      "Monitor",
      "Stabilize",
      "Revert",
      "Quarantine",
      "Release",
    ])
      expect(tla).toContain(`${action}(p)`);
    for (const inv of [
      "I1_GateSoundness",
      "I2_BoundedMonitoring",
      "I3_RevertEnabled",
    ])
      expect(tla).toContain(inv);
  });

  it("I2 cap boundary: the 3rd monitor opens, the 4th refuses atomically with no orphaned state", () => {
    const db = openDb(":memory:");
    const ctx = loopCtx();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = draftProposal(db, ctx, {
        targetPack: i % 2 ? "ponytail" : "routing-default",
        diff: {
          kind: "lockfile" as const,
          ops: [
            {
              op: (i < 2 ? "disable" : "enable") as "disable" | "enable",
              pack: i % 2 ? "ponytail" : "routing-default",
            },
          ],
        },
      });
      transition(db, p.id, "gated", { actor: "auto" });
      transition(db, p.id, "approved", { actor: "human", reason: "test" });
      transition(db, p.id, "applied", { actor: "auto" });
      ids.push(p.id);
    }
    const open = (i: number) =>
      openMonitor(db, ids[i] as string, {
        appliedAt: `2026-07-02T1${i}:00:00Z`,
        lockfileAfter: `sha256:${String(i).repeat(64)}`,
        changelog: [],
      });
    open(0);
    open(1);
    open(2); // exactly at the cap — the TLA+ Monitor action allows the Kth
    expect(() => open(3)).toThrow(/I2/);
    const rows = db
      .query("SELECT COUNT(*) AS n FROM monitor_record WHERE status = 'open'")
      .get() as { n: number };
    expect(rows.n).toBe(3); // no orphaned 4th record
    expect(getProposal(db, ids[3] as string).state).toBe("applied");
    db.close();
  });

  it("PBT: generated action sequences from the model reach the same states in the implementation", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...STATES), { minLength: 1, maxLength: 12 }),
        (targets) => {
          const db = openDb(":memory:");
          const proposal = draftProposal(db, loopCtx());
          let modelState: string = "proposed";
          for (const to of targets) {
            const legal = (MODEL[modelState] ?? []).includes(to);
            // LOOP-2's gate-basis guard is a precondition outside the model's
            // state scope — satisfy it so state parity is what's under test.
            const meta =
              to === "approved"
                ? {
                    actor: "auto" as const,
                    gate_basis: { auto_approvable: true },
                  }
                : { actor: "auto" as const };
            if (legal) {
              const updated = transition(db, proposal.id, to, meta);
              modelState = to;
              expect(updated.state).toBe(to);
            } else {
              expect(() => transition(db, proposal.id, to, meta)).toThrow(
                /illegal transition/,
              );
            }
          }
          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});
