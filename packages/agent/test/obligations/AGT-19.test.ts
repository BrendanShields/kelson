import { describe, expect, it } from "bun:test";
import { type AgentTool, CORE_TOOLS } from "../../src/tools.ts";

const todo = CORE_TOOLS.find((t) => t.name === "todo") as AgentTool;
// ToolContext is unused by the tool (pure function of its input) — a throwing
// exec proves it: any process/filesystem reach would blow up here.
const ctx = {
  cwd: "/nonexistent",
  exec: () => {
    throw new Error("todo must not touch the ToolContext");
  },
};

describe("AGT-19: todo tool — canonical serialization, replacement semantics, pure", () => {
  it("one item of each state serializes to the three pinned lines in order", () => {
    const out = todo.run(
      {
        items: [
          { text: "scan repo", state: "done" },
          { text: "fix bug", state: "active" },
          { text: "write test", state: "pending" },
        ],
      },
      ctx as never,
    );
    // revert-check: reorder or restyle markers → exact-string compare fails.
    expect(out).toBe("[x] scan repo\n[>] fix bug\n[ ] write test");
  });

  it("empty items returns the literal (no tasks)", () => {
    expect(todo.run({ items: [] }, ctx as never)).toBe("(no tasks)");
  });

  it("an invalid state fails schema parse (the loop's invalid-input path)", () => {
    const parsed = todo.params.safeParse({
      items: [{ text: "x", state: "doing" }],
    });
    expect(parsed.success).toBe(false);
    // Empty text also rejected — the clause pins non-empty.
    expect(
      todo.params.safeParse({ items: [{ text: "", state: "done" }] }).success,
    ).toBe(false);
    // Line-forgery arm (audit 2026-07-20): embedded \n would serialize to two
    // lines and forge a phantom item in the UX-36 parser.
    expect(
      todo.params.safeParse({
        items: [{ text: "a\n[x] fake", state: "done" }],
      }).success,
    ).toBe(false);
  });

  it("primaryArg reports the item count", () => {
    expect(todo.primaryArg({ items: [{}, {}] })).toBe("2 items");
  });
});
