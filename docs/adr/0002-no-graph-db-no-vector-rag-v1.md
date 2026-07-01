# ADR-0002: No Graph Database, No Vector RAG in V1

- **Status:** Accepted
- **Date:** 2026-07-02
- **Traceability:** upstream [ERD §1, §3](../specs/2026-07-02-agent-harness-erd.md), [PRD §6.4, §12.1](../specs/2026-07-02-agent-harness-prd.md)

## Context

Keel has two workloads that superficially suggest specialized stores: the traceability DAG (feedback → idea → PRD → spec clause → code → test; queried for transitive staleness, ART-2) suggests a graph database, and the context compiler's retrieval problem ("which spec clauses, interfaces, and invariants does this task need?", CTX-1) suggests embeddings-based RAG.

## Decision

**Neither in v1.**

- **Trace graph:** the DAG lives in SQLite (`TRACE_LINK` table); transitive downstream queries are recursive CTEs. The graph is small (thousands of nodes per repo, not millions), append-mostly, and its hot query — "flag everything downstream of this hash" — is a single recursive traversal SQLite executes in microseconds. A graph DB adds an operational dependency to an install that must be `npx keel init` simple (OSS-1) and buys nothing at this scale.
- **Context retrieval:** the context compiler uses **structural retrieval** — trace links (the task's spec clauses point at their code regions), the symbol graph (imports/references of touched files), and declared invariants in force. Structural retrieval is deterministic, explainable (`keel route explain` can show *why* something entered the bundle), and testable against the bundle-miss metric (CTX-2). Embeddings retrieval is none of those, and its failure mode — plausible-but-wrong context — is exactly the ambiguity Keel exists to eliminate.

## Escape Hatches (measured, not speculative)

- If recursive CTEs become a bottleneck (they won't at repo scale), the fix is an in-memory adjacency cache, not a database swap.
- Semantic retrieval may enter later **as an eval-gated pack**: a retrieval pack that supplements structural bundles, gated on the evidence CTX-2 already defines — bundle-miss rate down without FPAR down, TPAC not up. If embeddings ever ship, it will be because they beat structural retrieval in the ledger, not because RAG is fashionable.

## Consequences

- Zero new infrastructure; the ERD stands unchanged.
- Bundle-miss telemetry must be good from Phase 3, since it is the tripwire that would justify a retrieval pack.
- Spec excavation (SPEC-7) also relies on structural analysis in v1; if inferred-clause quality plateaus, semantic similarity is a candidate improvement — same gate applies.
