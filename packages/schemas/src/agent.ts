import { z } from "zod";
import { IsoUtc, MicroUsd, SchemaVersion, Ulid } from "./scalars.ts";

export const PermissionAction = z.enum(["allow", "ask", "deny"]);

export const PermissionRule = z.object({
  tool: z.string().min(1),
  arg: z.string().min(1).optional(),
  action: PermissionAction,
});

// ERD §5 native-runtime kinds; AGT-6: pauses reuse permission_request, no
// dedicated pause kind.
export const SessionEventKind = z.enum([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "permission_request",
  "permission_decision",
  "compaction",
  "head_moved",
  "session_meta",
]);

export const SessionEvent = z.object({
  id: Ulid,
  session_id: Ulid,
  parent_id: Ulid.nullable(),
  kind: SessionEventKind,
  payload: z.record(z.string(), z.unknown()),
  at: IsoUtc,
  schema_version: SchemaVersion,
});

// UX-34: session tree node — the ChatWidget `tree` variant's node shape.
export const SessionTreeNode = z.strictObject({
  id: Ulid,
  label: z.string(),
  parent: Ulid.nullable(),
});
export type SessionTreeNode = z.infer<typeof SessionTreeNode>;

// Micro-USD per million tokens, one price per StepEvent token class.
export const ModelPrices = z.object({
  in: MicroUsd,
  out: MicroUsd,
  cache_read: MicroUsd,
  cache_write: MicroUsd,
});

export const ModelRegistryEntry = z.object({
  id: z.string().min(1),
  provider: z.enum(["anthropic", "openai-compatible"]),
  base_url: z.string().min(1).optional(),
  context_window: z.number().int().positive(),
  max_output: z.number().int().positive(),
  // null = price unknown; PROV-3 forbids estimating.
  prices: ModelPrices.nullable(),
  tools: z.boolean(),
});

export const Credential = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api_key"), key: z.string().min(1) }),
  // PROV-5: long-lived subscription bearer token (`claude setup-token`).
  z.object({ type: z.literal("token"), token: z.string().min(1) }),
  z.object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: IsoUtc,
  }),
]);

export const AuthFile = z.record(z.string().min(1), Credential);

export const AgentConfig = z.object({
  default_model: z.string().min(1),
  schema_version: SchemaVersion,
});

// UX-15: obligato run --json final result.
export const RunResult = z.object({
  session_id: Ulid,
  status: z.enum(["done", "paused"]),
  text: z.string(),
  steps: z.number().int().nonnegative(),
  // null = unknown price (PROV-3)
  cost_micro_usd: MicroUsd.nullable(),
  schema_version: SchemaVersion,
});

export type PermissionAction = z.infer<typeof PermissionAction>;
export type PermissionRule = z.infer<typeof PermissionRule>;
export type SessionEventKind = z.infer<typeof SessionEventKind>;
export type SessionEvent = z.infer<typeof SessionEvent>;
export type ModelPrices = z.infer<typeof ModelPrices>;
export type ModelRegistryEntry = z.infer<typeof ModelRegistryEntry>;
export type Credential = z.infer<typeof Credential>;
export type AuthFile = z.infer<typeof AuthFile>;
export type AgentConfig = z.infer<typeof AgentConfig>;
export type RunResult = z.infer<typeof RunResult>;
