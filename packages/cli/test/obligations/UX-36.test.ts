import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  type ChatModel,
  createChat,
  parseTodos,
  update,
} from "../../src/chat/model.js";
import { createSurface } from "../../src/chat/surface.js";
import { CHAT_THEME } from "../../src/chat/theme.js";
import { tickerLine, VIZ_WIDTH, vizPane } from "../../src/chat/view.js";

const g = CHAT_THEME.glyphs;

const busyModel = (): ChatModel =>
  update(createChat("mock-m", {}, []), { type: "submit", text: "go" }).model;

const tick = (m: ChatModel, n: number): ChatModel => {
  let out = m;
  for (let i = 0; i < n; i++) out = update(out, { type: "tick" }).model;
  return out;
};

const TODO_OUT =
  "[x] map flow\n[x] read endpoints\n[>] audit authz\n[ ] write findings";

describe("UX-36: agent cockpit — activity tracking, todo parse, pane sections", () => {
  it("tool_start then tool_result completes the same item; bare result appends completed", () => {
    let m = busyModel();
    m = tick(m, 12);
    m = update(m, { type: "tool_start", name: "bash", arg: "bun test" }).model;
    expect(m.activity).toEqual([
      { name: "bash", arg: "bun test", startTick: 12, endTick: null, ok: null },
    ]);
    m = tick(m, 9);
    m = update(m, {
      type: "tool_result",
      name: "bash",
      ok: true,
      output: "ok",
    }).model;
    // revert-check: drop the open-item completion → endTick stays null.
    expect(m.activity[0]).toEqual({
      name: "bash",
      arg: "bun test",
      startTick: 12,
      endTick: 21,
      ok: true,
    });
    // Bare result (no onToolStart plumbed): appended, never dropped.
    m = update(m, {
      type: "tool_result",
      name: "read",
      ok: false,
      output: "boom",
    }).model;
    expect(m.activity[1]).toEqual({
      name: "read",
      arg: "",
      startTick: 21,
      endTick: 21,
      ok: false,
    });
  });

  it("todo results parse the AGT-19 serialization; (no tasks) empties; junk lines skip", () => {
    expect(parseTodos(TODO_OUT)).toEqual([
      { text: "map flow", state: "done" },
      { text: "read endpoints", state: "done" },
      { text: "audit authz", state: "active" },
      { text: "write findings", state: "pending" },
    ]);
    // Junk line among valid lines is skipped, never a crash (KERN-1).
    expect(parseTodos("[x] a\ngarbage\n[ ] b")).toEqual([
      { text: "a", state: "done" },
      { text: "b", state: "pending" },
    ]);
    let m = busyModel();
    m = update(m, {
      type: "tool_result",
      name: "todo",
      ok: true,
      output: TODO_OUT,
    }).model;
    expect(m.todos).toHaveLength(4);
    m = update(m, {
      type: "tool_result",
      name: "todo",
      ok: true,
      output: "(no tasks)",
    }).model;
    // revert-check: ignore replacement semantics → the old list survives.
    expect(m.todos).toEqual([]);
    // A failed todo call never touches the list.
    m = update(m, {
      type: "tool_result",
      name: "todo",
      ok: true,
      output: TODO_OUT,
    }).model;
    m = update(m, {
      type: "tool_result",
      name: "todo",
      ok: false,
      output: "invalid input: x",
    }).model;
    expect(m.todos).toHaveLength(4);
  });

  it("tasks section: title 2/4, active carries fold glyph + accent, pending sep + dim", () => {
    let m = busyModel();
    m = update(m, {
      type: "tool_result",
      name: "todo",
      ok: true,
      output: TODO_OUT,
    }).model;
    const lines = vizPane(m, {});
    const texts = lines.map((l) => l.map((s) => s.text).join(""));
    expect(texts).toContain("tasks 2/4");
    const active = lines.find((l) =>
      l.some((s) => s.text.includes("audit authz")),
    );
    // revert-check: render active rows dim → the accent role assertion fails.
    expect(active?.[0]?.role).toBe("accent");
    expect(active?.[0]?.text).toBe(`${g.fold} audit authz`);
    const pending = lines.find((l) =>
      l.some((s) => s.text.includes("write findings")),
    );
    expect(pending?.[0]?.role).toBe("dim");
    expect(pending?.[0]?.text).toBe(`${g.sep} write findings`);
  });

  it("activity section: completed shows arg; running shows spin[tick % len] and elapsed; deterministic", () => {
    let m = busyModel();
    m = update(m, {
      type: "tool_start",
      name: "read",
      arg: "Endpoints.cs",
    }).model;
    m = update(m, {
      type: "tool_result",
      name: "read",
      ok: true,
      output: "x",
    }).model;
    m = tick(m, 12);
    m = update(m, { type: "tool_start", name: "bash", arg: "bun test" }).model;
    m = tick(m, 25); // tickCount 37, bash started at 12 → elapsed 2s
    const lines = vizPane(m, {});
    const texts = lines.map((l) => l.map((s) => s.text).join(""));
    expect(texts).toContain("activity");
    expect(
      texts.some((t) => t.includes("read") && t.includes("Endpoints.cs")),
    ).toBe(true);
    const running = texts.find((t) => t.includes("bash"));
    // revert-check: wall-clock elapsed → nondeterministic, this exact frame
    // and 2s assertion fail (F-126).
    expect(running).toBe(`${g.spin[37 % g.spin.length] as string} bash 2s`);
    expect(vizPane(m, {})).toEqual(lines);
    const later = tick(m, 1);
    expect(vizPane(later, {})).not.toEqual(lines);
    // NO_MOTION (empty string — presence): frame frozen at spin[0].
    const still = vizPane(later, { OBLIGATO_NO_MOTION: "" })
      .map((l) => l.map((s) => s.text).join(""))
      .find((t) => t.includes("bash"));
    expect(still).toBe(`${g.spin[0] as string} bash 2s`);
  });

  it("tools section: top 3 by count, first-seen tie order, capped meter", () => {
    let m = busyModel();
    const call = (name: string): void => {
      m = update(m, { type: "tool_start", name, arg: "a" }).model;
      m = update(m, { type: "tool_result", name, ok: true, output: "" }).model;
    };
    for (let i = 0; i < 3; i++) call("read");
    for (let i = 0; i < 2; i++) call("grep");
    for (let i = 0; i < 2; i++) call("bash");
    call("ls");
    const texts = vizPane(m, {}).map((l) => l.map((s) => s.text).join(""));
    const barTop = g.bar[g.bar.length - 1] as string;
    const i = texts.indexOf("tools");
    expect(i).toBeGreaterThan(-1);
    // revert-check: count-only sort without stability → grep/bash order flips.
    expect(texts[i + 1]).toBe(`read ${barTop.repeat(3)} 3`);
    expect(texts[i + 2]).toBe(`grep ${barTop.repeat(2)} 2`);
    expect(texts[i + 3]).toBe(`bash ${barTop.repeat(2)} 2`);
    expect(texts.some((t) => t.startsWith("ls "))).toBe(false);
  });

  it("lines truncate to 26 cells ending with …; empty model says no activity yet", () => {
    let m = busyModel();
    m = update(m, {
      type: "tool_start",
      name: "read",
      arg: "a-very-long/path/deep/inside/the/repo.ts",
    }).model;
    m = update(m, {
      type: "tool_result",
      name: "read",
      ok: true,
      output: "",
    }).model;
    const line = vizPane(m, {}).find((l) =>
      l.some((s) => s.text.includes("a-very-long")),
    ) as { text: string }[];
    const joined = line.map((s) => s.text).join("");
    expect(joined.length).toBe(VIZ_WIDTH);
    expect(joined.endsWith("…")).toBe(true);

    const empty = vizPane(createChat("mock-m", {}, []), {});
    expect(empty).toEqual([[{ role: "dim", text: "no activity yet" }]]);
  });

  it("120-col snapshot: /viz open while busy shows the pane and title", async () => {
    let m = update(createChat("mock-m", {}, []), {
      type: "submit",
      text: "/viz",
    }).model;
    expect(m.rail).toBe("viz");
    m = update(m, { type: "submit", text: "go" }).model;
    m = update(m, { type: "tool_start", name: "grep", arg: "TODO" }).model;
    const setup = await createTestRenderer({ width: 120, height: 24 });
    const surface = createSurface(setup.renderer, {});
    surface.update(m);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("viz");
    expect(frame).toContain("activity");
    expect(frame).toContain("grep");
    setup.renderer.destroy();
  });

  it("reducer-driven paused wins over busy (F-212): paused warn line prepends, ticker says paused", () => {
    let m = busyModel();
    expect(m.busy).toBe(true);
    m = update(m, {
      type: "paused",
      ask: { requestId: "r1", tool: "bash", arg: "x", rule: "default" },
    }).model;
    // busy is STILL true here — the production ask shape.
    expect(m.busy).toBe(true);
    const lines = vizPane(m, {});
    // revert-check: busy-first derivation → no paused line, both fail.
    expect(lines[0]).toEqual([{ role: "warn", text: "paused" }]);
    expect(tickerLine(m).left).toContain("paused");
  });

  it("UX-32 truth-table extension: tree+/viz→viz; viz+/viz→closed", () => {
    let m = createChat("mock-m", {}, []);
    m = update(m, { type: "submit", text: "/tree" }).model;
    m = update(m, { type: "submit", text: "/viz" }).model;
    expect(m.rail).toBe("viz");
    m = update(m, { type: "submit", text: "/viz" }).model;
    expect(m.rail).toBeNull();
  });
});

describe("UX-36: audit arms — turn-boundary close, clip boundary, completed-line roles", () => {
  it("error (and turn_done) close open items at the pre-reset tick with ok:false", () => {
    let m = busyModel();
    m = tick(m, 30);
    m = update(m, { type: "tool_start", name: "bash", arg: "x" }).model;
    m = tick(m, 5);
    m = update(m, { type: "error", message: "boom" }).model;
    // revert-check: drop the closeOpen call → endTick stays null and the
    // pane renders floor((0-30)/10) = negative elapsed.
    expect(m.activity[0]).toEqual({
      name: "bash",
      arg: "x",
      startTick: 30,
      endTick: 35,
      ok: false,
    });
    let d = busyModel();
    d = update(d, { type: "tool_start", name: "read", arg: "y" }).model;
    d = update(d, { type: "turn_done", status: "done" }).model;
    expect(d.activity[0]?.endTick).toBe(0);
    expect(d.activity[0]?.ok).toBe(false);
  });

  it("multi-segment exact-boundary: 26-filling first segment + more still yields 26 ending …", () => {
    let m = busyModel();
    // glyph(1) + space(1) then name chosen so glyph+space+name === 26 cells,
    // with the arg segment following.
    const name = "a".repeat(24);
    m = update(m, { type: "tool_start", name, arg: "tail" }).model;
    m = update(m, { type: "tool_result", name, ok: true, output: "" }).model;
    const line = vizPane(m, {}).find((l) =>
      l.some((s) => s.text.includes("aaaa")),
    ) as { text: string }[];
    const joined = line.map((s) => s.text).join("");
    // revert-check: unreserved fit check → room goes negative, slice(0,-1)
    // mangles and the line exceeds 26.
    expect(joined.length).toBe(VIZ_WIDTH);
    expect(joined.endsWith("…")).toBe(true);
  });

  it("completed activity line: name in tool role, arg in dim (role-level)", () => {
    let m = busyModel();
    m = update(m, { type: "tool_start", name: "read", arg: "a.ts" }).model;
    m = update(m, {
      type: "tool_result",
      name: "read",
      ok: true,
      output: "",
    }).model;
    const line = vizPane(m, {}).find((l) =>
      l.some((s) => s.text === "read"),
    ) as { role: string; text: string }[];
    expect(line[0]?.role).toBe("ok");
    expect(line[1]).toEqual({ role: "tool", text: "read" });
    expect(line[2]).toEqual({ role: "dim", text: " a.ts" });
  });
});
