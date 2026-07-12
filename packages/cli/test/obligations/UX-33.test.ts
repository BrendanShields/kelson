import { describe, expect, it } from "bun:test";
import { type ChatModel, createChat, update } from "../../src/chat/model.js";
import { CHAT_THEME } from "../../src/chat/theme.js";
import { budgetPane, sparkline } from "../../src/chat/view.js";

const bar = CHAT_THEME.glyphs.bar;
const first = bar[0] as string;
const last = bar[bar.length - 1] as string;
const mid = bar[Math.round(0.5 * (bar.length - 1))] as string;

const costs = (m: ChatModel, values: (number | null)[]): ChatModel =>
  values.reduce(
    (acc, costMicroUsd) =>
      update(acc, { type: "step_cost", costMicroUsd }).model,
    m,
  );

const paneText = (m: ChatModel): string =>
  budgetPane(m)
    .map((l) => l.map((s) => s.text).join(""))
    .join("\n");

describe("UX-33: per-step cost retention + budget pane", () => {
  it("stepCosts retains values in order with null preserved", () => {
    const m = costs(createChat("mock-m"), [100, null, 250]);
    // revert-check: coerce null to 0 in the reducer (PROV-3 violation) →
    // the null equality fails.
    expect(m.stepCosts).toEqual([100, null, 250]);
    expect(m.costUnknown).toBe(true);
  });

  it("sparkline: min/mid/max map to first/middle/last bar glyph; ties all-first; null renders sep", () => {
    expect(sparkline([0, 50, 100])).toBe(`${first}${mid}${last}`);
    expect(sparkline([7, 7, 7])).toBe(`${first}${first}${first}`);
    // revert-check: render null as a bar cell → the sep assertion fails.
    expect(sparkline([0, null, 100])).toBe(
      `${first}${CHAT_THEME.glyphs.sep}${last}`,
    );
  });

  it("a 20-step history windows to the last 14", () => {
    const values = Array.from({ length: 20 }, (_, i) => i * 10);
    const m = costs(createChat("mock-m"), values);
    const burn =
      budgetPane(m)[1]
        ?.map((s) => s.text)
        .join("") ?? "";
    expect(burn).toContain("last 14");
    const spark = burn.match(/[▁▂▃▄▅▆▇█·]+/)?.[0] ?? "";
    expect(spark.length).toBe(14);
  });

  it("avg/max over priced steps only, unpriced count appended", () => {
    const m = costs(createChat("mock-m"), [100_000, null, 300_000]);
    const text = paneText(m);
    // avg over priced = 200000µ = $0.2000; max = $0.3000; 1 unpriced.
    expect(text).toContain("avg $0.2000");
    expect(text).toContain("max $0.3000");
    // revert-check: include nulls as 0 in avg → $0.1333 and this fails.
    expect(text).toContain("1 unpriced");
  });

  it("avg/max cover ALL priced steps, never the 14-step burn window (discriminating)", () => {
    // 16 steps: two big early values fall OUTSIDE the last-14 window.
    // all-steps avg = (2×1_000_000 + 14×100_000)/16 = $0.2125;
    // window-scoped avg would be $0.1000 — the fixture discriminates (F-100).
    const values = [1_000_000, 1_000_000, ...Array(14).fill(100_000)];
    const m = costs(createChat("mock-m"), values);
    const text = paneText(m);
    expect(text).toContain("avg $0.2125");
    // revert-check: scope stats to the window → avg $0.1000 and max $0.1000.
    expect(text).toContain("max $1.0000");
  });

  it("spent line uses the shared costText (subscription ~ prefix flows through)", () => {
    const m = costs(
      createChat("mock-m", { authKind: "subscription" }),
      [123_400],
    );
    expect(paneText(m)).toContain("~$0.1234");
  });

  it("zero steps renders 'no steps yet'", () => {
    expect(paneText(createChat("mock-m"))).toBe("no steps yet");
  });
});
