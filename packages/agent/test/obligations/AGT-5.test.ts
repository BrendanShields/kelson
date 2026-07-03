import { describe, expect, it } from "bun:test";
import { resume, runTurn } from "../../src/loop.ts";
import { listEvents, SessionNotPausedError } from "../../src/sessions.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";

describe("AGT-5: resume refuses non-paused sessions with a distinct error and appends nothing", () => {
  it("resume on a done session raises SessionNotPausedError and the row count is unchanged", async () => {
    const f = fixture([textResponse("done")]);
    await runTurn(f.deps);
    const before = listEvents(f.db, f.sessionId).length;
    expect(resume(f.deps)).rejects.toBeInstanceOf(SessionNotPausedError);
    const after = listEvents(f.db, f.sessionId).length;
    expect(after).toBe(before);
  });

  it("resume on a paused session proceeds normally", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "c1", name: "write", input: { path: "a.txt", content: "x" } },
      ]),
      textResponse("done"),
    ]);
    const paused = await runTurn(f.deps);
    expect(paused.status).toBe("paused");
    // Answer by rule rather than decision: allow write going forward.
    f.deps.rules = [{ tool: "write", action: "allow" }];
    const result = await resume(f.deps);
    expect(result.status).toBe("done");
  });
});
