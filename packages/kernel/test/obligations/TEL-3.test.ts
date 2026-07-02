import { describe, expect, it } from "bun:test";
import type { StepEvent } from "@kelson/schemas";
import fc from "fast-check";
import { stripStepEvent } from "../../src/privacy.ts";

const MARKER = "XKELSON_SECRET_MARKERX";

const eventArb: fc.Arbitrary<StepEvent> = fc
  .record({
    tokens_in: fc.nat(1_000_000),
    tokens_out: fc.nat(1_000_000),
    cost: fc.nat(1_000_000),
    markerField: fc.constantFrom("agent_id", "span_id", "task_id"),
  })
  .map((r) => ({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    task_id:
      r.markerField === "task_id"
        ? "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        : "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sdlc_step: "build" as const,
    model: "claude-sonnet-5",
    effort: "medium" as const,
    // Free-text-capable fields carry planted markers (code/path/prompt-like).
    agent_id: `src/secret/path.ts ${MARKER} prompt text`,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    unit_prices: { input: 3 },
    cost_micro_usd: r.cost,
    budget_tokens: 1000,
    overrun: "none" as const,
    span_id: `${MARKER}/etc/passwd`,
    schema_version: 1,
  }));

describe("TEL-3: shared payloads strip code, paths, and prompt text — only numeric/categorical fields survive", () => {
  it("PBT: planted markers never appear in the serialized shared payload", () => {
    fc.assert(
      fc.property(eventArb, (event) => {
        const shared = stripStepEvent(event);
        const serialized = JSON.stringify(shared);
        expect(serialized).not.toContain(MARKER);
        expect(serialized).not.toContain("secret");
        expect(serialized).not.toContain("passwd");
      }),
      { numRuns: 200 },
    );
  });
});
