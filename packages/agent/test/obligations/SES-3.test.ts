import { describe, expect, it } from "bun:test";
import { appendEvent, currentHead, listEvents } from "../../src/sessions.ts";
import { fixture } from "../helpers.ts";

describe("SES-3: head derives from head_moved events by rowid; no mutable head column", () => {
  it("after a sequence of appends the derived head is the last appended event", () => {
    const f = fixture([]);
    let parent = currentHead(listEvents(f.db, f.sessionId));
    let lastId = "";
    for (const text of ["one", "two", "three"]) {
      const e = appendEvent(f.db, {
        session_id: f.sessionId,
        parent_id: parent,
        kind: "user_message",
        payload: { text },
      });
      parent = e.id;
      lastId = e.id;
      expect(currentHead(listEvents(f.db, f.sessionId))).toBe(e.id);
    }
    expect(currentHead(listEvents(f.db, f.sessionId))).toBe(lastId);
  });

  it("no table carries a head column (schema introspection)", () => {
    const f = fixture([]);
    const tables = f.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const cols = f.db.query(`PRAGMA table_info(${name})`).all() as {
        name: string;
      }[];
      for (const col of cols) expect(col.name).not.toMatch(/^head/);
    }
  });
});
