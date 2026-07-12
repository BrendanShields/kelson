import { describe, expect, it } from "bun:test";
import { ChatWidget, WIDGET_DEGRADE, WidgetTree } from "../../src/index.ts";

const tree = (root: unknown) =>
  WidgetTree.safeParse({ schema_version: 1, root });

const VARIANTS = [
  "panel",
  "table",
  "diff",
  "markdown",
  "code",
  "sparkline",
  "tree",
  "ticker",
  "badge",
] as const;

describe("UX-28: WidgetTree — strict nine-variant union + per-type degrade map", () => {
  it("panel-in-panel-in-panel JSON round-trips (recursion point works)", () => {
    const input: WidgetTree = {
      schema_version: 1,
      root: {
        type: "panel",
        title: "outer",
        children: [
          {
            type: "panel",
            title: "mid",
            children: [{ type: "panel", title: "inner", children: [] }],
          },
        ],
      },
    };
    // Through the JSON round-trip, not parse-only — the obligation's ≥2-deep
    // arm is deterministic here (the roundtrip.test.ts generator draw is not).
    expect(WidgetTree.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  it("unknown type fails with invalid_union", () => {
    const r = tree({ type: "gauge", value: 1 });
    expect(r.success).toBe(false);
    // revert-check: add a tenth variant "gauge" → this success:false fails.
    if (!r.success) expect(r.error.issues[0]?.code).toBe("invalid_union");
  });

  it("strict: nested tree children and a stray badge key both fail with unrecognized_keys", () => {
    // revert-check (the divergence ruling): switch strictObject → z.object
    // (strip mode) and BOTH of these parse successfully — both asserts fail.
    const smuggled = tree({
      type: "tree",
      nodes: [{ id: "a", label: "A", parent: null, children: [] }],
    });
    expect(smuggled.success).toBe(false);
    if (!smuggled.success)
      expect(
        smuggled.error.issues.some((i) => i.code === "unrecognized_keys"),
      ).toBe(true);

    const stray = tree({
      type: "badge",
      glyph_role: "info",
      text: "x",
      color: "red",
    });
    expect(stray.success).toBe(false);
    if (!stray.success)
      expect(
        stray.error.issues.some((i) => i.code === "unrecognized_keys"),
      ).toBe(true);
  });

  it("shape-only composite parses with zero issues", () => {
    // Ragged rows + dangling/duplicate/self-parent nodes + empty segments:
    // schema validates shape, referential consistency is the composer's job.
    const r = tree({
      type: "panel",
      title: "",
      children: [
        {
          type: "table",
          columns: ["a", "b"],
          rows: [["1"], ["1", "2", "3"], []],
        },
        {
          type: "tree",
          nodes: [
            { id: "n1", label: "", parent: "ghost" },
            { id: "n1", label: "dup", parent: null },
            { id: "n2", label: "self", parent: "n2" },
          ],
        },
        { type: "ticker", segments: [] },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("schema_version is the literal number 1 — string and 2 both fail there", () => {
    for (const v of ["1", 2]) {
      const r = WidgetTree.safeParse({
        schema_version: v,
        root: { type: "markdown", content: "x" },
      });
      expect(r.success).toBe(false);
      if (!r.success)
        expect(r.error.issues[0]?.path).toEqual(["schema_version"]);
    }
  });

  it("sparkline rejects NaN and Infinity at the offending index", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = tree({ type: "sparkline", label: "l", values: [0, bad] });
      expect(r.success).toBe(false);
      if (!r.success)
        expect(r.error.issues[0]?.path).toEqual(["root", "values", 1]);
    }
  });

  it("round-trip property over all nine variants", () => {
    // The registered generator lives in roundtrip.test.ts (schema gate); this
    // pins a fixed all-variant fixture through JSON round-trip to deep-equal.
    const root = {
      type: "panel" as const,
      title: "all",
      children: [
        { type: "table" as const, columns: ["c"], rows: [["v"]] },
        { type: "diff" as const, unified: "+a" },
        { type: "markdown" as const, content: "# m" },
        { type: "code" as const, language: "ts", content: "1" },
        // no -0: JSON.stringify(-0) === "0" (serialization edge, documented in
        // roundtrip.test.ts) — the schema itself accepts -0 fine.
        { type: "sparkline" as const, label: "s", values: [0, -3, 1e308] },
        {
          type: "tree" as const,
          nodes: [{ id: "a", label: "A", parent: null }],
        },
        {
          type: "ticker" as const,
          segments: [{ label: "l", value: "v", emphasis: true }],
        },
        { type: "badge" as const, glyph_role: "info", text: "b" },
      ],
    };
    const parsed = WidgetTree.parse(
      JSON.parse(JSON.stringify({ schema_version: 1, root })),
    );
    expect(parsed).toEqual({ schema_version: 1, root });
  });

  it("WIDGET_DEGRADE covers exactly the nine variants with non-empty descriptors", () => {
    expect(Object.keys(WIDGET_DEGRADE).sort()).toEqual([...VARIANTS].sort());
    // Set-equality against the union's own literals, not a copied list.
    expect(new Set(Object.keys(WIDGET_DEGRADE))).toEqual(
      new Set(ChatWidget.options.map((o) => o.shape.type.value)),
    );
    for (const v of VARIANTS) {
      // revert-check: blank WIDGET_DEGRADE.diff.col80 → this names the variant.
      expect(WIDGET_DEGRADE[v].col80.trim().length).toBeGreaterThan(0);
      expect(WIDGET_DEGRADE[v].plain.trim().length).toBeGreaterThan(0);
    }
  });
});
