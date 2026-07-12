import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createChat, update } from "../../src/chat/model.js";
import { createSurface } from "../../src/chat/surface.js";
import { CHAT_THEME } from "../../src/chat/theme.js";
import {
  tickerLine,
  VIZ_COLS,
  VIZ_ROWS,
  vizFrame,
  vizPane,
} from "../../src/chat/view.js";

const allowed = new Set([...CHAT_THEME.glyphs.bar, CHAT_THEME.glyphs.sep, " "]);

describe("UX-36: agent visualizer — deterministic character field", () => {
  it("thinking frames are deterministic per tick and vary across ticks", () => {
    const a = vizFrame("thinking", 7);
    const b = vizFrame("thinking", 7);
    // revert-check: derive frames from Math.random or wall clock → toEqual
    // flakes (F-126).
    expect(a).toEqual(b);
    expect(a).not.toEqual(vizFrame("thinking", 8));
  });

  it("every frame is exactly 26×8 from bar/sep/space material only", () => {
    for (const [state, tick] of [
      ["idle", 0],
      ["paused", 0],
      ["thinking", 0],
      ["thinking", 13],
    ] as const) {
      const rows = vizFrame(state, tick);
      expect(rows).toHaveLength(VIZ_ROWS);
      for (const row of rows) {
        expect(row.length).toBe(VIZ_COLS);
        for (const ch of row) expect(allowed.has(ch)).toBe(true);
      }
    }
  });

  it("idle, paused, thinking@0 are pairwise distinct", () => {
    const idle = vizFrame("idle", 0).join("\n");
    const paused = vizFrame("paused", 0).join("\n");
    const thinking = vizFrame("thinking", 0).join("\n");
    expect(idle).not.toBe(paused);
    expect(idle).not.toBe(thinking);
    expect(paused).not.toBe(thinking);
  });

  it("OBLIGATO_NO_MOTION (empty string — presence) pins thinking to the tick-0 frame", () => {
    let m = update(createChat("mock-m"), { type: "submit", text: "go" }).model;
    for (let i = 0; i < 25; i++) m = update(m, { type: "tick" }).model;
    const still = vizPane(m, { OBLIGATO_NO_MOTION: "" });
    const moving = vizPane(m, {});
    const rows = (p: typeof still) => p.map((l) => l[0]?.text).join("\n");
    // revert-check: truthiness check on NO_MOTION → empty-string arm fails
    // (the F-198 boundary class).
    expect(rows(still)).toBe(vizFrame("thinking", 0).join("\n"));
    expect(rows(moving)).toBe(vizFrame("thinking", 25).join("\n"));
    expect(rows(still)).not.toBe(rows(moving));
  });

  it("120-col snapshot: /viz open while busy shows the pane and title", async () => {
    let m = update(createChat("mock-m"), {
      type: "submit",
      text: "/viz",
    }).model;
    expect(m.rail).toBe("viz");
    m = update(m, { type: "submit", text: "go" }).model;
    for (let i = 0; i < 5; i++) m = update(m, { type: "tick" }).model;
    const setup = await createTestRenderer({ width: 120, height: 24 });
    const surface = createSurface(setup.renderer, {});
    surface.update(m);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("viz");
    // The busy field's densest ramp glyph appears somewhere in the pane.
    expect(frame).toContain(CHAT_THEME.glyphs.bar[7] as string);
    setup.renderer.destroy();
  });

  it("reducer-driven paused wins over busy (F-212): vizPane renders the paused field, ticker says paused", () => {
    let m = update(createChat("mock-m"), { type: "submit", text: "go" }).model;
    expect(m.busy).toBe(true);
    m = update(m, {
      type: "paused",
      ask: { requestId: "r1", tool: "bash", arg: "x", rule: "default" },
    }).model;
    // busy is STILL true here — the production ask shape.
    expect(m.busy).toBe(true);
    const rows = vizPane(m, {})
      .map((l) => l[0]?.text)
      .join("\n");
    // revert-check: busy-first derivation → turbulence renders and both fail.
    expect(rows).toBe(vizFrame("paused", 0).join("\n"));
    expect(tickerLine(m).left).toContain("paused");
  });

  it("UX-32 truth-table extension: tree+/viz→viz; viz+/viz→closed", () => {
    let m = createChat("mock-m");
    m = update(m, { type: "submit", text: "/tree" }).model;
    m = update(m, { type: "submit", text: "/viz" }).model;
    expect(m.rail).toBe("viz");
    m = update(m, { type: "submit", text: "/viz" }).model;
    expect(m.rail).toBeNull();
  });
});
