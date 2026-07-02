import { describe, expect, it } from "bun:test";
import { openDb } from "../src/storage.ts";

const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const sha = `sha256:${"0".repeat(64)}`;

describe("P0-3 verification: append-only event tables (ERD §2, structural)", () => {
  const db = openDb(":memory:");
  db.query(
    `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort, agent_id,
      tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, unit_prices,
      cost_micro_usd, budget_tokens, overrun, schema_version)
     VALUES ('${ulid}', '${ulid}', '${ulid}', 'build', 'm', 'low', 'a', 0, 0, 0, 0, '{}', 0, 1, 'none', 1)`,
  ).run();

  it("UPDATE on step_event aborts", () => {
    expect(() => db.query("UPDATE step_event SET model = 'x'").run()).toThrow(
      /append-only/,
    );
  });
  it("DELETE on step_event aborts", () => {
    expect(() => db.query("DELETE FROM step_event").run()).toThrow(
      /append-only/,
    );
  });
  it("drift_event resolution mutates in place (the ERD §2 exception)", () => {
    db.query(
      `INSERT INTO drift_event (id, repo, artifact_id, direction, detected_at, schema_version)
       VALUES ('${ulid}', 'r', 'a', 'code_under_spec', '2026-07-02T00:00:00Z', 1)`,
    ).run();
    db.query(
      "UPDATE drift_event SET resolution = 'repaired', resolved_at = '2026-07-02T01:00:00Z'",
    ).run();
    const row = db.query("SELECT resolution FROM drift_event").get() as {
      resolution: string;
    };
    expect(row.resolution).toBe("repaired");
  });
  it("CHECK constraints reject out-of-enum values", () => {
    expect(() =>
      db
        .query(`INSERT INTO session (id, repo, lockfile_hash, harness_version, schema_version, status, started_at)
        VALUES ('${ulid}', 'r', '${sha}', 'v', 1, 'not-a-status', 't')`)
        .run(),
    ).toThrow();
  });
});
