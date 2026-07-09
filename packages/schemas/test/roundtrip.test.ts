import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { z } from "zod";
import {
  AgentConfig,
  AgentsListResult,
  Artifact,
  AuthFile,
  BenchReport,
  Credential,
  DbBackupResult,
  DbStatsResult,
  DivergenceListResult,
  DoctorReport,
  DriftEvent,
  DriftListResult,
  EvalReportResult,
  IndexRebuildResult,
  InitResult,
  InterventionEvent,
  Lockfile,
  ModelRegistryEntry,
  PackLintResult,
  PackManifest,
  PackNewResult,
  PermissionRule,
  ReplayResult,
  RunManifest,
  RunResult,
  SdlcStep,
  Session,
  SessionEvent,
  SessionEventKind,
  SharedSessionEvent,
  SharedStepEvent,
  StepEvent,
  Task,
  TaskType,
  TraceLink,
  UiBenchView,
  UiEvalView,
  UiLoopView,
  UiTelemetryView,
  UiTraceView,
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
const isoDay = isoUtc.map((s) => s.slice(0, 10));
const delta = fc
  .tuple(
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
  )
  .map(([mean, a, b]) => {
    // JSON has no -0; serialize(-0) round-trips to 0 and would fail toEqual
    const z0 = (v: number): number => (v === 0 ? 0 : v);
    return {
      mean: z0(mean),
      ci95: [z0(Math.min(a, b)), z0(Math.max(a, b))] as [number, number],
    };
  });

// UX-20: divergence outcomes — `value` stays within JSON-safe primitives
// (arbitrary unknowns would trip the -0/undefined serialization edges).
const divergenceOutcome = fc.oneof(
  fc.record({
    tag: fc.constant("returned" as const),
    value: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
  }),
  fc.record({ tag: fc.constant("threw" as const), errorName: nonEmpty }),
);

const benchTaskRow = fc.record({
  task_id: nonEmpty,
  candidate_fpar: fc.constantFrom(0, 1),
  baseline_fpar: fc.constantFrom(0, 1),
  candidate_cost_micro_usd: fc.double({
    min: 0,
    max: 1_000_000,
    noNaN: true,
  }),
  baseline_cost_micro_usd: fc.double({
    min: 0,
    max: 1_000_000,
    noNaN: true,
  }),
});

const arbs: Record<string, [z.ZodType, fc.Arbitrary<unknown>]> = {
  SharedStepEvent: [
    SharedStepEvent,
    fc.record({
      id: ulid,
      session_id: ulid,
      sdlc_step: fc.constantFrom(
        "feedback",
        "ideation",
        "planning",
        "spec",
        "build",
        "verify",
      ),
      model: fc.constantFrom(
        "claude-sonnet-5",
        "claude-haiku-4-5",
        "gemma4:e4b",
      ),
      effort: fc.constantFrom("low", "medium", "high"),
      tokens_in: count,
      tokens_out: count,
      tokens_cache_read: count,
      tokens_cache_write: count,
      cost_micro_usd: fc.option(count, { nil: null }),
      budget_tokens: fc.integer({ min: 1, max: 1_000_000 }),
      overrun: fc.constantFrom("none", "soft", "paused"),
      schema_version: fc.integer({ min: 1, max: 99 }),
    }),
  ],
  SharedSessionEvent: [
    SharedSessionEvent,
    fc.record({
      id: ulid,
      status: fc.constantFrom("complete", "incomplete", "degraded"),
      step_count: fc.integer({ min: 0, max: 100000 }),
      total_cost_micro_usd: count,
      started_at: isoUtc,
      ended_at: fc.option(isoUtc, { nil: null }),
      schema_version: fc.integer({ min: 1, max: 99 }),
    }),
  ],
  Session: [
    Session,
    fc.record({
      id: ulid,
      repo: nonEmpty,
      lockfile_hash: sha256,
      harness_version: nonEmpty,
      schema_version: fc.integer({ min: 1, max: 99 }),
      status: fc.constantFrom("complete", "incomplete", "degraded"),
      runner: fc.option(fc.constantFrom("cc", "native"), { nil: null }),
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
        fc.constantFrom("input", "output", "cache_read", "claude-fable-5"),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        { maxKeys: 4 },
      ),
      cost_micro_usd: fc.option(count, { nil: null }),
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
      downstream_hash_at_link: fc.option(sha256, { nil: null }),
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
      resolved_by: fc.option(nonEmpty, { nil: null }),
      resolution_reason: fc.option(nonEmpty, { nil: null }),
      schema_version: fc.integer({ min: 1, max: 99 }),
    }),
  ],
  RunManifest: [
    RunManifest,
    fc.record({
      schema_version: fc.integer({ min: 1, max: 99 }),
      kind: fc.constantFrom("ablate", "compare"),
      suite: nonEmpty,
      suite_version: nonEmpty,
      config_a: sha256,
      config_b: sha256,
      seed: fc.nat(1_000_000),
      repeats: fc.integer({ min: 1, max: 20 }),
      // always present: .default(1) would re-add an omitted field on parse
      // and break serialize/parse equality
      concurrency: fc.integer({ min: 1, max: 32 }),
      executor: fc.constantFrom("claude", "command", "api"),
      sandbox_profile: fc.constantFrom(
        { isolation: "worktree", network: { policy: "inherit" } },
        { isolation: "container", network: { policy: "deny", allowlist: [] } },
      ),
      model_versions: fc.dictionary(from("abcdefgh", 5), nonEmpty, {
        maxKeys: 3,
      }),
      tasks: fc.array(fc.record({ id: nonEmpty, snapshot: sha256 }), {
        maxLength: 4,
      }),
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
      kernel_compat: fc.constantFrom(
        "*",
        ">=0.1 <2",
        "^1.2.0",
        "~0.3",
        "1.x",
        ">=1.0.0 || <0.2",
      ),
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
  UiTelemetryView: [
    UiTelemetryView,
    fc.record({
      empty_verb: nonEmpty,
      sessions_count: count,
      tokens_in: count,
      tokens_out: count,
      cost_micro_usd: count,
      models: fc.array(
        fc.record({
          model: nonEmpty,
          steps: fc.integer({ min: 1, max: 100000 }),
        }),
        { maxLength: 4 },
      ),
      series: fc.array(
        fc.record({ day: isoDay, tokens: count, cost_micro_usd: count }),
        { maxLength: 5 },
      ),
      sessions: fc.array(
        fc.record({
          id: ulid,
          repo: nonEmpty,
          status: fc.constantFrom("complete", "incomplete", "degraded"),
          started_at: isoUtc,
          ended_at: fc.option(isoUtc, { nil: null }),
          steps: count,
          tokens: count,
          cost_micro_usd: count,
        }),
        { maxLength: 5 },
      ),
    }),
  ],
  UiEvalView: [
    UiEvalView,
    fc.record({
      empty_verb: nonEmpty,
      runs: fc.array(
        fc.record({
          id: ulid,
          kind: fc.constantFrom("ablate", "compare", "replay"),
          suite_id: nonEmpty,
          suite_version: nonEmpty,
          started_at: isoUtc,
          finished_at: fc.option(isoUtc, { nil: null }),
          decision: fc.option(
            fc.constantFrom("helps", "hurts", "no_effect", "underpowered"),
            { nil: null },
          ),
          fpar_delta: fc.option(delta, { nil: null }),
          cost_delta_pct: fc.option(delta, { nil: null }),
          n: fc.option(count, { nil: null }),
        }),
        { maxLength: 5 },
      ),
    }),
  ],
  UiLoopView: [
    UiLoopView,
    fc.record({
      empty_verb: nonEmpty,
      proposals: fc.array(
        fc.record({
          id: ulid,
          target_pack: nonEmpty,
          state: fc.constantFrom(
            "proposed",
            "gated",
            "approved",
            "rejected",
            "applied",
            "monitoring",
            "stable",
            "reverted",
            "quarantined",
          ),
          created_by: fc.constantFrom("loop", "human"),
          rationale: fc.string({ maxLength: 100 }),
          created_at: isoUtc,
          updated_at: isoUtc,
        }),
        { maxLength: 5 },
      ),
      changelog: fc.array(
        fc.record({
          seq: fc.integer({ min: 1, max: 100000 }),
          at: isoUtc,
          action: fc.constantFrom("apply", "revert", "human_change"),
          proposal_id: fc.option(ulid, { nil: null }),
          lockfile_before: sha256,
          lockfile_after: sha256,
          evidence_summary: nonEmpty,
        }),
        { maxLength: 5 },
      ),
    }),
  ],
  UiTraceView: [
    UiTraceView,
    fc.record({
      empty_verb: nonEmpty,
      nodes: fc.array(
        fc.record({
          logical_id: nonEmpty,
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
          authority: fc.constantFrom("authored", "inferred", "confirmed"),
          tier: fc.constantFrom("T0", "T1", "T2"),
          content_hash: sha256,
          drift_open: fc.boolean(),
        }),
        { maxLength: 5 },
      ),
      edges: fc.array(
        fc.record({ upstream_id: nonEmpty, downstream_id: nonEmpty }),
        { maxLength: 5 },
      ),
    }),
  ],
  PermissionRule: [
    PermissionRule,
    fc.record(
      {
        tool: nonEmpty,
        arg: nonEmpty,
        action: fc.constantFrom("allow", "ask", "deny"),
      },
      { requiredKeys: ["tool", "action"] },
    ),
  ],
  SessionEvent: [
    SessionEvent,
    fc.record({
      id: ulid,
      session_id: ulid,
      parent_id: fc.option(ulid, { nil: null }),
      kind: fc.constantFrom(...SessionEventKind.options),
      // Keys avoid "__proto__" (Zod strips it) and values avoid -0 (JSON
      // round-trips -0 to 0) — both would fail toEqual without being bugs.
      payload: fc.dictionary(
        kebab,
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        { maxKeys: 4 },
      ),
      at: isoUtc,
      schema_version: fc.constant(1),
    }),
  ],
  ModelRegistryEntry: [
    ModelRegistryEntry,
    fc.record(
      {
        id: nonEmpty,
        provider: fc.constantFrom("anthropic", "openai-compatible"),
        base_url: nonEmpty,
        context_window: fc.integer({ min: 1, max: 10_000_000 }),
        max_output: fc.integer({ min: 1, max: 1_000_000 }),
        prices: fc.option(
          fc.record({
            in: count,
            out: count,
            cache_read: count,
            cache_write: count,
          }),
          { nil: null },
        ),
        tools: fc.boolean(),
      },
      {
        requiredKeys: [
          "id",
          "provider",
          "context_window",
          "max_output",
          "prices",
          "tools",
        ],
      },
    ),
  ],
  Credential: [
    Credential,
    fc.oneof(
      fc.record({ type: fc.constant("api_key" as const), key: nonEmpty }),
      fc.record({ type: fc.constant("token" as const), token: nonEmpty }),
      fc.record({
        type: fc.constant("oauth" as const),
        access: nonEmpty,
        refresh: nonEmpty,
        expires: isoUtc,
      }),
    ),
  ],
  AuthFile: [
    AuthFile,
    fc.dictionary(
      kebab,
      fc.oneof(
        fc.record({ type: fc.constant("api_key" as const), key: nonEmpty }),
        fc.record({ type: fc.constant("token" as const), token: nonEmpty }),
        fc.record({
          type: fc.constant("oauth" as const),
          access: nonEmpty,
          refresh: nonEmpty,
          expires: isoUtc,
        }),
      ),
      { maxKeys: 3 },
    ),
  ],
  AgentConfig: [
    AgentConfig,
    fc.record({ default_model: nonEmpty, schema_version: fc.constant(1) }),
  ],
  RunResult: [
    RunResult,
    fc.record({
      session_id: ulid,
      status: fc.constantFrom("done", "paused"),
      text: fc.string({ maxLength: 50 }),
      steps: count,
      cost_micro_usd: fc.option(count, { nil: null }),
      schema_version: fc.constant(1),
    }),
  ],
  InitResult: [
    InitResult,
    fc.record({
      store_path: nonEmpty,
      lockfile: fc.constantFrom("created" as const, "existing" as const),
      hooked: fc.array(nonEmpty, { maxLength: 4 }),
      schema_version: fc.constant(1),
    }),
  ],
  PackLintResult: [
    PackLintResult,
    fc.record({
      ok: fc.boolean(),
      required_bump: fc.constantFrom(
        "major" as const,
        "minor" as const,
        "patch" as const,
        "none" as const,
      ),
      prev_version: nonEmpty,
      next_version: nonEmpty,
      schema_version: fc.constant(1),
    }),
  ],
  BenchReport: [
    BenchReport,
    fc.record({
      run_id: nonEmpty,
      suite: nonEmpty,
      candidate: fc.constantFrom(
        "claude" as const,
        "command" as const,
        "api" as const,
      ),
      baseline: fc.constantFrom(
        "claude" as const,
        "command" as const,
        "api" as const,
      ),
      rows: fc.array(benchTaskRow, { maxLength: 4 }),
      verdict: fc.record({
        id: ulid,
        run_id: ulid,
        decision: fc.constantFrom(
          "helps" as const,
          "hurts" as const,
          "no_effect" as const,
          "underpowered" as const,
        ),
        fpar_delta: delta,
        cost_delta_pct: delta,
        n: fc.nat(100),
        alpha: fc.constant(0.05),
        bootstrap_resamples: fc.integer({ min: 1, max: 10_000 }),
        quarantined_tasks: fc.array(nonEmpty, { maxLength: 3 }),
      }),
      manifest_hash: nonEmpty,
      schema_version: fc.constant(1),
    }),
  ],
  DoctorReport: [
    DoctorReport,
    fc.record({
      ok: fc.boolean(),
      components: fc.array(
        fc.record({
          name: fc.constantFrom("store", "lockfile", "auth", "telemetry"),
          status: fc.constantFrom("pass", "warn", "fail"),
          detail: nonEmpty,
          fix: fc.option(nonEmpty, { nil: null }),
        }),
        { maxLength: 4 },
      ),
      schema_version: fc.constant(1),
    }),
  ],
  DivergenceListResult: [
    DivergenceListResult,
    fc.record({
      reports: fc.array(
        fc.record({
          id: nonEmpty,
          spec_hash: nonEmpty,
          clause_ids: fc.array(nonEmpty, { maxLength: 3 }),
          entries: fc.array(
            fc.record({
              clause_id: nonEmpty,
              // keys avoid "__proto__", values avoid -0 (SessionEvent note)
              probe_input: fc.dictionary(
                kebab,
                fc.oneof(
                  fc.string(),
                  fc.integer(),
                  fc.boolean(),
                  fc.constant(null),
                ),
                { maxKeys: 3 },
              ),
              differing_path: fc.string({ maxLength: 20 }),
              outcome_a: divergenceOutcome,
              outcome_b: divergenceOutcome,
              redacted_paths: fc.array(fc.string({ maxLength: 10 }), {
                maxLength: 2,
              }),
            }),
            { maxLength: 2 },
          ),
          resolved: fc.boolean(),
          at: isoUtc,
        }),
        { maxLength: 3 },
      ),
      schema_version: fc.constant(1),
    }),
  ],
  PackNewResult: [
    PackNewResult,
    fc.record({
      dir: nonEmpty,
      files: fc.array(nonEmpty, { maxLength: 5 }),
      schema_version: fc.constant(1),
    }),
  ],
  DriftListResult: [
    DriftListResult,
    fc.record({
      survival: fc.array(
        fc.record({ logical_id: nonEmpty, sessions_survived: count }),
        { maxLength: 4 },
      ),
      collapsed: fc.boolean(),
      items: fc.array(
        fc.record({
          artifact_id: nonEmpty,
          module: nonEmpty,
          direction: fc.constantFrom(
            "code_under_spec",
            "spec_over_code",
            "upstream_stale",
          ),
          authority: fc.constantFrom("authored", "inferred", "confirmed"),
          detected_at: isoUtc,
        }),
        { maxLength: 4 },
      ),
      modules: fc.array(
        fc.record({ module: nonEmpty, blocking: count, informational: count }),
        { maxLength: 3 },
      ),
      schema_version: fc.constant(1),
    }),
  ],
  EvalReportResult: [
    EvalReportResult,
    fc.record({
      runs: fc.array(
        fc.record({
          run_id: ulid,
          kind: fc.constantFrom("ablate", "compare", "replay"),
          suite_id: nonEmpty,
          suite_version: nonEmpty,
          finished_at: fc.option(isoUtc, { nil: null }),
          decision: fc.constantFrom(
            "helps",
            "hurts",
            "no_effect",
            "underpowered",
          ),
          fpar_delta: delta,
          cost_delta_pct: delta,
          n: fc.nat(100),
          alpha: fc.constant(0.05),
        }),
        { maxLength: 3 },
      ),
      schema_version: fc.constant(1),
    }),
  ],
  ReplayResult: [
    ReplayResult,
    fc.record({
      record: fc.record({
        id: ulid,
        source_session_id: nonEmpty,
        snapshot_ref: sha256,
        config: sha256,
        run_id: fc.option(ulid, { nil: null }),
        outcome: fc.record({
          fpar_pass: fc.boolean(),
          cost_micro_usd: count,
          original_fpar_pass: fc.boolean(),
          original_cost_micro_usd: count,
        }),
        validity: fc.constantFrom("valid", "advisory"),
        advisory_reason: fc.option(
          fc.constantFrom(
            "snapshot_hash_mismatch",
            "model_mismatch",
            "source_session_not_complete",
          ),
          { nil: null },
        ),
        at: isoUtc,
        schema_version: fc.constant(1),
      }),
      schema_version: fc.constant(1),
    }),
  ],
  AgentsListResult: [
    AgentsListResult,
    fc.record({
      registry_dir: nonEmpty,
      agents: fc.array(
        fc.record({
          schema_version: fc.constant(1),
          id: kebab,
          kind: fc.constantFrom("base_model", "subagent", "custom_agent"),
          // .default([])/.default({}) fields must always be present in the
          // arbitrary, or parse() fills them and toEqual fails
          capabilities: fc.array(
            fc.record(
              {
                domain: nonEmpty,
                lang: nonEmpty,
                task_type: fc.constantFrom(...TaskType.options),
                step: fc.constantFrom(...SdlcStep.options),
              },
              { requiredKeys: [] },
            ),
            { maxLength: 2 },
          ),
          cost_class: fc.integer({ min: 1, max: 5 }),
          constraints: fc.oneof(
            fc.constant({}),
            fc.record({
              max_context_tokens: fc.integer({ min: 1, max: 1_000_000 }),
            }),
          ),
          endpoint: fc.record({
            type: fc.constantFrom("base_model", "claude_subagent"),
            ref: nonEmpty,
          }),
        }),
        { maxLength: 2 },
      ),
      schema_version: fc.constant(1),
    }),
  ],
  IndexRebuildResult: [
    IndexRebuildResult,
    fc.record({
      ingested: count,
      changed: count,
      discrepancies: count,
      schema_version: fc.constant(1),
    }),
  ],
  DbStatsResult: [
    DbStatsResult,
    fc.record({
      path: nonEmpty,
      size_bytes: count,
      tables: fc.array(fc.record({ name: nonEmpty, rows: count }), {
        maxLength: 4,
      }),
      schema_version: fc.constant(1),
    }),
  ],
  DbBackupResult: [
    DbBackupResult,
    fc.record({
      source: nonEmpty,
      dest: nonEmpty,
      size_bytes: count,
      tables: fc.array(fc.record({ name: nonEmpty, rows: count }), {
        maxLength: 4,
      }),
      schema_version: fc.constant(1),
    }),
  ],
  UiBenchView: [
    UiBenchView,
    fc.record({
      empty_verb: nonEmpty,
      runs: fc.array(
        fc.record({
          id: ulid,
          suite_id: nonEmpty,
          suite_version: nonEmpty,
          candidate: fc.constantFrom("claude", "command", "api"),
          baseline: fc.constantFrom("claude", "command", "api"),
          started_at: isoUtc,
          finished_at: fc.option(isoUtc, { nil: null }),
          decision: fc.option(
            fc.constantFrom("helps", "hurts", "no_effect", "underpowered"),
            { nil: null },
          ),
          fpar_delta: fc.option(delta, { nil: null }),
          cost_delta_pct: fc.option(delta, { nil: null }),
          n: fc.option(fc.nat(100), { nil: null }),
          rows: fc.array(benchTaskRow, { maxLength: 3 }),
        }),
        { maxLength: 2 },
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
    expect(
      PackManifest.safeParse({
        schema_version: 1,
        name: "x",
        version: "1.0.0",
        kind: "efficiency",
        kernel_compat: "not a range",
        capabilities: ["rules"],
        description: "d",
      }).success,
    ).toBe(false);
  });

  it("unit_prices keys: non-identifier keys rejected; proto-polluting keys structurally stripped (found by CI PBT seed)", () => {
    const base = {
      id: "0".repeat(26),
      task_id: "0".repeat(26),
      session_id: "0".repeat(26),
      sdlc_step: "build",
      model: "m",
      effort: "low",
      agent_id: "a",
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost_micro_usd: 0,
      budget_tokens: 1,
      overrun: "none",
      span_id: null,
      schema_version: 1,
    };
    expect(
      StepEvent.safeParse({ ...base, unit_prices: { "Not A Key!": 0 } })
        .success,
    ).toBe(false);
    const stripped = StepEvent.safeParse({
      ...base,
      unit_prices: JSON.parse('{"__proto__": 0, "input": 0.5}'),
    });
    expect(stripped.success).toBe(true);
    if (stripped.success) {
      expect(Object.keys(stripped.data.unit_prices)).toEqual(["input"]);
      expect(Object.hasOwn(stripped.data.unit_prices, "__proto__")).toBe(false);
    }
    expect(
      StepEvent.safeParse({ ...base, unit_prices: { input: 0.5 } }).success,
    ).toBe(true);
  });
});
