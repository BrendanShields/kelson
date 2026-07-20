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
import { CHAT_THEME, markdownStyles } from "../../src/chat/theme.js";
import { transcriptEntryLines, transcriptLines } from "../../src/chat/view.js";

const MD = "# heading\n\nsome **bold** words";

const withAssistant = (text: string): ChatModel => {
  let m = update(createChat("mock-m", {}, []), {
    type: "submit",
    text: "go",
  }).model;
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
    const m = update(createChat("mock-m", {}, []), {
      type: "submit",
      text: "x",
    }).model;
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
    let m = update(createChat("mock-m", {}, []), {
      type: "info",
      text: "note",
    }).model;
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

    // UX-35 themed wiring (audit W2): the mounted renderable's SyntaxStyle
    // carries the theme map — an unstyled SyntaxStyle.create() reversion
    // registers no styles and fails here.
    const md = scrollBox.content.getRenderable("e1-md") as unknown as {
      syntaxStyle: { getStyle: (n: string) => { bold?: boolean } | undefined };
    };
    expect(md.syntaxStyle.getStyle("markup.strong")?.bold).toBe(true);
    setup.renderer.destroy();
  });
});

// UX-35 theme arms (2026-07-20): the token style map — values read from the
// CHAT_THEME export (single source, F-031 independence), NO_COLOR drops every
// fg/bg while attributes stay.
describe("UX-35: themed markdown token styles", () => {
  it("markdownStyles({}) returns exactly the six pinned entries with theme-sourced colors", () => {
    const styles = markdownStyles({});
    expect(Object.keys(styles).sort()).toEqual(
      [
        "markup.heading",
        "markup.italic",
        "markup.link.url",
        "markup.raw",
        "markup.raw.block",
        "markup.strong",
      ].sort(),
    );
    expect(styles["markup.heading"]).toEqual({ bold: true, underline: true });
    expect(styles["markup.strong"]).toEqual({ bold: true });
    expect(styles["markup.italic"]).toEqual({ italic: true });
    // revert-check: hardcode a hex in markdownStyles → drifts from the theme
    // export and these fail naming the token.
    expect(styles["markup.raw"]).toEqual({
      fg: CHAT_THEME.colors.tool,
      bg: CHAT_THEME.colors.surface,
    });
    expect(styles["markup.raw.block"]).toEqual({
      fg: CHAT_THEME.colors.tool,
      bg: CHAT_THEME.colors.surface,
    });
    expect(styles["markup.link.url"]).toEqual({
      fg: CHAT_THEME.colors.accent,
      underline: true,
    });
  });

  it("NO_COLOR (presence, not truthiness) strips every fg/bg and keeps every attribute", () => {
    for (const env of [{ NO_COLOR: "" }, { NO_COLOR: "1" }]) {
      const styles = markdownStyles(env);
      const colored = markdownStyles({});
      expect(Object.keys(styles).sort()).toEqual(Object.keys(colored).sort());
      for (const [name, style] of Object.entries(styles)) {
        // revert-check: pass raw CHAT_THEME colors instead of resolveColor →
        // fg/bg survive under NO_COLOR and this fails on markup.raw.
        expect(style.fg).toBeUndefined();
        expect(style.bg).toBeUndefined();
        const full = colored[name] as Record<string, unknown>;
        for (const attr of ["bold", "italic", "underline"] as const)
          expect(style[attr]).toBe(full[attr] as boolean | undefined);
      }
    }
  });
});
