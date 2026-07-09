import { describe, expect, it } from "bun:test";
import {
  createChat,
  renderChat,
  slashTargets,
  update,
} from "../../src/chat/model.ts";
import { COMMANDS } from "../../src/index.ts";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

describe("UX-14: chat is a pure reducer behind a thin shell; slash = typed dispatch; TTY only", () => {
  it("the reducer drives a full exchange headlessly", () => {
    let m = createChat("mock-m");
    let r = update(m, { type: "submit", text: "fix the bug" });
    m = r.model;
    expect(r.effects).toEqual([{ type: "send_user", text: "fix the bug" }]);
    expect(m.busy).toBe(true);

    m = update(m, { type: "delta", text: "look" }).model;
    m = update(m, { type: "delta", text: "ing…" }).model;
    m = update(m, { type: "tool_result", name: "read", ok: true }).model;
    m = update(m, { type: "delta", text: "fixed it" }).model;
    m = update(m, { type: "step_cost", costMicroUsd: 548 }).model;
    m = update(m, { type: "turn_done", status: "done" }).model;

    expect(m.busy).toBe(false);
    const view = renderChat(m);
    expect(view).toContain("> fix the bug");
    expect(view).toContain("looking…");
    expect(view).toContain("✓ read");
    expect(view).toContain("fixed it");
    expect(view).toContain("$0.0005");

    const paused = update(m, {
      type: "paused",
      ask: { requestId: "r1", tool: "write", arg: "a.txt", rule: "default" },
    }).model;
    const answered = update(paused, {
      type: "answer",
      decision: "allow",
      always: true,
    });
    expect(answered.effects).toEqual([
      {
        type: "answer_permission",
        requestId: "r1",
        decision: "allow",
        always: true,
      },
    ]);
  });

  it("a slash command's dispatch target IS the exported CLI function (identity)", () => {
    const targets = slashTargets(COMMANDS);
    expect(targets["/route"]).toBe(COMMANDS.route as never);
  });

  it("non-TTY chat exits non-zero naming kelson run", async () => {
    const t = makeTestRepo({ configured: false });
    const r = await runCli(t, ["chat"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("kelson run");
  }, 20_000);
});
