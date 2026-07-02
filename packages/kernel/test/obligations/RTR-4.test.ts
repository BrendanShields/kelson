import { describe, expect, it } from "bun:test";
import type { AgentRegistryEntry } from "@kelson/schemas";
import { route } from "../../src/routing.ts";
import { openDb } from "../../src/storage.ts";
import { entry, POLICY, REGISTRY } from "../routing-helpers.ts";

const CUSTOM: AgentRegistryEntry = entry("payments-migrator", 3, {
  kind: "custom_agent",
  capabilities: [{ domain: "payments", lang: "typescript" }],
});

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

describe("RTR-4: capability-matched custom agents are routable; no match falls back to the default agent", () => {
  it("capability match routes to the custom agent", () => {
    const db = openDb(":memory:");
    const decision = route(db, {
      policy: POLICY,
      registry: [...REGISTRY, CUSTOM],
      vector: VECTOR,
      taskId: "t",
      stepId: "s",
      domain: "payments",
    });
    expect(decision.target).toBe("payments-migrator");
    db.close();
  });

  it("no capability match falls back to the policy target", () => {
    const db = openDb(":memory:");
    const decision = route(db, {
      policy: POLICY,
      registry: [...REGISTRY, CUSTOM],
      vector: VECTOR,
      taskId: "t",
      stepId: "s",
      domain: "billing",
    });
    expect(decision.target).toBe("mid-tier");
    db.close();
  });

  it("ambiguous match: most specific wins", () => {
    const generic = entry("ts-generalist", 2, {
      kind: "custom_agent",
      capabilities: [{ lang: "typescript" }],
    });
    const db = openDb(":memory:");
    const decision = route(db, {
      policy: POLICY,
      registry: [...REGISTRY, generic, CUSTOM],
      vector: VECTOR,
      taskId: "t",
      stepId: "s",
      domain: "payments",
    });
    // CUSTOM specifies two fields, generic one — most specific wins even at
    // higher cost_class.
    expect(decision.target).toBe("payments-migrator");
    db.close();
  });
});
