import { describe, expect, it } from "bun:test";
import {
  askProvenanceLabel,
  askRuleOf,
  createChat,
  renderChat,
  update,
} from "../../src/chat/model.js";

describe("PERM-4: the rendered ask names the tool, primary arg, and provenance", () => {
  it("a matched rule's globs and action render with the ask", () => {
    const m = update(createChat("mock-m"), {
      type: "paused",
      ask: {
        requestId: "r1",
        tool: "write",
        arg: "a.txt",
        rule: { tool: "write", arg: "a.*", action: "ask" },
      },
    }).model;
    const view = renderChat(m);
    expect(view).toContain("write");
    expect(view).toContain("a.txt");
    expect(view).toContain("rule: write(a.*) → ask");
  });

  it("an unmatched-default ask renders the default provenance", () => {
    const m = update(createChat("mock-m"), {
      type: "paused",
      ask: { requestId: "r2", tool: "bash", arg: "rm -rf x", rule: "default" },
    }).model;
    expect(renderChat(m)).toContain("no rule matched — default ask");
    expect(askProvenanceLabel("default")).toBe("no rule matched — default ask");
  });

  it("a rule with no arg glob renders without parens", () => {
    expect(askProvenanceLabel({ tool: "bash", action: "ask" })).toBe(
      "rule: bash → ask",
    );
  });

  it("askRuleOf reads the exact payload shape the loop writes (identity across the seam)", () => {
    // Mirrors loop.ts's permission_request payload verbatim — a payload
    // shape drift must fail here, not silently render "default".
    const payload = {
      tool_call_id: "c1",
      tool: "write",
      arg: "a.txt",
      rule: { tool: "write", arg: "a.*", action: "ask" },
      reason: "permission:write",
    };
    expect(askRuleOf(payload.rule)).toEqual({
      tool: "write",
      arg: "a.*",
      action: "ask",
    });
    expect(askRuleOf("default")).toBe("default");
    expect(askRuleOf(undefined)).toBe("default");
  });
});
