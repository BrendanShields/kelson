import type { ModelRegistryEntry } from "@kelson/schemas";

// Prices in micro-USD per million tokens, from the claude-api reference
// (cached 2026-06-24): cache_read = 0.1x input, cache_write = 1.25x input
// (5-minute TTL). Sonnet 5 uses list price, not the 2026-08-31 intro price.
export const SHIPPED_MODELS: ModelRegistryEntry[] = [
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    context_window: 1_000_000,
    max_output: 128_000,
    prices: {
      in: 5_000_000,
      out: 25_000_000,
      cache_read: 500_000,
      cache_write: 6_250_000,
    },
    tools: true,
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    context_window: 1_000_000,
    max_output: 128_000,
    prices: {
      in: 3_000_000,
      out: 15_000_000,
      cache_read: 300_000,
      cache_write: 3_750_000,
    },
    tools: true,
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    context_window: 200_000,
    max_output: 64_000,
    prices: {
      in: 1_000_000,
      out: 5_000_000,
      cache_read: 100_000,
      cache_write: 1_250_000,
    },
    tools: true,
  },
];
