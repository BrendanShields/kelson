import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTurn } from "../../src/loop.ts";
import { type AgentTool, CORE_TOOLS, localExec } from "../../src/tools.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";

describe("AGT-4: exactly the eight core tools, confined to the caller-supplied ToolContext", () => {
  it("ships read/write/edit/bash/grep/find/ls/todo and nothing else", () => {
    // AGT-19 amendment 2026-07-20: todo joins the registry.
    expect(CORE_TOOLS.map((t) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "todo",
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

  it("a symlink pointing outside the workspace is refused for file tools (realpath containment)", async () => {
    const f = fixture([
      toolCallResponse([
        {
          id: "c-ln",
          name: "bash",
          input: { command: "ln -s .. obligato-up" },
        },
        {
          id: "c-esc",
          name: "write",
          input: { path: "obligato-up/obligato-escape.txt", content: "x" },
        },
        {
          id: "c-in",
          name: "write",
          input: { path: "inside.txt", content: "ok" },
        },
      ]),
      textResponse("done"),
    ]);
    f.deps.rules = [
      { tool: "bash", action: "allow" },
      { tool: "write", action: "allow" },
    ];
    await runTurn(f.deps);

    const byId = new Map(
      (
        f.db
          .query(
            "SELECT payload FROM session_event WHERE session_id = ? AND kind = 'tool_result' ORDER BY rowid",
          )
          .all(f.sessionId) as { payload: string }[]
      )
        .map((r) => JSON.parse(r.payload))
        // biome-ignore lint/suspicious/noExplicitAny: parsed fixture payload
        .map((p: any) => [p.tool_call_id, p] as const),
    );
    // The write follows the in-workspace symlink out of cwd → refused, nothing
    // written outside the root (lexical `..`-prefix checks miss this).
    expect(byId.get("c-esc")?.is_error).toBe(true);
    expect(existsSync(resolve(f.dir, "..", "obligato-escape.txt"))).toBe(false);
    // A normal in-workspace write still succeeds — the realpath'd cwd baseline
    // does not spuriously reject.
    expect(byId.get("c-in")?.is_error).toBeFalsy();
    expect(existsSync(resolve(f.dir, "inside.txt"))).toBe(true);
  });

  it("symlink refusal covers each of read/write/edit/ls (the obligation names all four)", async () => {
    const f = fixture([
      toolCallResponse([
        { id: "s-ln", name: "bash", input: { command: "ln -s .. up" } },
        { id: "s-read", name: "read", input: { path: "up/outside.txt" } },
        {
          id: "s-write",
          name: "write",
          input: { path: "up/outside.txt", content: "x" },
        },
        {
          id: "s-edit",
          name: "edit",
          input: { path: "up/outside.txt", old: "a", new: "b" },
        },
        { id: "s-ls", name: "ls", input: { path: "up" } },
      ]),
      textResponse("done"),
    ]);
    f.deps.rules = [
      { tool: "bash", action: "allow" },
      { tool: "write", action: "allow" },
      { tool: "edit", action: "allow" },
    ];
    await runTurn(f.deps);
    const byId = new Map(
      (
        f.db
          .query(
            "SELECT payload FROM session_event WHERE session_id = ? AND kind = 'tool_result' ORDER BY rowid",
          )
          .all(f.sessionId) as { payload: string }[]
      )
        .map((r) => JSON.parse(r.payload))
        // biome-ignore lint/suspicious/noExplicitAny: parsed fixture payload
        .map((p: any) => [p.tool_call_id, p] as const),
    );
    for (const id of ["s-read", "s-write", "s-edit", "s-ls"]) {
      expect(byId.get(id)?.is_error).toBe(true);
      expect(String(byId.get(id)?.output)).toContain("escapes the workspace");
    }
    expect(existsSync(resolve(f.dir, "..", "outside.txt"))).toBe(false);
  });

  it("a fully-nonexistent absolute path re-attaches without eating a character (root off-by-one)", () => {
    // Pre-fix, the tail component reconstructed at the root lost its first
    // char ("/xprivate/…" → "private/…"), so /x<realCwd>/f re-attached to
    // exactly <realCwd>/f — an aliased write ACCEPTED inside the workspace at
    // a path the model never named (audit 2026-07-05).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "obligato-agent-")));
    const write = CORE_TOOLS.find((t) => t.name === "write") as AgentTool;
    const alias = `/x${dir.slice(1)}/obligato-alias-probe.txt`;
    expect(() =>
      write.run(
        { path: alias, content: "x" },
        { cwd: dir, exec: localExec(dir) },
      ),
    ).toThrow("escapes the workspace");
    expect(existsSync(join(dir, "obligato-alias-probe.txt"))).toBe(false);
  });
});
