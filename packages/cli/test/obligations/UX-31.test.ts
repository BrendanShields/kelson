import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  type ChatModel,
  type ChatMsg,
  createChat,
  renderChat,
  update,
} from "../../src/chat/model.js";
import { createSurface } from "../../src/chat/surface.js";
import { CHAT_THEME } from "../../src/chat/theme.js";
import { tickerLine, transcriptLines } from "../../src/chat/view.js";

const g = CHAT_THEME.glyphs;
// Distinctive line content: "gamma" appears nowhere else in any frame, so
// expanded-visible / collapsed-absent assertions discriminate (audit W1).
const FIVE = "alpha\nbeta\ngamma\ndelta\nepsilon";
const FOUR = "1\n2\n3\n4";

const feed = (m: ChatModel, msgs: ChatMsg[]): ChatModel =>
  msgs.reduce((acc, msg) => update(acc, msg).model, m);

const withTools = (): ChatModel =>
  feed(createChat("mock-m", {}, []), [
    { type: "info", text: "start" },
    { type: "tool_result", name: "read", ok: true, output: FIVE },
    {
      type: "tool_result",
      name: "gates",
      ok: false,
      output: "a\nb\nc\nd\ne\nf",
    },
  ]);

describe("UX-31: transcript folds, focus nav, tick liveness", () => {
  it("a 5-line output folds: summary names tool, status glyph, count, keybind hint", () => {
    const view = renderChat(withTools());
    // revert-check: threshold > 5 (or >=) → this collapsed line disappears.
    expect(view).toContain(`${g.fold} read ${g.ok} 5 lines (enter expands)`);
    expect(view).toContain(`${g.fold} gates ${g.err} 6 lines (enter expands)`);
    expect(view).not.toContain("1\n2");
  });

  it("a 4-line output renders full with the header line; toggle_fold on it is a no-op", () => {
    const m = feed(createChat("mock-m", {}, []), [
      { type: "tool_result", name: "fmt", ok: true, output: FOUR },
    ]);
    const view = renderChat(m);
    // Divergence ruling: header line keeps tool provenance legible.
    expect(view).toContain(`${g.ok} fmt`);
    expect(view).toContain("1\n2\n3\n4");
    expect(view).not.toContain("lines (enter expands)");
    const r = update(m, { type: "toggle_fold", index: 0 });
    // revert-check: flip the flag on untoggleable entries → toBe fails.
    expect(r.model).toBe(m);
    expect(r.effects).toEqual([]);
  });

  it("toggle_fold expands then collapses — flag read back both times", () => {
    const m = withTools();
    const expanded = update(m, { type: "toggle_fold", index: 1 }).model;
    const entry = expanded.entries[1];
    expect(entry?.kind === "tool" && entry.expanded).toBe(true);
    expect(renderChat(expanded)).toContain(`${g.unfold} read ${g.ok} 5 lines`);
    expect(renderChat(expanded)).not.toContain("(enter expands)\n1");
    const collapsed = update(expanded, { type: "toggle_fold", index: 1 }).model;
    const back = collapsed.entries[1];
    expect(back?.kind === "tool" && back.expanded).toBe(false);
  });

  it("tab/j/k/enter: selection moves over foldables only, clamps, expands the target", () => {
    let m = withTools();
    m = feed(m, [{ type: "key", key: "tab" }]);
    expect(m.focus).toBe("transcript");
    // j: 0 → 1 (second foldable); second j clamps at the end.
    m = feed(m, [{ type: "key", key: "j" }]);
    expect(m.selected).toBe(1);
    const clamped = update(m, { type: "key", key: "j" });
    // revert-check: wrap instead of clamp → selected returns to 0 and toBe fails.
    expect(clamped.model).toBe(m);
    m = feed(m, [{ type: "key", key: "k" }]);
    expect(m.selected).toBe(0);
    const top = update(m, { type: "key", key: "k" });
    expect(top.model).toBe(m);
    m = feed(m, [
      { type: "key", key: "j" },
      { type: "key", key: "enter" },
    ]);
    // tool_result appends an assistant continuation row, so the transcript is
    // [info, read, assistant, gates, assistant] — gates sits at index 3.
    const gates = m.entries[3];
    expect(gates?.kind === "tool" && gates.expanded).toBe(true);
    const read = m.entries[1];
    expect(read?.kind === "tool" && read.expanded).toBe(false);
  });

  it("with zero foldables, enter emits nothing and changes nothing", () => {
    const m = feed(createChat("mock-m", {}, []), [
      { type: "info", text: "x" },
      { type: "key", key: "tab" },
    ]);
    const r = update(m, { type: "key", key: "enter" });
    expect(r.model).toBe(m);
    expect(r.effects).toEqual([]);
  });

  it("ticks: 25 busy ticks → spin[5] and 2s; idle tick is a same-reference no-op; busy end resets", () => {
    let m = feed(createChat("mock-m", {}, []), [
      { type: "submit", text: "go" },
    ]);
    for (let i = 0; i < 25; i++) m = update(m, { type: "tick" }).model;
    expect(m.tickCount).toBe(25);
    const ticker = tickerLine(m);
    // revert-check: derive elapsed from wall clock instead of ticks → the
    // exact frame/seconds assertions below flake (F-126 determinism).
    expect(ticker.left).toContain(g.spin[25 % g.spin.length] as string);
    expect(ticker.left).toContain("2s");
    m = update(m, { type: "turn_done", status: "done" }).model;
    expect(m.tickCount).toBe(0);
    expect(tickerLine(m).left).toContain("ready");
    const idle = update(m, { type: "tick" });
    expect(idle.model).toBe(m);
  });

  it("collapsed vs expanded 80-column snapshot pair", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const surface = createSurface(setup.renderer, {});
    const collapsed = withTools();
    surface.update(collapsed);
    await setup.renderOnce();
    const before = setup.captureCharFrame();
    expect(before).toContain("(enter expands)");
    // revert-check: render output under the collapsed summary → "gamma" shows.
    expect(before).not.toContain("gamma");

    surface.update(update(collapsed, { type: "toggle_fold", index: 1 }).model);
    await setup.renderOnce();
    const after = setup.captureCharFrame();
    expect(after).toContain(`${g.unfold} read`);
    // Verbatim output line visible only in the expanded frame (audit W1).
    expect(after).toContain("gamma");
    setup.renderer.destroy();
  });

  it("accent role on the selected summary requires transcript focus", () => {
    let m = withTools();
    m = feed(m, [{ type: "key", key: "tab" }]);
    const roleOfSummary = (model: ChatModel): string | null => {
      const line = transcriptLines(model).find((l) =>
        l.some((s) => s.text.includes(`${g.fold} read`)),
      );
      return line?.[0]?.role ?? null;
    };
    // revert-check: drop the focus gate in transcriptLines → the second
    // assertion sees "accent" while input-focused.
    expect(roleOfSummary(m)).toBe("accent");
    m = feed(m, [{ type: "key", key: "tab" }]);
    expect(m.focus).toBe("input");
    expect(roleOfSummary(m)).toBe("tool");
  });

  // Tail-follow arms live in UX-30.test.ts — UX-30's clause owns them.
});
