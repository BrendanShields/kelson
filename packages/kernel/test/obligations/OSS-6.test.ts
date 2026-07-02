import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { KERNEL_MIGRATIONS_DIR, openDb } from "../../src/storage.ts";

const v1 = join(import.meta.dir, "..", "fixtures", "OSS-6", "v1");
const v2 = join(import.meta.dir, "..", "fixtures", "OSS-6", "v2");
const tmp = () =>
  join("/tmp", `kelson-oss6-${Math.random().toString(36).slice(2)}.db`);

describe("OSS-6: versioned schemas with forward migrations, no silent coercion", () => {
  it("a store created at schema v1 is readable after upgrade to v2", () => {
    const path = tmp();
    const dbV1 = openDb(path, v1);
    dbV1
      .query(
        "INSERT INTO widget (id, schema_version, payload) VALUES (?, ?, ?)",
      )
      .run("w1", 1, "hello");
    dbV1.close();

    const dbV2 = openDb(path, v2);
    const row = dbV2
      .query("SELECT * FROM widget WHERE id = 'w1'")
      .get() as Record<string, unknown>;
    expect(row.payload).toBe("hello");
    expect(row.label).toBeNull();
    const version = (
      dbV2.query("SELECT MAX(version) AS v FROM schema_migrations").get() as {
        v: number;
      }
    ).v;
    expect(version).toBe(2);
    dbV2.close();
  });

  it("migration is idempotent — reopening applies nothing new", () => {
    const path = tmp();
    openDb(path, v2).close();
    const db = openDb(path, v2);
    const count = (
      db.query("SELECT COUNT(*) AS c FROM schema_migrations").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(2);
    db.close();
  });

  it("a store newer than the kernel's migrations is refused, never coerced", () => {
    const path = tmp();
    openDb(path, v2).close();
    expect(() => openDb(path, v1)).toThrow(/newer than this kernel/);
  });

  it("every event row carries its schema_version (real kernel migration 0001)", () => {
    const db = openDb(":memory:", KERNEL_MIGRATIONS_DIR);
    const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    db.query(
      `INSERT INTO step_event (id, task_id, session_id, sdlc_step, model, effort, agent_id,
        tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, unit_prices,
        cost_micro_usd, budget_tokens, overrun, schema_version)
       VALUES ('${ulid}', '${ulid}', '${ulid}', 'build', 'm', 'low', 'a', 0, 0, 0, 0, '{}', 0, 1, 'none', 1)`,
    ).run();
    db.query(
      `INSERT INTO intervention_event (id, task_id, session_id, class, at, schema_version)
       VALUES ('${ulid}', '${ulid}', '${ulid}', 'approval', '2026-07-02T00:00:00Z', 1)`,
    ).run();
    for (const table of ["step_event", "intervention_event"]) {
      const row = db.query(`SELECT schema_version FROM ${table}`).get() as {
        schema_version: number;
      };
      expect(row.schema_version).toBe(1);
    }
    expect(() =>
      db
        .query(`INSERT INTO drift_event (id, repo, artifact_id, direction, detected_at)
        VALUES ('${ulid}', 'r', 'a', 'upstream_stale', 't')`)
        .run(),
    ).toThrow(/schema_version/);
    db.close();
  });

  // OSS-6 part 2 ("cross-version eval comparison without a migration path is
  // rejected") is an eval-harness behavior — discharged in Phase 2 with EVAL-1.
  it.todo("cross-version eval comparison without a migration path is rejected (Phase 2)", () => {});
});
