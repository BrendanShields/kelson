import { describe, expect, it } from "bun:test";
import type { ModelRegistryEntry } from "@kelson/schemas";
import { costOf } from "../../src/llm/registry.ts";

const PRICED: ModelRegistryEntry = {
  id: "m",
  provider: "anthropic",
  context_window: 1000,
  max_output: 100,
  prices: {
    in: 5_000_000,
    out: 25_000_000,
    cache_read: 500_000,
    cache_write: 6_250_000,
  },
  tools: true,
};

describe("PROV-3: integer micro-USD from registry prices; unknown price is null, never estimated", () => {
  it("fixture usage times fixture prices equals the hand-computed integer", () => {
    // By hand: 1000*5 + 500*25 + 200*0.5 + 100*6.25
    //        = 5000 + 12500 + 100 + 625 = 18225 micro-USD.
    expect(
      costOf(
        {
          tokens_in: 1000,
          tokens_out: 500,
          tokens_cache_read: 200,
          tokens_cache_write: 100,
        },
        PRICED,
      ),
    ).toBe(18_225);
    // Rounding: 1 output token at $25/MTok = 25 micro-USD exactly; 1 cache
    // read at 0.5 micro-USD rounds to 1 (hand-computed: 25.5 → 26).
    expect(
      costOf(
        {
          tokens_in: 0,
          tokens_out: 1,
          tokens_cache_read: 1,
          tokens_cache_write: 0,
        },
        PRICED,
      ),
    ).toBe(26);
  });

  it("an unpriced model yields null, not zero", () => {
    expect(
      costOf(
        {
          tokens_in: 1000,
          tokens_out: 500,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
        },
        { ...PRICED, prices: null },
      ),
    ).toBeNull();
  });
});
