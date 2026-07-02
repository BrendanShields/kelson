import { describe, expect, it } from "bun:test";
import { extractFeatures, jaccard } from "../../src/routing.ts";

const base = { step: "build" as const, repo: "r" };

describe("RPOL-2: every feature computed per the normative table with declared fallbacks", () => {
  it("tier: max criticality among touched clauses; none → T0", () => {
    expect(extractFeatures(base).tier).toBe("T0");
    expect(
      extractFeatures({ ...base, touchedTiers: ["T0", "T2", "T1"] }).tier,
    ).toBe("T2");
  });

  it("size: S ≤ 2, M ≤ 10, L > 10; unknown → M", () => {
    expect(extractFeatures(base).size).toBe("M");
    expect(extractFeatures({ ...base, plannedFiles: ["a"] }).size).toBe("S");
    expect(
      extractFeatures({
        ...base,
        plannedFiles: Array.from({ length: 10 }, (_, i) => `f${i}`),
      }).size,
    ).toBe("M");
    expect(
      extractFeatures({
        ...base,
        plannedFiles: Array.from({ length: 11 }, (_, i) => `f${i}`),
      }).size,
    ).toBe("L");
  });

  it("novelty: 1 − max Jaccard vs history; no history → 1; hand-computed fixture", () => {
    expect(extractFeatures(base).novelty).toBe(1);
    expect(
      extractFeatures({ ...base, plannedFiles: ["a", "b", "c"], history: [] })
        .novelty,
    ).toBe(1);
    // Hand-computed: J({a,b,c},{a,b}) = 2/3; J({a,b,c},{x}) = 0 → novelty 1/3.
    const v = extractFeatures({
      ...base,
      plannedFiles: ["a", "b", "c"],
      history: [["a", "b"], ["x"]],
    });
    expect(v.novelty).toBeCloseTo(1 / 3, 10);
    expect(v.novelty_bucket).toBe("mid");
    expect(jaccard(["a", "b", "c"], ["a", "b"])).toBeCloseTo(2 / 3, 10);
    expect(jaccard([], [])).toBe(0);
  });

  it("novelty buckets: <0.3 low, >0.7 high, else mid", () => {
    const low = extractFeatures({
      ...base,
      plannedFiles: ["a", "b", "c", "d", "e"],
      history: [["a", "b", "c", "d", "e"]],
    });
    expect(low.novelty).toBe(0);
    expect(low.novelty_bucket).toBe("low");
    expect(extractFeatures(base).novelty_bucket).toBe("high");
  });

  it("lang: dominant by count; ties → repo primary; none → repo primary/unknown", () => {
    expect(
      extractFeatures({ ...base, langCounts: { typescript: 3, python: 1 } })
        .lang,
    ).toBe("typescript");
    expect(
      extractFeatures({
        ...base,
        langCounts: { typescript: 2, python: 2 },
        repoPrimaryLang: "python",
      }).lang,
    ).toBe("python");
    expect(extractFeatures({ ...base, repoPrimaryLang: "rust" }).lang).toBe(
      "rust",
    );
    expect(extractFeatures(base).lang).toBe("unknown");
  });

  it("task_type: mechanical only when declared; unknown → standard", () => {
    expect(extractFeatures(base).task_type).toBe("standard");
    expect(extractFeatures({ ...base, mechanical: true }).task_type).toBe(
      "mechanical",
    );
  });
});
