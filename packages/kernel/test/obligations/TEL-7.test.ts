import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { openDb } from "../../src/storage.ts";
import { getTask, openTask, transitionTask } from "../../src/telemetry.ts";

const STATES = [
  "open",
  "in_progress",
  "delivered",
  "accepted",
  "corrected",
  "abandoned",
] as const;
type State = (typeof STATES)[number];
const LEGAL: Record<State, State[]> = {
  open: ["in_progress", "abandoned"],
  in_progress: ["delivered", "abandoned"],
  delivered: ["accepted", "corrected", "abandoned"],
  accepted: [],
  corrected: [],
  abandoned: [],
};

describe("TEL-7: recorded state always follows the legal lifecycle; every acceptance carries a signal", () => {
  it("holds for any generated sequence of transition attempts", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...STATES.filter((s) => s !== "open")), {
          minLength: 1,
          maxLength: 12,
        }),
        (attempts) => {
          const db = openDb(":memory:");
          const id = openTask(db, { repo: "r", spec_clause_refs: ["TEL-7"] });
          let model: State = "open";
          for (const to of attempts) {
            const legal = LEGAL[model].includes(to);
            const apply = () =>
              transitionTask(
                db,
                id,
                to,
                to === "accepted" ? { signal: "approval" } : undefined,
              );
            if (legal) {
              apply();
              model = to;
            } else {
              expect(apply).toThrow(/illegal task transition/);
            }
            const task = getTask(db, id);
            expect(task?.state).toBe(model);
          }
          const task = getTask(db, id);
          if (task?.state === "accepted")
            expect(task.acceptance_signal).not.toBeNull();
          if (
            ["accepted", "corrected", "abandoned"].includes(task?.state ?? "")
          ) {
            expect(task?.closed_at).not.toBeNull();
          }
          db.close();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("acceptance without a signal is refused even on a legal edge", () => {
    const db = openDb(":memory:");
    const id = openTask(db, { repo: "r" });
    transitionTask(db, id, "in_progress");
    transitionTask(db, id, "delivered");
    expect(() => transitionTask(db, id, "accepted")).toThrow(
      /requires a signal/,
    );
    transitionTask(db, id, "accepted", { signal: "approval" });
    expect(getTask(db, id)?.acceptance_signal).toBe("approval");
    db.close();
  });

  it("merge_clean is refused until the correction-window machinery exists (Phase 0 stub)", () => {
    const db = openDb(":memory:");
    const id = openTask(db, { repo: "r" });
    transitionTask(db, id, "in_progress");
    transitionTask(db, id, "delivered");
    expect(() =>
      transitionTask(db, id, "accepted", { signal: "merge_clean" }),
    ).toThrow(/correction-window/);
    db.close();
  });

  it("a signal on a non-accepted transition is refused", () => {
    const db = openDb(":memory:");
    const id = openTask(db, { repo: "r" });
    transitionTask(db, id, "in_progress");
    transitionTask(db, id, "delivered");
    expect(() =>
      transitionTask(db, id, "corrected", { signal: "approval" }),
    ).toThrow(/only justifies/);
    db.close();
  });

  it("terminal states admit no exits", () => {
    const db = openDb(":memory:");
    const id = openTask(db, { repo: "r" });
    transitionTask(db, id, "abandoned");
    for (const to of ["open", "in_progress", "delivered", "accepted"] as const)
      expect(() => transitionTask(db, id, to, { signal: "approval" })).toThrow(
        /illegal/,
      );
    db.close();
  });
});
