# ADR-0004: Vercel AI SDK for the Native Runtime's LLM Layer

- **Status:** Accepted (draft written at Phase 6 planning; PIPE-4).
- **Date:** 2026-07-03
- **Traceability:** shapes [standalone-harness design](../specs/2026-07-03-standalone-harness-design.md), [agent-runtime spec](../specs/2026-07-03-agent-runtime.md) (`PROV-*`, `AGT-1`), [ERD §9](../specs/2026-07-02-agent-harness-erd.md)

## Context

Phases 6–10 give Kelson its own agent loop (`packages/agent`) instead of mediating
every session through the `claude` CLI. The loop needs an LLM client: streaming,
tool calling, multi-provider (Anthropic, Ollama, any OpenAI-compatible endpoint),
usage reporting. Hand-rolling this layer (Pi's approach) was designed and rejected
during brainstorm — the operator's call: "if AI-SDK gives us everything for free
anyway there is no point rebuilding it." OpenCode ships on the same foundation.

## Decision

| Concern | Choice | Why |
|---|---|---|
| LLM client | **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible`) | Streaming, provider adapters, Zod-schema tools, usage (incl. cache token classes), abort/retry — all maintained upstream; the differentiators live above the wire |
| Loop control | **One `streamText` call per step; SDK multi-step (`stopWhen`/`maxSteps`) banned** (AGT-1) | Per-step routing, budget pauses, and permission asks require the loop to be Kelson's |
| Tool execution | **Kelson's registry + permission engine, never SDK auto-execute** | PERM-* rules and `ToolContext` sandbox composition are the product |
| Auth | **Hand-built** (`auth.ts`: key store, later OAuth) | Not an SDK concern; subscription OAuth is deliberately isolated (design doc decision 5) |
| Pricing/cost | **Hand-built registry** (micro-USD ints, PROV-3) | SDK reports usage, not cost; Kelson's economics require exact integer math |
| API shapes | **Read from installed `.d.ts`/docs at edit time, never memory** | The SDK has renamed stream parts across majors (registry-before-versions rule, CLAUDE.md) |

## Consequences

- `packages/agent` is the only package importing AI SDK modules; kernel and schemas
  stay dependency-clean, and kernel never imports agent — the `api` executor is
  injected via `runEval`'s `extraExecutors` parameter with composition in cli.
- Provider/loop tests are fixture-based (recorded stream parts), never live
  endpoints — gates and CI stay hermetic (CLAUDE.md LLM-layer test rules).
- SDK major upgrades are a named risk: the stream-part vocabulary is pinned by
  fixtures, so a breaking rename fails tests at upgrade time, not in production.
- If the SDK's abstraction ever blocks a provider capability we need (e.g. raw
  Anthropic beta headers for OAuth), the escape hatch is the SDK's custom-fetch
  hook, not a fork of the client layer.
