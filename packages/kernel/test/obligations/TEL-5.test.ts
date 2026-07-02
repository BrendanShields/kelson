import { describe, expect, it } from "bun:test";
import { openDb } from "../../src/storage.ts";
import {
  endSession,
  gateEligibleSessions,
  safeIngest,
  startSession,
} from "../../src/telemetry.ts";
import { ulid } from "../../src/ulid.ts";

const sha = `sha256:${"0".repeat(64)}`;
const validStep = (session_id: string) => ({
  id: ulid(),
  task_id: ulid(),
  session_id,
  sdlc_step: "build",
  model: "m",
  effort: "low",
  agent_id: "a",
  tokens_in: 1,
  tokens_out: 1,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  unit_prices: {},
  cost_micro_usd: 0,
  budget_tokens: 1,
  overrun: "none",
  span_id: null,
  schema_version: 1,
});

describe("TEL-5: collector failure never aborts the session; partial records never gate", () => {
  it("killed collector (dropped table) -> ingest reports failure without throwing, session stays incomplete", () => {
    const db = openDb(":memory:");
    const session = startSession(db, {
      repo: "r",
      lockfile_hash: sha,
      harness_version: "0",
    });
    expect(safeIngest(db, session, "step", validStep(session)).ok).toBe(true);

    db.exec("DROP TABLE step_event");
    const result = safeIngest(db, session, "step", validStep(session));
    expect(result.ok).toBe(false);

    const status = (
      db.query("SELECT status FROM session WHERE id = ?").get(session) as {
        status: string;
      }
    ).status;
    expect(status).toBe("degraded");
    expect(gateEligibleSessions(db)).toEqual([]);
    db.close();
  });

  it("failed capture followed by a clean session end never becomes gate-eligible", () => {
    const db = openDb(":memory:");
    const session = startSession(db, {
      repo: "r",
      lockfile_hash: sha,
      harness_version: "0",
    });
    db.exec("DROP TABLE step_event");
    expect(safeIngest(db, session, "step", validStep(session)).ok).toBe(false);
    endSession(db, session);
    expect(gateEligibleSessions(db)).toEqual([]);
    db.close();
  });

  it("only cleanly ended sessions are gate-eligible", () => {
    const db = openDb(":memory:");
    const dead = startSession(db, {
      repo: "r",
      lockfile_hash: sha,
      harness_version: "0",
    });
    const clean = startSession(db, {
      repo: "r",
      lockfile_hash: sha,
      harness_version: "0",
    });
    db.query(
      "UPDATE session SET status = 'complete', ended_at = 't' WHERE id = ?",
    ).run(clean);
    expect(gateEligibleSessions(db)).toEqual([clean]);
    expect(gateEligibleSessions(db)).not.toContain(dead);
    db.close();
  });
});
