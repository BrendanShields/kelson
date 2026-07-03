import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

describe("PERM-2: ask flow lives entirely in session events; always-allow is a scoped-rule event", () => {
  it("request, decision, and scoped-rule events land in order; the repeat call needs no new request; no config file appears", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "c1", name: "write", input: { path: "a.txt", content: "1" } },
      ]),
      toolCallResponse([
        { id: "c2", name: "write", input: { path: "b.txt", content: "2" } },
      ]),
      textResponse("done"),
    ]);
    const paused = await runTurn(f.deps);
    expect(paused.status).toBe("paused");

    const chain = reconstruct(listEvents(f.db, f.sessionId));
    const request = chain.find((e) => e.kind === "permission_request");
    expect(request).toBeDefined();
    if (!request) return;
    answerPermission(f.db, f.sessionId, request.id, "allow", true);

    const done = await resume({
      db: f.db,
      sessionId: f.sessionId,
      entry: TEST_ENTRY,
      model: f.model,
      tools: CORE_TOOLS,
      rules: [],
      ctx: { cwd: f.dir, exec: localExec(f.dir) },
    });
    expect(done.status).toBe("done");

    const events = listEvents(f.db, f.sessionId);
    const kindsInOrder = events
      .filter(
        (e) =>
          ["permission_request", "permission_decision"].includes(e.kind) ||
          (e.kind === "session_meta" && e.payload.scoped_rule !== undefined),
      )
      .map((e) => e.kind);
    expect(kindsInOrder).toEqual([
      "permission_request",
      "permission_decision",
      "session_meta",
    ]);

    // The second write (c2) proceeded under the scoped rule — one request total.
    expect(events.filter((e) => e.kind === "permission_request").length).toBe(
      1,
    );
    expect(
      events.filter(
        (e) => e.kind === "tool_result" && e.payload.tool_call_id === "c2",
      ).length,
    ).toBe(1);

    // Never a config-file write.
    expect(existsSync(join(f.dir, ".kelson", "permissions.json"))).toBe(false);
  });
});
