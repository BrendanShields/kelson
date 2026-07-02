import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SharedSessionEvent, SharedStepEvent } from "@kelson/schemas";

const VALID_STEP = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  session_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  sdlc_step: "build",
  model: "claude-sonnet-5",
  effort: "medium",
  tokens_in: 1,
  tokens_out: 1,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  cost_micro_usd: 1,
  budget_tokens: 1,
  overrun: "none",
  schema_version: 1,
};

const FREE_TEXT =
  "const secret = process.env.KEY; // /Users/b/src smuggled prose";

describe("OSS-2: shared-telemetry schema is published, versioned, and structurally free-text-free", () => {
  it("every field of the shared schema rejects free text — behavioral probe per field", () => {
    expect(SharedStepEvent.safeParse(VALID_STEP).success).toBe(true);
    for (const key of Object.keys(VALID_STEP)) {
      const smuggled = { ...VALID_STEP, [key]: FREE_TEXT };
      expect(
        SharedStepEvent.safeParse(smuggled).success,
        `field ${key} must reject free text`,
      ).toBe(false);
    }
    const validSession = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      status: "complete",
      step_count: 3,
      total_cost_micro_usd: 100,
      started_at: "2026-07-02T10:00:00Z",
      ended_at: null,
      schema_version: 1,
    };
    expect(SharedSessionEvent.safeParse(validSession).success).toBe(true);
    for (const key of Object.keys(validSession))
      expect(
        SharedSessionEvent.safeParse({ ...validSession, [key]: FREE_TEXT })
          .success,
        `session field ${key} must reject free text`,
      ).toBe(false);
  });

  it("shared events are versioned and unknown fields are refused (strict schema)", () => {
    expect(
      SharedStepEvent.safeParse({ ...VALID_STEP, notes: "extra prose" })
        .success,
    ).toBe(false);
  });

  it("the privacy policy is a repo document", () => {
    expect(
      existsSync(join(import.meta.dir, "../../../../docs/PRIVACY.md")),
    ).toBe(true);
  });
});
