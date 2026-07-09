import { describe, expect, it } from "bun:test";
import { runTurn } from "../../src/loop.ts";
import { listEvents } from "../../src/sessions.ts";
import { fixture, toolCallResponse } from "../helpers.ts";

const requestOf = (f: ReturnType<typeof fixture>) =>
  listEvents(f.db, f.sessionId).find((e) => e.kind === "permission_request");

describe("PERM-4: the permission_request payload carries the ask's provenance", () => {
  it("a matched rule's globs and action land verbatim in the payload", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "p4a", name: "write", input: { path: "a.txt", content: "1" } },
      ]),
    ]);
    f.deps.rules = [{ tool: "write", arg: "a.*", action: "ask" }];
    const result = await runTurn(f.deps);
    expect(result.status).toBe("paused");
    const request = requestOf(f);
    expect(request).toBeDefined();
    // revert-check: without the provenance field this reads undefined.
    expect(request?.payload.rule).toEqual({
      tool: "write",
      arg: "a.*",
      action: "ask",
    });
  });

  it("an unmatched ask records the literal default", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "p4b", name: "write", input: { path: "b.txt", content: "2" } },
      ]),
    ]);
    const result = await runTurn(f.deps);
    expect(result.status).toBe("paused");
    expect(requestOf(f)?.payload.rule).toBe("default");
  });
});
