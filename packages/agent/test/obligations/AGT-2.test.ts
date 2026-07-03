import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@kelson/kernel";
import { answerPermission, resume, runTurn } from "../../src/loop.ts";
import { listEvents, reconstruct } from "../../src/sessions.ts";
import { CORE_TOOLS, localExec } from "../../src/tools.ts";
import {
  fixture,
  mockModel,
  TEST_ENTRY,
  textResponse,
  toolCallResponse,
} from "../helpers.ts";

describe("AGT-2: step outcomes are continue|done|paused; paused state survives a process restart", () => {
  it("a step-limit pause is a resumable paused state, not a dead end", async () => {
    const f = fixture([
      toolCallResponse([{ id: "c1", name: "ls", input: { path: "." } }]),
      textResponse("finished"),
    ]);
    const suspended = await runTurn(f.deps, 1);
    expect(suspended.status).toBe("paused");
    if (suspended.status === "paused")
      expect(suspended.reason).toBe("step_limit");
    const done = await resume(f.deps);
    expect(done.status).toBe("done");
  });

  it("permission ask pauses; a fresh db handle resumes without re-executing completed work", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "kelson-db-")), "k.db");
    // One batch: ls (default allow, executes) + write (default ask, pauses).
    const f = fixture(
      [
        toolCallResponse([
          { id: "c-ls", name: "ls", input: { path: "." } },
          {
            id: "c-write",
            name: "write",
            input: { path: "out.txt", content: "hi" },
          },
        ]),
        textResponse("finished"),
      ],
      { dbPath },
    );
    const paused = await runTurn(f.deps);
    expect(paused.status).toBe("paused");
    if (paused.status === "paused")
      expect(paused.reason).toBe("permission:write");

    const lsResults = listEvents(f.db, f.sessionId).filter(
      (e) => e.kind === "tool_result" && e.payload.tool_call_id === "c-ls",
    );
    expect(lsResults.length).toBe(1);
    f.db.close();

    // Fresh process simulation: new Database object over the same file.
    const db2 = openDb(dbPath);
    const chain = reconstruct(listEvents(db2, f.sessionId));
    const request = chain.find((e) => e.kind === "permission_request");
    expect(request).toBeDefined();
    if (!request) return;
    answerPermission(db2, f.sessionId, request.id, "allow");

    const model2 = mockModel([textResponse("finished")]);
    const done = await resume({
      db: db2,
      sessionId: f.sessionId,
      entry: TEST_ENTRY,
      model: model2,
      tools: CORE_TOOLS,
      rules: [],
      ctx: { cwd: f.dir, exec: localExec(f.dir) },
    });
    expect(done.status).toBe("done");

    // Pre-pause work ran exactly once: still one ls result, one write result.
    const events = listEvents(db2, f.sessionId);
    expect(
      events.filter(
        (e) => e.kind === "tool_result" && e.payload.tool_call_id === "c-ls",
      ).length,
    ).toBe(1);
    expect(
      events.filter(
        (e) => e.kind === "tool_result" && e.payload.tool_call_id === "c-write",
      ).length,
    ).toBe(1);
  });
});
