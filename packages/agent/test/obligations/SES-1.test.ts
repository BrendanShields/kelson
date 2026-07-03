import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../helpers.ts";

describe("SES-1: session_event is append-only, read by rowid", () => {
  it("UPDATE and DELETE on session_event abort structurally", () => {
    const f = fixture([]);
    expect(() =>
      f.db.query("UPDATE session_event SET kind = 'session_meta'").run(),
    ).toThrow(/append-only/);
    expect(() => f.db.query("DELETE FROM session_event").run()).toThrow(
      /append-only/,
    );
  });

  // Proxy (named): the store module's source issues no UPDATE/DELETE against
  // session_event — the trigger above is the structural guarantee; this scan
  // catches a bypass being *written*, not just executed.
  it("sessions.ts contains no UPDATE or DELETE statements", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "sessions.ts"),
      "utf8",
    );
    expect(src).not.toMatch(
      /UPDATE\s+session_event|DELETE\s+FROM\s+session_event/i,
    );
  });
});
