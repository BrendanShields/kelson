import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { readDecision, route } from "../../src/routing.ts";
import { openDb } from "../../src/storage.ts";
import { POLICY, REGISTRY, vectorArb } from "../routing-helpers.ts";

describe("RTR-1: the router selects from the active policy and records the decision + feature vector in telemetry", () => {
  it("PBT: for any feature vector, the target is present in the registry and the decision round-trips", () => {
    const ids = new Set(REGISTRY.map((e) => e.id));
    fc.assert(
      fc.property(vectorArb, (vector) => {
        const db = openDb(":memory:");
        const decision = route(db, {
          policy: POLICY,
          registry: REGISTRY,
          vector,
          taskId: "t1",
          stepId: "s1",
        });
        expect(ids.has(decision.target)).toBe(true);
        expect(decision.feature_vector).toEqual(vector);
        expect(readDecision(db, decision.id)).toEqual(decision);
        db.close();
      }),
      { numRuns: 150 },
    );
  });

  it("a policy naming an unregistered target refuses to route", () => {
    const db = openDb(":memory:");
    const bad = {
      ...POLICY,
      default: { ...POLICY.default, target: "ghost" },
    };
    expect(() =>
      route(db, {
        policy: bad,
        registry: REGISTRY,
        vector: {
          step: "build",
          tier: "T0",
          size: "M",
          lang: "typescript",
          novelty: 1,
          novelty_bucket: "high",
          task_type: "standard",
          repo: "r",
        },
        taskId: "t",
        stepId: "s",
      }),
    ).toThrow(/ghost/);
    db.close();
  });
});
