import { describe, expect, it } from "bun:test";
import { runTurn } from "../../src/loop.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";

describe("AGT-3: one first-hand StepEvent per step; telemetry failure never breaks the loop", () => {
  it("a 2-step session yields exactly 2 step_event rows with the fixture's token classes", async () => {
    const f = fixture([
      toolCallResponse([{ id: "c1", name: "ls", input: { path: "." } }]),
      textResponse("done"),
    ]);
    await runTurn(f.deps);
    const rows = f.db
      .query(
        "SELECT tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_micro_usd, model FROM step_event WHERE session_id = ? ORDER BY rowid",
      )
      .all(f.sessionId) as Record<string, unknown>[];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      // Expected values restated from USAGE_FIXTURE by hand (70/5/20/10),
      // not derived through the ingest path.
      expect(row.tokens_in).toBe(70);
      expect(row.tokens_out).toBe(5);
      expect(row.tokens_cache_read).toBe(20);
      expect(row.tokens_cache_write).toBe(10);
      // 70*5 + 5*25 + 20*0.5 + 10*6.25 = 350 + 125 + 10 + 62.5 → 548 (rounded)
      expect(row.cost_micro_usd).toBe(548);
      expect(row.model).toBe("mock-model");
    }
  });

  it("with ingestion broken, the session still completes and is marked degraded", async () => {
    const f = fixture([textResponse("done")]);
    f.db.exec("DROP TABLE step_event");
    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");
    const session = f.db
      .query("SELECT status FROM session WHERE id = ?")
      .get(f.sessionId) as { status: string };
    expect(session.status).toBe("degraded");
  });
});
