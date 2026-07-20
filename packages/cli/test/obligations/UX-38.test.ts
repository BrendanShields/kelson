import { describe, expect, it } from "bun:test";
import { SelectRenderableEvents } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createCommandMenu, handleEscape } from "../../src/chat/menu.js";
import { createChat, MENU_ITEMS, update } from "../../src/chat/model.js";

describe("UX-38: command menu — /help opens, unknown slash errors + opens, esc closes not exits", () => {
  it("/help yields exactly one menu effect and appends nothing — twice", () => {
    const m0 = createChat("mock-m", {}, []);
    const r1 = update(m0, { type: "submit", text: "/help" });
    // revert-check: restore the HELP_TEXT info append → entries grow and
    // the deep-equal fails.
    expect(r1.effects).toEqual([{ type: "menu" }]);
    expect(r1.model.entries).toEqual(m0.entries);
    const r2 = update(r1.model, { type: "submit", text: "/help" });
    expect(r2.effects).toEqual([{ type: "menu" }]);
    expect(r2.model.entries).toEqual(m0.entries);
  });

  it("MENU_ITEMS is exactly the seven commands, every description non-empty", () => {
    expect(MENU_ITEMS.map((m) => m.command)).toEqual([
      "/help",
      "/model",
      "/route",
      "/budget",
      "/tree",
      "/viz",
      "/exit",
    ]);
    for (const m of MENU_ITEMS) expect(m.description.length).toBeGreaterThan(0);
  });

  it("unknown slash appends the UX-37 error entry AND emits menu; known dispatch stays clean", () => {
    const m0 = createChat("mock-m", {}, ["/route"]);
    const bad = update(m0, { type: "submit", text: "/clear" });
    expect(bad.effects).toEqual([{ type: "menu" }]);
    const last = bad.model.entries[bad.model.entries.length - 1];
    // revert-check: route unknowns to the shell dispatch branch → no entry
    // appends here and headline is absent.
    expect(last?.kind).toBe("error");
    expect(last?.kind === "error" && last.headline).toBe(
      "unknown command /clear",
    );
    const good = update(m0, { type: "submit", text: "/route --json" });
    expect(good.effects).toEqual([
      { type: "dispatch", command: "route", argv: ["--json"] },
    ]);
    expect(good.model.entries).toEqual(m0.entries);
  });

  it("renders the commands panel with all rows + hint; enter runs; close dismounts", async () => {
    const setup = await createTestRenderer({ width: 80, height: 30 });
    const runs: string[] = [];
    let closed = 0;
    const menu = createCommandMenu(
      setup.renderer,
      {},
      (cmd) => runs.push(cmd),
      () => {
        closed++;
      },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("commands");
    for (const m of MENU_ITEMS) expect(frame).toContain(m.command);
    expect(frame).toContain("↑↓ move · enter run · esc close");
    expect(menu.mounted()).toBe(true);

    const select = setup.renderer.root
      .getRenderable("cmd-menu")
      ?.getRenderable("cmd-menu-select") as unknown as {
      emit: (ev: string, i: number, opt: { value: string }) => void;
    };
    select.emit(SelectRenderableEvents.ITEM_SELECTED, 3, {
      value: "/budget",
    });
    // revert-check: leave the panel mounted on select → mounted() stays true.
    expect(menu.mounted()).toBe(false);
    expect(runs).toEqual(["/budget"]);
    expect(closed).toBe(0);
    setup.renderer.destroy();
  });

  it("esc guard: mounted menu closes (onClose fires, no exit); no menu exits", async () => {
    const setup = await createTestRenderer({ width: 80, height: 30 });
    let closed = 0;
    let exited = 0;
    const menu = createCommandMenu(
      setup.renderer,
      {},
      () => {},
      () => {
        closed++;
      },
    );
    handleEscape(menu, false, () => {
      exited++;
    });
    // revert-check: restore the unconditional esc-exits binding → exited
    // increments here and this fails.
    expect(menu.mounted()).toBe(false);
    expect(closed).toBe(1);
    expect(exited).toBe(0);
    // Ask-menu mounted: esc is suppressed entirely — no close, no exit.
    // revert-check: drop the askMounted branch → exited increments.
    handleEscape(null, true, () => {
      exited++;
    });
    expect(exited).toBe(0);
    handleEscape(null, false, () => {
      exited++;
    });
    expect(exited).toBe(1);
    handleEscape(menu, false, () => {
      exited++;
    });
    expect(exited).toBe(2);
    setup.renderer.destroy();
  });
});
