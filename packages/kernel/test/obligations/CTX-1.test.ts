import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  type BundleItem,
  compileBundle,
  countTokens,
  recordBundle,
  recordBundleMiss,
  recordedTotal,
} from "../../src/bundle.ts";
import { openDb } from "../../src/storage.ts";

const itemArb: fc.Arbitrary<BundleItem> = fc.record({
  kind: fc.constantFrom(
    "statement",
    "clause",
    "signature",
    "invariant",
    "loadout",
  ),
  ref: fc
    .string({ minLength: 1, maxLength: 20 })
    .map((s) => s.replaceAll("\n", "_") || "r"),
  // Unicode-biased: seam merges and multi-byte content are the failure modes.
  content: fc.oneof(
    fc.string({ maxLength: 400 }),
    fc.string({ maxLength: 200, unit: "grapheme" }),
    fc.constantFrom(
      "naïve 🚀 日本語",
      "foo",
      "bar\n\n\nbaz",
      "   ",
      "```ts\nconst x = 1\n```",
    ),
  ),
});

describe("CTX-1: bundle token accounting matches actual context tokens within 2%; misses join the accounting", () => {
  it("PBT: recorded accounting matches the actual delivered context within 2%; manifest entries verify independently", () => {
    fc.assert(
      fc.property(fc.array(itemArb, { maxLength: 20 }), (items) => {
        const bundle = compileBundle(items);
        // Independent route 1: tokenize the delivered text in the test.
        const actual = countTokens(bundle.text);
        expect(Math.abs(bundle.token_count - actual)).toBeLessThanOrEqual(
          0.02 * actual,
        );
        if (items.length === 0) expect(bundle.token_count).toBe(0);
        // Independent route 2: reconstruct each section frame here and verify
        // the manifest's per-item counts against it.
        items.forEach((item, i) => {
          const framed = `### ${item.kind}:${item.ref}\n${item.content}`;
          expect(bundle.manifest[i]?.tokens).toBe(countTokens(framed));
        });
      }),
      { numRuns: 300 },
    );
  });

  it("the recorded event carries the manifest; on-demand loads join the total as their own events", () => {
    const db = openDb(":memory:");
    const bundle = compileBundle([
      { kind: "statement", ref: "task", content: "implement the limiter" },
      { kind: "clause", ref: "RL-1", content: "When a request arrives …" },
    ]);
    const event = recordBundle(db, "t1", bundle);
    expect(event.manifest).toHaveLength(2);
    expect(recordedTotal(db, event.id)).toBe(bundle.token_count);

    const miss1 = recordBundleMiss(
      db,
      event.id,
      "src/limiter.ts",
      "const x = 1;",
    );
    const miss2 = recordBundleMiss(
      db,
      event.id,
      "src/window.ts",
      "let w = new Map();",
    );
    expect(recordedTotal(db, event.id)).toBe(
      bundle.token_count + miss1.tokens + miss2.tokens,
    );
    // The original bundle event is never mutated.
    const row = db
      .query("SELECT token_count FROM bundle_event WHERE id = ?")
      .get(event.id) as { token_count: number };
    expect(row.token_count).toBe(bundle.token_count);
    db.close();
  });

  it("the designated verification route: per-section sums + separators agree with the recorded count within 2% at realistic size", () => {
    // Real bundles carry multi-hundred-token sections; seam merges amortize.
    const items: BundleItem[] = [
      {
        kind: "statement",
        ref: "task",
        content: "Implement per-caller rate limiting. ".repeat(40),
      },
      {
        kind: "clause",
        ref: "RL-1",
        content:
          "When a request arrives and the count equals the rate, respond 429 with retry_after set to the window remainder. ".repeat(
            15,
          ),
      },
      {
        kind: "signature",
        ref: "limiter",
        content:
          "export const createLimiter: (rate: number) => { request(caller: string): Response }\n".repeat(
            10,
          ),
      },
      {
        kind: "invariant",
        ref: "RL-INV-1",
        content:
          "The sum of window counts never exceeds limit times active callers. ".repeat(
            12,
          ),
      },
    ];
    const bundle = compileBundle(items);
    // Independent derivation: manifest sums + separator tokens, never the
    // whole-text call the compiler itself made.
    const partsSum =
      bundle.manifest.reduce((sum, m) => sum + m.tokens, 0) +
      countTokens("\n\n") * (items.length - 1);
    expect(bundle.token_count).toBeGreaterThan(500);
    expect(Math.abs(partsSum - bundle.token_count)).toBeLessThanOrEqual(
      0.02 * bundle.token_count,
    );
  });

  it("determinism: the identical input compiles to identical counts and manifest hashes", () => {
    const items: BundleItem[] = [
      { kind: "clause", ref: "A-1", content: "alpha" },
      {
        kind: "signature",
        ref: "f",
        content: "export const f: (x: number) => number",
      },
    ];
    const first = compileBundle(items);
    const second = compileBundle(items);
    expect(second.token_count).toBe(first.token_count);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.text).toBe(first.text);
  });
});
