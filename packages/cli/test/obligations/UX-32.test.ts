import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { type ChatModel, createChat, update } from "../../src/chat/model.js";
import { createSurface } from "../../src/chat/surface.js";

const submit = (m: ChatModel, text: string): ChatModel =>
  update(m, { type: "submit", text }).model;

describe("UX-32: rail — toggle truth-table, 30-col pane, width gate", () => {
  it("toggle truth-table: closed+/budget→budget; budget+/tree→tree; tree+/tree→closed", () => {
    let m = createChat("mock-m", {}, []);
    expect(m.rail).toBeNull();
    m = submit(m, "/budget");
    expect(m.rail).toBe("budget");
    m = submit(m, "/tree");
    expect(m.rail).toBe("tree");
    // revert-check: make same-tab a no-op instead of close → this fails.
    m = submit(m, "/tree");
    expect(m.rail).toBeNull();
    m = submit(m, "/budget");
    m = submit(m, "/budget");
    expect(m.rail).toBeNull();
  });

  it("120 cols: open rail renders the titled pane beside the transcript; 80 cols hides it; reopening at width restores it", async () => {
    let m = update(createChat("mock-m", {}, []), {
      type: "info",
      text: "transcript-line",
    }).model;
    m = submit(m, "/budget");
    expect(m.rail).toBe("budget");

    const wide = await createTestRenderer({ width: 120, height: 20 });
    const wideSurface = createSurface(wide.renderer, {});
    wideSurface.update(m);
    await wide.renderOnce();
    const wideFrame = wide.captureCharFrame();
    expect(wideFrame).toContain("budget");
    expect(wideFrame).toContain("no steps yet");
    expect(wideFrame).toContain("transcript-line");

    const narrow = await createTestRenderer({ width: 80, height: 20 });
    const narrowSurface = createSurface(narrow.renderer, {});
    narrowSurface.update(m);
    await narrow.renderOnce();
    const narrowFrame = narrow.captureCharFrame();
    // revert-check: drop the >=100 width gate → "no steps yet" leaks into
    // the 80-col frame and this fails.
    expect(narrowFrame).not.toContain("no steps yet");
    expect(narrowFrame).toContain("transcript-line");

    // Same model, wide again: tab state persisted, pane restored.
    const wide2 = await createTestRenderer({ width: 120, height: 20 });
    const surface2 = createSurface(wide2.renderer, {});
    surface2.update(m);
    await wide2.renderOnce();
    expect(wide2.captureCharFrame()).toContain("no steps yet");
    wide.renderer.destroy();
    narrow.renderer.destroy();
    wide2.renderer.destroy();
  });

  it("live resize re-evaluates the gate with no dispatch between (F-205)", async () => {
    let m = update(createChat("mock-m", {}, []), {
      type: "info",
      text: "transcript-line",
    }).model;
    m = submit(m, "/budget");
    const setup = await createTestRenderer({ width: 120, height: 20 });
    const surface = createSurface(setup.renderer, {});
    // Mirror app.ts wiring: resize triggers a redraw of the same model.
    setup.renderer.on("resize", () => surface.update(m));
    surface.update(m);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("no steps yet");

    // revert-check: drop the renderer.on("resize", redraw) wiring → the pane
    // survives the shrink and this not-contains fails.
    setup.renderer.resize(80, 20);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("no steps yet");

    setup.renderer.resize(120, 20);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("no steps yet");
    setup.renderer.destroy();
  });
});
