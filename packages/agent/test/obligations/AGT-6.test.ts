import { describe, expect, it } from "bun:test";
import {
  answerPermission,
  runTurn,
  validatePauseReason,
} from "../../src/loop.ts";
import { lifecycle, listEvents, reconstruct } from "../../src/sessions.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";

describe("AGT-6: non-empty pause reasons; lifecycle derives from the chain with no pause kind", () => {
  it("an empty-string reason is rejected with a validation error", () => {
    expect(() => validatePauseReason("")).toThrow(/non-empty/);
    expect(validatePauseReason("permission:write")).toBe("permission:write");
  });

  it("derivation discriminates: unanswered ask, answered ask, and resolved suspension are all paused; final answer is done; fresh is active", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "c1", name: "write", input: { path: "a.txt", content: "x" } },
      ]),
      textResponse("done"),
    ]);
    // Fresh session (no assistant message yet) → active.
    expect(lifecycle(reconstruct(listEvents(f.db, f.sessionId)))).toBe(
      "active",
    );

    // Unanswered ask → paused.
    const paused = await runTurn(f.deps);
    expect(paused.status).toBe("paused");
    let chain = reconstruct(listEvents(f.db, f.sessionId));
    expect(lifecycle(chain)).toBe("paused");

    // Answered-but-unexecuted ask (the AGT-2 resume case) → still paused.
    const request = chain.find((e) => e.kind === "permission_request");
    if (!request) throw new Error("no request");
    answerPermission(f.db, f.sessionId, request.id, "allow");
    chain = reconstruct(listEvents(f.db, f.sessionId));
    expect(lifecycle(chain)).toBe("paused");

    // All-results-landed suspension (step limit hit before the next model
    // call) → still paused, resumable.
    const suspended = await runTurn(f.deps, 1);
    expect(suspended.status).toBe("paused");
    if (suspended.status === "paused")
      expect(suspended.reason).toBe("step_limit");
    chain = reconstruct(listEvents(f.db, f.sessionId));
    expect(lifecycle(chain)).toBe("paused");

    // Final answer → done.
    const done = await runTurn(f.deps);
    expect(done.status).toBe("done");
    chain = reconstruct(listEvents(f.db, f.sessionId));
    expect(lifecycle(chain)).toBe("done");

    // No pause-specific kind ever appeared.
    const kinds = new Set(listEvents(f.db, f.sessionId).map((e) => e.kind));
    expect([...kinds].sort()).toEqual([
      "assistant_message",
      "head_moved",
      "permission_decision",
      "permission_request",
      "session_meta",
      "tool_result",
      "user_message",
    ]);
  });
});
