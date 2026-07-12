import { describe, expect, it } from "bun:test";
import { WidgetTree } from "@obligato/schemas";
import { createTestRenderer } from "@opentui/core/testing";
import { compose } from "../../src/chat/compose.js";
import {
  type ChatEntry,
  type ChatModel,
  createChat,
  update,
} from "../../src/chat/model.js";
import { createSurface } from "../../src/chat/surface.js";
import { transcriptEntryLines, transcriptLines } from "../../src/chat/view.js";

const MD = "# heading\n\nsome **bold** words";

const withAssistant = (text: string): ChatModel => {
  let m = update(createChat("mock-m"), { type: "submit", text: "go" }).model;
  m = update(m, { type: "delta", text }).model;
  return m;
};

describe("UX-35: pure composer — rule table, markdown rule, identity fallback", () => {
  it("deterministic and total: every entry yields a decision, twice deep-equal", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", text: MD },
      { kind: "assistant", text: "" },
      { kind: "info", text: "note" },
      { kind: "tool", name: "read", ok: true, output: "x", expanded: false },
    ];
    for (const e of entries) {
      const a = compose(e);
      const b = compose(e);
      expect(a).toEqual(b);
      expect(["widget", "identity"]).toContain(a.kind);
    }
  });

  it("non-empty assistant → markdown widget whose envelope parses (F-031: test's own schema call)", () => {
    const d = compose({ kind: "assistant", text: MD });
    expect(d.kind).toBe("widget");
    if (d.kind === "widget") {
      const parsed = WidgetTree.parse(JSON.parse(JSON.stringify(d.tree)));
      expect(parsed.root).toEqual({ type: "markdown", content: MD });
    }
  });

  it("empty assistant composes to identity with zero lines (unchanged behavior)", () => {
    expect(compose({ kind: "assistant", text: "" }).kind).toBe("identity");
    // W2: the "yields nothing" half asserted discriminatingly (F-100).
    const m = update(createChat("mock-m"), { type: "submit", text: "x" }).model;
    // entries: [user, assistant ""] — index 1 renders zero lines.
    expect(transcriptEntryLines(m, 1)).toEqual([]);
    // W1: user entries are identity, never widget.
    expect(compose({ kind: "user", text: "hi" }).kind).toBe("identity");
    expect(compose({ kind: "info", text: "n" }).kind).toBe("identity");
    expect(
      compose({
        kind: "tool",
        name: "r",
        ok: true,
        output: "x",
        expanded: false,
      }).kind,
    ).toBe("identity");
  });

  it("identity entries render byte-identical to UX-31's transcriptLines", () => {
    let m = update(createChat("mock-m"), { type: "info", text: "note" }).model;
    m = update(m, {
      type: "tool_result",
      name: "read",
      ok: true,
      output: "a\nb\nc\nd\ne",
    }).model;
    // Entries 0 (info) and 1 (tool) are identity; per-entry concatenation
    // must equal the aggregate view (one fold implementation, F-085).
    const perEntry = m.entries.flatMap((e, i) =>
      compose(e).kind === "identity" ? transcriptEntryLines(m, i) : [],
    );
    const aggregate = transcriptLines(m);
    expect(perEntry).toEqual(aggregate);
  });

  it("markdown actually renders: ** and # markers absent, words present; delta updates the same keyed node", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const surface = createSurface(setup.renderer, {});
    const m = withAssistant(MD);
    surface.update(m);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("bold");
    expect(frame).toContain("heading");
    // revert-check: render assistant text as plain lines (identity) → the
    // literal ** markers survive and this fails. (# heading markers are
    // OpenTUI's own heading style — kept visually, not asserted.)
    expect(frame).not.toContain("**");

    // Streaming: a delta mutates the same entry — keyed node updates in
    // place. W3: assert the NODE REFERENCE survives (a remount with the same
    // id would produce an identical frame — frames can't discriminate).
    const scrollBox = setup.renderer.root
      .getRenderable("chat-middle")
      ?.getRenderable("chat-scroll") as unknown as {
      content: { getRenderable: (id: string) => unknown };
    };
    const nodeBefore = scrollBox.content.getRenderable("e1-md");
    expect(nodeBefore).toBeDefined();
    const m2 = update(m, { type: "delta", text: " and *more*" }).model;
    surface.update(m2);
    await setup.renderOnce();
    const frame2 = setup.captureCharFrame();
    expect(frame2).toContain("more");
    expect(frame2).not.toContain("*more*");
    // revert-check: remove-and-remount markdown nodes in setBody → toBe fails.
    expect(scrollBox.content.getRenderable("e1-md")).toBe(nodeBefore);
    setup.renderer.destroy();
  });
});
