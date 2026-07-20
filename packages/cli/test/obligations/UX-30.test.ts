import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { type ChatModel, createChat, update } from "../../src/chat/model.js";
import { createSurface } from "../../src/chat/surface.js";
import { costText, emptyState } from "../../src/chat/view.js";

const META = {
  authKind: "subscription",
  contextWindow: 1_000_000,
  repoName: "agent-harness",
  branch: "main",
};

const withEntry = (m: ChatModel): ChatModel =>
  update(m, { type: "info", text: "hello" }).model;

const frame = async (
  model: ChatModel,
  width: number,
  env: Record<string, string | undefined>,
): Promise<string> => {
  const setup = await createTestRenderer({ width, height: 24 });
  const surface = createSurface(setup.renderer, env);
  surface.update(model);
  await setup.renderOnce();
  const out = setup.captureCharFrame();
  setup.renderer.destroy();
  return out;
};

describe("UX-30: cockpit shell — four regions, empty state, honest ticker", () => {
  it("empty model yields the seven empty-state elements in order; a first entry removes them", () => {
    const els = emptyState({ modelId: "mock-m", ...META });
    expect(els).toHaveLength(7);
    expect(els[0]).toEqual({ kind: "wordmark", text: "obligato" });
    const texts = els
      .slice(1)
      .map((e) =>
        e.kind === "line" ? e.segs.map((s) => s.text).join("") : "",
      );
    expect(texts[0]).toBe("spec-first agent harness");
    expect(texts[1]).toContain("mock-m");
    expect(texts[1]).toContain("1M ctx");
    expect(texts[1]).toContain("subscription");
    expect(texts[2]).toContain("agent-harness");
    expect(texts[2]).toContain("main");
    expect(texts[3]).toContain("try");
    expect(texts[4]).toContain("try");
    expect(texts[5]).toContain("/model");
    expect(texts[5]).toContain("/exit");
  });

  it("cost formatting: subscription ~, unknown suffix, both compose", () => {
    // revert-check: drop the ~ prefix branch (T2.5) → subscription cells fail.
    const c = (authKind: string, costUnknown: boolean) =>
      costText({ authKind, costMicroUsd: 123_400, costUnknown });
    expect(c("api_key", false)).toBe("$0.1234");
    expect(c("subscription", false)).toBe("~$0.1234");
    expect(c("api_key", true)).toBe("$0.1234 (some steps unpriced)");
    expect(c("subscription", true)).toBe("~$0.1234 (some steps unpriced)");
  });

  it("renders all four regions at 80 and 120 columns with no overflow", async () => {
    const model = withEntry(createChat("mock-m", META, []));
    for (const width of [80, 120]) {
      const out = await frame(model, width, {});
      expect(out).toContain("obligato chat");
      expect(out).toContain("mock-m");
      expect(out).toContain("/help");
      expect(out).toContain("esc");
      // Ticker-unique string — "/help" alone also matches the input
      // placeholder, so it can't discriminate the ticker region (audit W4).
      expect(out).toContain(`~$0.0000 ${"·"} ready`);
      expect(out).toContain("hello");
      for (const line of out.split("\n"))
        expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it("empty state renders the wordmark; the first entry replaces it", async () => {
    const empty = await frame(createChat("mock-m", META, []), 80, {});
    expect(empty).toContain("spec-first agent harness");
    const after = await frame(
      withEntry(createChat("mock-m", META, [])),
      80,
      {},
    );
    expect(after).not.toContain("spec-first agent harness");
    expect(after).toContain("hello");
  });

  it("tail-follow: an incrementally grown transcript shows the newest entry, not the oldest", async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 });
    const surface = createSurface(setup.renderer, {});
    let m = update(createChat("mock-m", META, []), {
      type: "info",
      text: "first-entry",
    }).model;
    surface.update(m);
    await setup.renderOnce();
    for (let i = 0; i < 20; i++) {
      m = update(m, { type: "info", text: `row-${i}` }).model;
      surface.update(m);
      await setup.renderOnce();
    }
    // Settle pass: the clamp lands one layout behind; the app's continuous
    // render loop does this implicitly, tests do it explicitly.
    surface.update(m);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    // revert-check: drop the follow logic in setBody → the viewport stays at
    // the top and shows first-entry, not row-19.
    expect(frame).toContain("row-19");
    expect(frame).not.toContain("first-entry");
    setup.renderer.destroy();
  });

  it("shrink (expand a fold, collapse it) never releases tail-follow (F-203)", async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 });
    const surface = createSurface(setup.renderer, {});
    let m = update(createChat("mock-m", META, []), {
      type: "tool_result",
      name: "read",
      ok: true,
      output: "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8",
    }).model;
    const render = async (): Promise<void> => {
      surface.update(m);
      await setup.renderOnce();
    };
    await render();
    for (let i = 0; i < 15; i++) {
      m = update(m, { type: "info", text: `row-${i}` }).model;
      await render();
    }
    // Expand then collapse: the collapse shrinks content and OpenTUI re-clamps
    // scrollTop with zero user input.
    m = update(m, { type: "toggle_fold", index: 0 }).model;
    await render();
    m = update(m, { type: "toggle_fold", index: 0 }).model;
    await render();
    // revert-check: release on `scrollTop < lastFollowClamp` alone (drop the
    // Math.min) → following latches false here and after-collapse never shows.
    m = update(m, { type: "info", text: "after-collapse" }).model;
    await render();
    await render(); // settle
    expect(setup.captureCharFrame()).toContain("after-collapse");
    setup.renderer.destroy();
  });

  it("NO_COLOR changes colors only — char frame identical", async () => {
    const model = withEntry(createChat("mock-m", META, []));
    // captureCharFrame is characters-only; identical frames prove structure
    // carries the meaning without color (UX-4).
    // revert-check: gate glyphs or layout behind color state → frames differ.
    const colored = await frame(model, 80, {});
    const stripped = await frame(model, 80, { NO_COLOR: "" });
    expect(stripped).toBe(colored);
  });
});
