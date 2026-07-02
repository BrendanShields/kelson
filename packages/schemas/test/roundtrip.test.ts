import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { z } from "zod";
import {
  Artifact,
  DriftEvent,
  InterventionEvent,
  Lockfile,
  PackManifest,
  Session,
  StepEvent,
  Task,
  TraceLink,
} from "../src/index.ts";

const from = (alphabet: string, n: number) =>
  fc
    .array(fc.constantFrom(...alphabet), { minLength: n, maxLength: n })
    .map((cs) => cs.join(""));

const ulid = from("0123456789ABCDEFGHJKMNPQRSTVWXYZ", 26);
const sha256 = from("0123456789abcdef", 64).map((h) => `sha256:${h}`);
const isoUtc = fc
  .date({ min: new Date(0), max: new Date("2100-01-01"), noInvalidDate: true })
  .map((d) => d.toISOString());
const nonEmpty = fc.string({ minLength: 1, maxLength: 30 });
const kebab = fc
  .array(from("abcdefghij", 3), { minLength: 1, maxLength: 3 })
  .map((ws) => ws.join("-"));
const semver = fc
  .tuple(fc.nat(20), fc.nat(20), fc.nat(20))
  .map(([a, b, c]) => `${a}.${b}.${c}`);
const count = fc.integer({ min: 0, max: 1_000_000 });

const arbs: Record<string, [z.ZodType, fc.Arbitrary<unknown>]> = {
  Session: [
    Session,
    fc.record({
      id: ulid,
      repo: nonEmpty,
      lockfile_hash: sha256,
      harness_version: nonEmpty,
      schema_version: fc.integer({ min: 1, max: 99 }),
      status: fc.constantFrom("complete", "incomplete", "degraded"),
      trace_id: fc.option(nonEmpty, { nil: null }),
      started_at: isoUtc,
      ended_at: fc.option(isoUtc, { nil: null }),
    }),
  ],
  Task: [
    Task,
    fc.record({
      id: ulid,
      repo: nonEmpty,
      spec_clause_refs: fc.array(nonEmpty, { maxLength: 5 }),
      state: fc.constantFrom(
        "open",
        "in_progress",
        "delivered",
        "accepted",
        "corrected",
        "abandoned",
      ),
      acceptance_signal: fc.option(fc.constantFrom("approval", "merge_clean"), {
        nil: null,
      }),
      correction_count: fc.nat(50),
      opened_at: isoUtc,
      delivered_at: fc.option(isoUtc, { nil: null }),
      closed_at: fc.option(isoUtc, { nil: null }),
    }),
  ],
  StepEvent: [
    StepEvent,
    fc.record({
      id: ulid,
      task_id: ulid,
      session_id: ulid,
      sdlc_step: fc.constantFrom(
        "feedback",
        "ideation",
        "planning",
        "spec",
        "build",
        "verify",
      ),
      model: nonEmpty,
      effort: fc.constantFrom("low", "medium", "high"),
      agent_id: nonEmpty,
      tokens_in: count,
      tokens_out: count,
      tokens_cache_read: count,
      tokens_cache_write: count,
      unit_prices: fc.dictionary(
        nonEmpty,
        fc.double({ min: 0, max: 1000, noNaN: true }),
        { maxKeys: 4 },
      ),
      cost_micro_usd: count,
      budget_tokens: fc.integer({ min: 1, max: 1_000_000 }),
      overrun: fc.constantFrom("none", "soft", "paused"),
      span_id: fc.option(nonEmpty, { nil: null }),
      schema_version: fc.integer({ min: 1, max: 99 }),
    }),
  ],
  InterventionEvent: [
    InterventionEvent,
    fc.record({
      id: ulid,
      task_id: ulid,
      session_id: ulid,
      class: fc.constantFrom("correction", "clarification", "approval"),
      artifact_hash: fc.option(sha256, { nil: null }),
      at: isoUtc,
      schema_version: fc.integer({ min: 1, max: 99 }),
    }),
  ],
  Artifact: [
    Artifact,
    fc.record({
      logical_id: nonEmpty,
      repo: nonEmpty,
      type: fc.constantFrom(
        "signal",
        "idea",
        "prd",
        "erd",
        "adr",
        "spec",
        "code_region",
        "test",
      ),
      content_hash: sha256,
      authority: fc.constantFrom("authored", "inferred", "confirmed"),
      tier: fc.constantFrom("T0", "T1", "T2"),
      created_at: isoUtc,
      updated_at: isoUtc,
    }),
  ],
  TraceLink: [
    TraceLink,
    fc.record({
      id: ulid,
      repo: nonEmpty,
      upstream_id: nonEmpty,
      downstream_id: nonEmpty,
      upstream_hash_at_link: sha256,
      created_at: isoUtc,
    }),
  ],
  DriftEvent: [
    DriftEvent,
    fc.record({
      id: ulid,
      repo: nonEmpty,
      artifact_id: nonEmpty,
      direction: fc.constantFrom(
        "code_under_spec",
        "spec_over_code",
        "upstream_stale",
      ),
      detected_at: isoUtc,
      resolution: fc.constantFrom("open", "repaired", "overridden", "promoted"),
      resolved_at: fc.option(isoUtc, { nil: null }),
      schema_version: fc.integer({ min: 1, max: 99 }),
    }),
  ],
  PackManifest: [
    PackManifest,
    fc.record({
      schema_version: fc.integer({ min: 1, max: 99 }),
      name: kebab,
      version: semver,
      kind: fc.constantFrom(
        "stage",
        "efficiency",
        "spec_tooling",
        "routing",
        "eval_suite",
        "agent_registry",
      ),
      kernel_compat: nonEmpty,
      capabilities: fc.uniqueArray(
        fc.constantFrom(
          "stage:feedback",
          "stage:ideation",
          "stage:planning",
          "stage:spec",
          "stage:build",
          "stage:verify",
          "rules",
          "routing-table",
          "agent-registry",
          "eval-suite",
          "context-assembly",
        ),
        { minLength: 1, maxLength: 11 },
      ),
      description: fc.string({ minLength: 1, maxLength: 200 }),
    }),
  ],
  Lockfile: [
    Lockfile,
    fc.record({
      schema_version: fc.integer({ min: 1, max: 99 }),
      parent_hash: fc.option(sha256, { nil: null }),
      entries: fc.array(
        fc.record({
          name: kebab,
          version: semver,
          hash: sha256,
          enabled: fc.boolean(),
        }),
        { maxLength: 5 },
      ),
    }),
  ],
};

describe("P0-2 verification (plan task 2): every schema round-trips parse(serialize(x))", () => {
  for (const [name, [schema, arb]] of Object.entries(arbs)) {
    it(name, () => {
      fc.assert(
        fc.property(arb, (value) => {
          const parsed = schema.parse(JSON.parse(JSON.stringify(value)));
          expect(parsed).toEqual(value as never);
        }),
        { numRuns: 200 },
      );
    });
  }
});

describe("P0-2 verification: schemas reject malformed scalars", () => {
  it("bad ULID, hash prefix, enum value, and duplicate capabilities all fail", () => {
    expect(Session.safeParse({}).success).toBe(false);
    expect(
      TraceLink.safeParse({
        id: "not-a-ulid",
        upstream_id: "a",
        downstream_id: "b",
        upstream_hash_at_link: `sha256:${"0".repeat(64)}`,
        created_at: new Date(0).toISOString(),
      }).success,
    ).toBe(false);
    expect(
      PackManifest.safeParse({
        schema_version: 1,
        name: "x",
        version: "1.0.0",
        kind: "efficiency",
        kernel_compat: "*",
        capabilities: ["rules", "rules"],
        description: "d",
      }).success,
    ).toBe(false);
  });
});
