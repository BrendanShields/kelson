import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { openDb } from "../../src/storage.ts";
import { ingestStepEvent, startSession } from "../../src/telemetry.ts";
import { ulid } from "../../src/ulid.ts";

const sha = `sha256:${"0".repeat(64)}`;
const tokens = fc.integer({ min: 0, max: 1_000_000 });

// A synthetic transcript: an ordered list of step boundaries with token counts.
const transcriptArb = fc.array(
  fc.record({
    sdlc_step: fc.constantFrom(
      "feedback",
      "ideation",
      "planning",
      "spec",
      "build",
      "verify",
    ),
    model: fc.constantFrom("small", "mid-tier", "frontier"),
    effort: fc.constantFrom("low", "medium", "high"),
    tokens_in: tokens,
    tokens_out: tokens,
    tokens_cache_read: tokens,
    tokens_cache_write: tokens,
  }),
  { minLength: 1, maxLength: 25 },
);

// TEL-1's trigger ("when a session ends... shall emit") and real transcript
// parsing are cc-plugin behavior (P0-7); this file discharges the ingestion
// half of the obligation and records the rest below.
describe("TEL-1: ingestion yields exactly N step records with token counts summing to the transcript total", () => {
  it("holds for any synthetic transcript", () => {
    fc.assert(
      fc.property(transcriptArb, (steps) => {
        const db = openDb(":memory:");
        const session = startSession(db, {
          repo: "r",
          lockfile_hash: sha,
          harness_version: "0",
        });
        const task = ulid();
        for (const s of steps)
          ingestStepEvent(db, {
            id: ulid(),
            task_id: task,
            session_id: session,
            agent_id: "a",
            unit_prices: {},
            cost_micro_usd: 0,
            budget_tokens: 1,
            overrun: "none",
            span_id: null,
            schema_version: 1,
            ...s,
          });

        const row = db
          .query(
            "SELECT COUNT(*) AS n, SUM(tokens_in) + SUM(tokens_out) AS io FROM step_event WHERE session_id = ?",
          )
          .get(session) as { n: number; io: number };
        expect(row.n).toBe(steps.length);
        expect(row.io).toBe(
          steps.reduce((acc, s) => acc + s.tokens_in + s.tokens_out, 0),
        );
        db.close();
      }),
      { numRuns: 100 },
    );
  });

  it("rejects a malformed event at the boundary (ERD §2: validate at every storage boundary)", () => {
    const db = openDb(":memory:");
    const session = startSession(db, {
      repo: "r",
      lockfile_hash: sha,
      harness_version: "0",
    });
    expect(() =>
      ingestStepEvent(db, {
        id: "nope",
        session_id: session,
        sdlc_step: "build",
      }),
    ).toThrow();
    db.close();
  });

  it.todo("real Claude Code transcript parses and emits on session end (P0-7, cc-plugin)", () => {});
});
