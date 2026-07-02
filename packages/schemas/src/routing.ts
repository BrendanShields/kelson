import { z } from "zod";
import { Tier } from "./artifacts.ts";
import { IsoUtc, KebabName, SchemaVersion, Sha256, Ulid } from "./scalars.ts";
import { Effort, SdlcStep } from "./telemetry.ts";

export const TaskSize = z.enum(["S", "M", "L"]);
export const NoveltyBucket = z.enum(["low", "mid", "high"]);
export const TaskType = z.enum(["standard", "mechanical"]);

// RPOL-2: every feature per the normative table, with declared fallbacks.
export const FeatureVector = z.strictObject({
  step: SdlcStep,
  tier: Tier,
  size: TaskSize,
  lang: z.string().min(1),
  novelty: z.number().min(0).max(1),
  novelty_bucket: NoveltyBucket,
  task_type: TaskType,
  repo: z.string().min(1),
});

export const RuleMatch = z.strictObject({
  step: SdlcStep.optional(),
  tier: Tier.optional(),
  size: TaskSize.optional(),
  lang: z.string().min(1).optional(),
  novelty: NoveltyBucket.optional(),
  task_type: TaskType.optional(),
  repo: z.string().min(1).optional(),
});

const targetFields = {
  target: z.string().min(1),
  effort: Effort,
  loadout: z.array(z.string().min(1)).default([]),
  budget_tokens: z.number().int().positive(),
  escalation: z.array(z.string().min(1)).default([]),
};

export const RouteTargetSpec = z.strictObject(targetFields);

export const RoutingRule = z.strictObject({
  match: RuleMatch,
  ...targetFields,
});

// RPOL-1: default is required — routing is a total function.
export const RoutingPolicy = z.strictObject({
  schema_version: SchemaVersion,
  rules: z.array(RoutingRule).default([]),
  default: RouteTargetSpec,
});

export const AgentCapability = z.strictObject({
  domain: z.string().min(1).optional(),
  lang: z.string().min(1).optional(),
  task_type: TaskType.optional(),
  step: SdlcStep.optional(),
});

export const AgentEndpoint = z.strictObject({
  type: z.enum(["base_model", "claude_subagent"]),
  ref: z.string().min(1),
});

export const AgentRegistryEntry = z.strictObject({
  schema_version: SchemaVersion,
  id: KebabName,
  kind: z.enum(["base_model", "subagent", "custom_agent"]),
  capabilities: z.array(AgentCapability).default([]),
  cost_class: z.number().int().min(1),
  constraints: z
    .strictObject({
      max_context_tokens: z.number().int().positive().optional(),
    })
    .default({}),
  endpoint: AgentEndpoint,
});

// RTR-1: the decision and its feature vector, recorded in telemetry.
// RTR-2: an escalation decision is the routing-regret event (regret: true).
export const RoutingDecision = z.strictObject({
  id: Ulid,
  task_id: z.string().min(1),
  step_id: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  kind: z.enum(["initial", "escalation"]),
  feature_vector: FeatureVector,
  rule_index: z.number().int().min(-1), // -1 = the default rule
  matched_by: z.enum(["rule", "capability"]),
  target: z.string().min(1),
  effort: Effort,
  loadout: z.array(z.string()),
  budget_tokens: z.number().int().positive(),
  escalation: z.array(z.string()),
  policy_hash: Sha256,
  regret: z.boolean(),
  at: IsoUtc,
  schema_version: SchemaVersion,
});

// RPOL-6: minimal attribution set on every overrun event.
export const OverrunAttribution = z.strictObject({
  task_id: z.string().min(1),
  step_id: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  rule_id: z.string().min(1),
  policy_hash: Sha256,
  model_id: z.string().min(1),
  escalation_depth: z.number().int().nonnegative(),
  budget_tokens: z.number().int().positive(),
  used_tokens: z.number().int().nonnegative(),
  ratio: z.number().nonnegative(),
});

export const BudgetEvent = z.discriminatedUnion("kind", [
  z.strictObject({
    id: Ulid,
    kind: z.literal("overrun"),
    step_id: z.string().min(1),
    threshold: z.union([z.literal(1), z.literal(2)]),
    attribution: OverrunAttribution,
    at: IsoUtc,
    schema_version: SchemaVersion,
  }),
  z.strictObject({
    id: Ulid,
    kind: z.literal("triage_requested"),
    step_id: z.string().min(1),
    options: z.array(z.enum(["continue", "escalate", "re_spec"])),
    escalations_used: z.number().int().nonnegative(),
    at: IsoUtc,
    schema_version: SchemaVersion,
  }),
  z.strictObject({
    id: Ulid,
    kind: z.literal("triage_resolved"),
    step_id: z.string().min(1),
    action: z.enum(["continue", "escalate", "re_spec", "block"]),
    actor: z.enum(["human", "auto"]),
    reason: z.string().nullable(),
    at: IsoUtc,
    schema_version: SchemaVersion,
  }),
]);

// CTX-1/CTX-5: manifest + count + tokenizer identity on every bundle event.
export const BundleManifestEntry = z.strictObject({
  kind: z.enum(["statement", "clause", "signature", "invariant", "loadout"]),
  ref: z.string().min(1),
  hash: Sha256,
  tokens: z.number().int().nonnegative(),
});

export const BundleEvent = z.strictObject({
  id: Ulid,
  task_id: z.string().min(1),
  tokenizer: z.string().min(1),
  token_count: z.number().int().nonnegative(),
  manifest: z.array(BundleManifestEntry),
  at: IsoUtc,
  schema_version: SchemaVersion,
});

export const BundleMissEvent = z.strictObject({
  id: Ulid,
  bundle_id: Ulid,
  ref: z.string().min(1),
  tokens: z.number().int().nonnegative(),
  at: IsoUtc,
  schema_version: SchemaVersion,
});

export type TaskSize = z.infer<typeof TaskSize>;
export type NoveltyBucket = z.infer<typeof NoveltyBucket>;
export type TaskType = z.infer<typeof TaskType>;
export type FeatureVector = z.infer<typeof FeatureVector>;
export type RuleMatch = z.infer<typeof RuleMatch>;
export type RouteTargetSpec = z.infer<typeof RouteTargetSpec>;
export type RoutingRule = z.infer<typeof RoutingRule>;
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;
export type AgentCapability = z.infer<typeof AgentCapability>;
export type AgentEndpoint = z.infer<typeof AgentEndpoint>;
export type AgentRegistryEntry = z.infer<typeof AgentRegistryEntry>;
export type RoutingDecision = z.infer<typeof RoutingDecision>;
export type OverrunAttribution = z.infer<typeof OverrunAttribution>;
export type BudgetEvent = z.infer<typeof BudgetEvent>;
export type BundleManifestEntry = z.infer<typeof BundleManifestEntry>;
export type BundleEvent = z.infer<typeof BundleEvent>;
export type BundleMissEvent = z.infer<typeof BundleMissEvent>;
