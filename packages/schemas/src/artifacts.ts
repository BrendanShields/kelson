import { z } from "zod";
import { IsoUtc, SchemaVersion, Sha256, Ulid } from "./scalars.ts";

export const ArtifactType = z.enum([
  "signal",
  "idea",
  "prd",
  "erd",
  "adr",
  "spec",
  "code_region",
  "test",
]);
export const Authority = z.enum(["authored", "inferred", "confirmed"]);
export const Tier = z.enum(["T0", "T1", "T2"]);
export const DriftDirection = z.enum([
  "code_under_spec",
  "spec_over_code",
  "upstream_stale",
]);
export const DriftResolution = z.enum([
  "open",
  "repaired",
  "overridden",
  "promoted",
]);

export const Artifact = z.object({
  logical_id: z.string().min(1),
  repo: z.string().min(1),
  type: ArtifactType,
  content_hash: Sha256,
  authority: Authority,
  tier: Tier,
  created_at: IsoUtc,
  updated_at: IsoUtc,
});

export const TraceLink = z.object({
  id: Ulid,
  repo: z.string().min(1),
  upstream_id: z.string().min(1),
  downstream_id: z.string().min(1),
  upstream_hash_at_link: Sha256,
  created_at: IsoUtc,
});

export const DriftEvent = z.object({
  id: Ulid,
  repo: z.string().min(1),
  artifact_id: z.string().min(1),
  direction: DriftDirection,
  detected_at: IsoUtc,
  resolution: DriftResolution,
  resolved_at: IsoUtc.nullable(),
  schema_version: SchemaVersion,
});

export type Artifact = z.infer<typeof Artifact>;
export type TraceLink = z.infer<typeof TraceLink>;
export type DriftEvent = z.infer<typeof DriftEvent>;
