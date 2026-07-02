import { describe, expect, it } from "bun:test";
import { registerArtifact } from "../../src/artifacts.ts";
import { promoteInferred, promotionQueue } from "../../src/excavate.ts";
import { openDb } from "../../src/storage.ts";
import { seedSession } from "../loop-helpers.ts";

describe("SPEC-8: an inferred clause surviving N sessions without violation or edit queues for batched human promotion", () => {
  it("the queue holds exactly the survivors; promotion flips authority to confirmed", () => {
    const db = openDb(":memory:");
    registerArtifact(db, {
      repo: "r",
      logical_id: "spec.md#SURVIVOR-1",
      type: "spec",
      content: "v1",
      authority: "inferred",
    });
    registerArtifact(db, {
      repo: "r",
      logical_id: "spec.md#TOO-YOUNG-1",
      type: "spec",
      content: "v1",
      authority: "inferred",
    });
    // 20 complete sessions after the survivor's ingestion...
    for (let i = 0; i < 20; i++)
      seedSession(db, {
        lockfileHash: `sha256:${"e".repeat(64)}`,
        startedAt: `2099-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      });
    // ...but TOO-YOUNG re-registered (human edit) after those sessions.
    db.query(
      "UPDATE artifact SET updated_at = '2099-02-01T00:00:00Z' WHERE logical_id = 'spec.md#TOO-YOUNG-1'",
    ).run();

    // Routine re-ingest of IDENTICAL content must not reset the clock —
    // asserted on the column directly (session dating can't vouch for this:
    // the fixture sessions live in 2099, wall-clock stamps in the present).
    const updatedAt = () =>
      (
        db
          .query(
            "SELECT updated_at FROM artifact WHERE logical_id = 'spec.md#SURVIVOR-1'",
          )
          .get() as { updated_at: string }
      ).updated_at;
    const before = updatedAt();
    registerArtifact(db, {
      repo: "r",
      logical_id: "spec.md#SURVIVOR-1",
      type: "spec",
      content: "v1",
      authority: "inferred",
    });
    expect(updatedAt()).toBe(before);
    // A CONTENT change does move the clock.
    registerArtifact(db, {
      repo: "r",
      logical_id: "spec.md#EDITED-1",
      type: "spec",
      content: "v1",
      authority: "inferred",
    });
    registerArtifact(db, {
      repo: "r",
      logical_id: "spec.md#EDITED-1",
      type: "spec",
      content: "v2",
      authority: "inferred",
    });
    const editedRow = db
      .query(
        "SELECT created_at, updated_at FROM artifact WHERE logical_id = 'spec.md#EDITED-1'",
      )
      .get() as { created_at: string; updated_at: string };
    expect(editedRow.updated_at >= editedRow.created_at).toBe(true);
    // ...and another repo's sessions never count toward survival.
    registerArtifact(db, {
      repo: "other-repo",
      logical_id: "spec.md#FOREIGN-1",
      type: "spec",
      content: "v1",
      authority: "inferred",
    });
    const queue = promotionQueue(db, "r", 20);
    // EDITED-1 also qualifies (its wall-clock updated_at predates the 2099
    // fixture sessions); TOO-YOUNG-1 (edited after them) must not.
    expect(queue.map((c) => c.logical_id).sort()).toEqual([
      "spec.md#EDITED-1",
      "spec.md#SURVIVOR-1",
    ]);
    expect(promotionQueue(db, "other-repo", 20)).toHaveLength(0);
    expect(queue[0]?.sessions_survived).toBe(20);

    promoteInferred(db, "r", ["spec.md#SURVIVOR-1", "spec.md#EDITED-1"]);
    const row = db
      .query(
        "SELECT authority FROM artifact WHERE logical_id = 'spec.md#SURVIVOR-1'",
      )
      .get() as { authority: string };
    expect(row.authority).toBe("confirmed");
    expect(promotionQueue(db, "r", 20)).toHaveLength(0);
    db.close();
  });
});
