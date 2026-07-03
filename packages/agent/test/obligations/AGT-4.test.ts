import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runTurn } from "../../src/loop.ts";
import { CORE_TOOLS } from "../../src/tools.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";

describe("AGT-4: exactly the seven core tools, confined to the caller-supplied ToolContext", () => {
  it("ships read/write/edit/bash/grep/find/ls and nothing else", () => {
    expect(CORE_TOOLS.map((t) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  it("bash runs in the context cwd; a path escape is an error result, not a write", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "c-pwd", name: "bash", input: { command: "pwd" } },
        {
          id: "c-esc",
          name: "write",
          input: { path: "../escape.txt", content: "x" },
        },
      ]),
      textResponse("done"),
    ]);
    // bash defaults to ask — allow it for this fixture via a rule.
    f.deps.rules = [
      { tool: "bash", action: "allow" },
      { tool: "write", action: "allow" },
    ];
    await runTurn(f.deps);

    const results = f.db
      .query(
        "SELECT payload FROM session_event WHERE session_id = ? AND kind = 'tool_result' ORDER BY rowid",
      )
      .all(f.sessionId) as { payload: string }[];
    const payloads = results.map((r) => JSON.parse(r.payload));

    // Execution order by rowid matches request order.
    expect(payloads.map((p) => p.tool_call_id)).toEqual(["c-pwd", "c-esc"]);
    // pwd observed inside the temp root.
    expect(String(payloads[0].output).trim()).toBe(f.dir);
    // The escape attempt errored and wrote nothing outside the root.
    expect(payloads[1].is_error).toBe(true);
    expect(existsSync(resolve(f.dir, "..", "escape.txt"))).toBe(false);
  });
});
