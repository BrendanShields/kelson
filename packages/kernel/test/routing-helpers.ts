import type {
  AgentRegistryEntry,
  FeatureVector,
  RoutingPolicy,
} from "@kelson/schemas";
import fc from "fast-check";

export const vectorArb: fc.Arbitrary<FeatureVector> = fc
  .record({
    step: fc.constantFrom(
      "feedback",
      "ideation",
      "planning",
      "spec",
      "build",
      "verify",
    ),
    tier: fc.constantFrom("T0", "T1", "T2"),
    size: fc.constantFrom("S", "M", "L"),
    lang: fc.constantFrom("typescript", "python", "rust", "unknown"),
    novelty: fc.double({ min: 0, max: 1, noNaN: true }),
    task_type: fc.constantFrom("standard", "mechanical"),
    repo: fc.constantFrom("r1", "r2"),
  })
  .map((v) => ({
    ...v,
    novelty_bucket: v.novelty < 0.3 ? "low" : v.novelty > 0.7 ? "high" : "mid",
  })) as fc.Arbitrary<FeatureVector>;

export const entry = (
  id: string,
  costClass: number,
  over: Partial<AgentRegistryEntry> = {},
): AgentRegistryEntry => ({
  schema_version: 1,
  id,
  kind: "base_model",
  capabilities: [],
  cost_class: costClass,
  constraints: {},
  endpoint: { type: "base_model", ref: `model-${id}` },
  ...over,
});

export const REGISTRY: AgentRegistryEntry[] = [
  entry("small", 1),
  entry("mid-tier", 2),
  entry("frontier", 3),
];

export const POLICY: RoutingPolicy = {
  schema_version: 1,
  rules: [
    {
      match: { task_type: "mechanical", tier: "T0" },
      target: "small",
      effort: "low",
      loadout: [],
      budget_tokens: 8000,
      escalation: ["mid-tier", "frontier"],
    },
    {
      match: { step: "build", tier: "T0" },
      target: "mid-tier",
      effort: "medium",
      loadout: [],
      budget_tokens: 20000,
      escalation: ["frontier"],
    },
  ],
  default: {
    target: "frontier",
    effort: "high",
    loadout: [],
    budget_tokens: 40000,
    escalation: [],
  },
};
