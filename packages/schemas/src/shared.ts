import { z } from "zod";
import { IsoUtc, MicroUsd, SchemaVersion, Ulid } from "./scalars.ts";
import { Effort, SdlcStep } from "./telemetry.ts";

// OSS-2: the published shared-telemetry schema. Structurally no free text —
// every field is numeric, enum, or a format-pinned identifier. TEL-3's strip
// is a projection INTO this schema, so a leak is a schema violation, not a
// missed filter.
const ModelId = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/);

export const SharedStepEvent = z.strictObject({
  id: Ulid,
  session_id: Ulid,
  sdlc_step: SdlcStep,
  model: ModelId,
  effort: Effort,
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  tokens_cache_read: z.number().int().nonnegative(),
  tokens_cache_write: z.number().int().nonnegative(),
  cost_micro_usd: MicroUsd,
  budget_tokens: z.number().int().positive(),
  overrun: z.enum(["none", "soft", "paused"]),
  schema_version: SchemaVersion,
});

export const SharedSessionEvent = z.strictObject({
  id: Ulid,
  status: z.enum(["complete", "incomplete", "degraded"]),
  step_count: z.number().int().nonnegative(),
  total_cost_micro_usd: MicroUsd,
  started_at: IsoUtc,
  ended_at: IsoUtc.nullable(),
  schema_version: SchemaVersion,
});

export type SharedStepEvent = z.infer<typeof SharedStepEvent>;
export type SharedSessionEvent = z.infer<typeof SharedSessionEvent>;
