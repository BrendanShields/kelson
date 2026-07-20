// UX-36 loop-side arm (pointer recorded in the clause's obligation — the
// onToolStart callback is loop machinery, so its fixture lives here while the
// reducer/pane arms live in packages/cli/test/obligations/UX-36.test.ts).
import { describe, expect, it } from "bun:test";
import { answerPermission, resume, runTurn } from "../../src/loop.ts";
import { listEvents, reconstruct } from "../../src/sessions.ts";
import { CORE_TOOLS, localExec } from "../../src/tools.ts";
import {
  fixture,
  TEST_ENTRY,
  textResponse,
  toolCallResponse,
} from "../helpers.ts";

describe("UX-36: onToolStart fires exactly once per resolved call across ask/pause/resume", () => {
  it("a permission-asked write fires one start, paired 1:1 with tool_results", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "c1", name: "write", input: { path: "a.txt", content: "1" } },
      ]),
      textResponse("done"),
    ]);
    const starts: string[] = [];
    const results: string[] = [];
    const deps = {
      ...f.deps,
      onToolStart: (name: string) => void starts.push(name),
      onToolResult: (name: string) => void results.push(name),
    };
    const paused = await runTurn(deps);
    expect(paused.status).toBe("paused");
    // revert-check: fire before permission evaluation → this is already 1
    // here and ends at 2 below (the double-fire orphan, audit 2026-07-20).
    expect(starts).toEqual([]);

    const chain = reconstruct(listEvents(f.db, f.sessionId));
    const request = chain.find((e) => e.kind === "permission_request");
    if (!request) throw new Error("no permission_request appended");
    answerPermission(f.db, f.sessionId, request.id, "allow", false);

    const done = await resume({
      db: f.db,
      sessionId: f.sessionId,
      entry: TEST_ENTRY,
      model: f.model,
      tools: CORE_TOOLS,
      rules: [],
      ctx: { cwd: f.dir, exec: localExec(f.dir) },
      onToolStart: (name: string) => void starts.push(name),
      onToolResult: (name: string) => void results.push(name),
    });
    expect(done.status).toBe("done");
    expect(starts).toEqual(["write"]);
    // Every fired start is completed by exactly one tool_result.
    expect(results).toEqual(["write"]);
  });

  it("a denied call still fires its start, paired with the denied result", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "c1", name: "bash", input: { command: "echo hi" } },
      ]),
      textResponse("done"),
    ]);
    const starts: string[] = [];
    const results: { name: string; ok: boolean }[] = [];
    f.deps.rules = [{ tool: "bash", action: "deny" }];
    await runTurn({
      ...f.deps,
      onToolStart: (name: string) => void starts.push(name),
      onToolResult: (name: string, ok: boolean) =>
        void results.push({ name, ok }),
    });
    expect(starts).toEqual(["bash"]);
    expect(results).toEqual([{ name: "bash", ok: false }]);
  });
});
