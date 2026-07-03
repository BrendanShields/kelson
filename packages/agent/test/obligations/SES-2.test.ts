import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { appendEvent, listEvents, reconstruct } from "../../src/sessions.ts";
import { fixture } from "../helpers.ts";

describe("SES-2: reconstruction walks the parent chain root-first, deterministically", () => {
  it("PBT: any appended chain reconstructs to exactly its events in insertion order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 1,
          maxLength: 12,
        }),
        (texts) => {
          const f = fixture([]);
          // fixture() seeds session_meta + user_message = 2 chain events.
          let parent =
            reconstruct(listEvents(f.db, f.sessionId)).at(-1)?.id ?? null;
          const appended: string[] = [];
          for (const text of texts) {
            const e = appendEvent(f.db, {
              session_id: f.sessionId,
              parent_id: parent,
              kind: "user_message",
              payload: { text },
            });
            appended.push(e.id);
            parent = e.id;
          }
          const chainA = reconstruct(listEvents(f.db, f.sessionId));
          const chainB = reconstruct(listEvents(f.db, f.sessionId));
          expect(chainA.map((e) => e.id)).toEqual(chainB.map((e) => e.id));
          expect(chainA.length).toBe(2 + texts.length);
          expect(chainA.slice(2).map((e) => e.id)).toEqual(appended);
          expect(chainA.every((e) => e.kind !== "head_moved")).toBe(true);
          f.db.close();
        },
      ),
      { numRuns: 25 },
    );
  });

  it("a fork (two children of one parent) reconstructs along the current head's branch", () => {
    const f = fixture([]);
    const root = reconstruct(listEvents(f.db, f.sessionId)).at(-1);
    if (!root) throw new Error("no root");
    const branchA = appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: root.id,
      kind: "user_message",
      payload: { text: "branch A" },
    });
    const branchB = appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: root.id,
      kind: "user_message",
      payload: { text: "branch B" },
    });
    const chain = reconstruct(listEvents(f.db, f.sessionId));
    const ids = chain.map((e) => e.id);
    expect(ids).toContain(branchB.id);
    expect(ids).not.toContain(branchA.id);
  });
});
