# ADR-0001: TypeScript Implementation, Files + SQLite Storage with OTel Projection

- **Status:** Accepted
- **Date:** 2026-07-02
- **Traceability:** upstream [PRD §5.4, §6](../specs/2026-07-02-agent-harness-prd.md); shapes [ERD §1, §9](../specs/2026-07-02-agent-harness-erd.md)

## Context

Keel v1 is a hybrid: a Claude Code-native plugin plus external components (eval runner, telemetry store, replay engine). We need one implementation language and a storage substrate that is local-first, PR-reviewable where humans are in the loop, and statistically queryable where the eval gate does math.

## Decision

**TypeScript** (Node ≥ 22, ESM, strict) across all packages.

**Storage:** git-tracked files for anything human-reviewed or PR-carried (specs, packs, lockfile, changelog, eval ledger); local SQLite (better-sqlite3, WAL, forward-only numbered migrations, no ORM) for measured/high-volume data; an optional **OpenTelemetry projection** (OTLP traces/spans/metrics, off by default, content-stripped) so operators can use existing observability stacks. The SQLite artifact index is derived and rebuildable from files.

**Schemas:** Zod as the single source of truth in `packages/schemas`; TS types inferred; JSON Schema generated for the external signal contract.

## Options Considered

- **Language:** TypeScript vs. Rust vs. Go vs. Python. TypeScript wins on ecosystem adjacency (Claude Code plugins, Agent SDK, MCP tooling are TS-first), contributor pool for an OSS product, and Zod's schema-to-type-to-JSON-Schema pipeline. Rust/Go offer performance we don't need (the bottleneck is model latency, not harness CPU); Python fragments the plugin/CLI toolchain.
- **Storage:** all-files (JSONL) — greppable but makes paired statistics and trend queries painful; all-SQLite — one store but breaks PR-reviewability of packs/specs and "survives Keel's removal"; **hybrid** — each datum where its access pattern points. Chosen.
- **ORM:** Drizzle/Prisma vs. plain SQL. Plain SQL + Zod boundary validation: fewer dependencies, and the schema lives in migrations we fully control.

## Consequences

- The Claude Code coupling is confined to `packages/cc-plugin`, keeping the PRD §5.4 migration path (standalone Agent SDK harness) a package swap, not a rewrite.
- Statistical gating code (paired bootstrap) is implemented in TS rather than reaching for Python's scientific stack; acceptable because the tests are simple resampling, and it keeps the install one runtime.
- Operators get observability for free via OTel instead of Keel growing its own dashboards.
