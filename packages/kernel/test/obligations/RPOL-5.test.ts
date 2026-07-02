import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, matchAgent } from "../../src/routing.ts";
import { tmpDir } from "../eval-helpers.ts";
import { entry } from "../routing-helpers.ts";

const VECTOR = {
  step: "build",
  tier: "T0",
  size: "M",
  lang: "typescript",
  novelty: 1,
  novelty_bucket: "high",
  task_type: "standard",
  repo: "r",
} as const;

describe("RPOL-5: registry entries validate against the schema; matching is most-specific-wins / cost-tiebreak / default-fallback", () => {
  it("the loader validates entries and rejects malformed ones", () => {
    const dir = join(tmpDir(), "agents");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "good.yaml"),
      JSON.stringify(entry("good-agent", 2)),
    );
    expect(loadRegistry(dir).map((e) => e.id)).toEqual(["good-agent"]);
    writeFileSync(
      join(dir, "bad.yaml"),
      JSON.stringify({ schema_version: 1, id: "bad", cost_class: 0 }),
    );
    expect(() => loadRegistry(dir)).toThrow();
  });

  it("match, multi-match specificity, cost tie, and no-match fallback", () => {
    const a = entry("a-two-fields", 3, {
      kind: "custom_agent",
      capabilities: [{ domain: "payments", lang: "typescript" }],
    });
    const b = entry("b-one-field", 2, {
      kind: "custom_agent",
      capabilities: [{ lang: "typescript" }],
    });
    const c = entry("c-one-field-cheap", 1, {
      kind: "custom_agent",
      capabilities: [{ lang: "typescript" }],
    });

    // Single match.
    expect(matchAgent([a], VECTOR, "payments")?.id).toBe("a-two-fields");
    // Specificity beats cost: two fields > one field.
    expect(matchAgent([a, b, c], VECTOR, "payments")?.id).toBe("a-two-fields");
    // Tie on specificity → lower cost_class.
    expect(matchAgent([b, c], VECTOR)?.id).toBe("c-one-field-cheap");
    // No match → null (caller falls back to the policy target).
    expect(matchAgent([a], VECTOR, "billing")).toBeNull();
    expect(
      matchAgent([a], { ...VECTOR, lang: "python" }, "payments"),
    ).toBeNull();
    // base_model entries never capability-match.
    expect(matchAgent([entry("plain", 1)], VECTOR)).toBeNull();
  });
});
