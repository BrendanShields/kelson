# Implementation Plan: Phase 0 — Rails

> **Status: COMPLETE (2026-07-02).** All 7 tasks done (`.kelson/tasks.json`), 39 findings logged (`.kelson/findings.json`), zero defects reached main. Exit criterion verified against a real session transcript: 327 steps (unique message ids), all four token classes matching an independent dedup-by-id count; a PRD edit flagged 7 downstream specs stale; `/kelson:status` renders. The cc-plugin hooks are wired in `.claude/settings.json` and the repo's artifact store is seeded — sessions now dogfood into `.kelson/kelson.db` (gitignored). **Next: plan Phase 1 (kelspec DSL parser, spec pipeline — PRD §16) via the feature-pipeline skill.**
>
> **Deferral ledger (everything intentionally left open):**
>
> | What | Where recorded | Discharges |
> |---|---|---|
> | OSS-6 pt 2: cross-version eval comparison refusal | it.todo in OSS-6.test.ts | Phase 2 |
> | PACK-2 pt 2: Ed25519 signature verify + `--unsigned` telemetry flag | it.todo in PACK-2.test.ts | Phase 5 (registry keys) |
> | merge_clean acceptance (correction window) | thrown error in telemetry.ts + F-020 | post-Phase-0 (unblocked) |
> | rebuild-from-files; register.ts hardcodes the 8 spec paths | Task 4 note below + F-015 | Phase 1 / DSL-6 |
> | Telemetry stubs: sdlc_step='build', effort='medium', cost=0, task-per-session | F-034 | Phase 3 (stage/budget/prices) |
> | KERN-1 hook fault-injection matrix | F-033 | Phase 0.5 |

- **Upstream:** PRD §16 Phase 0; ERD; UX J0. **Exit criterion:** a Claude Code session produces telemetry (structured events in SQLite) and traceable artifacts (hash-linked, staleness-flagged).
- **Clauses in scope:** TEL-1, TEL-2, TEL-5, TEL-7 (lifecycle skeleton), ART-1, ART-2, OSS-6, SEC-4 (schema shape only), KERN-1 (telemetry path only).
- **Discipline:** every task lands with its obligation test (`packages/<pkg>/test/obligations/<ID>.test.ts`); spec + code + test in one commit per the spec-sync skill.

## Task 1 — Workspace scaffold

Bun workspace (root `package.json` workspaces field), base `tsconfig.json` (strict, ESM, `module: NodeNext`, Bun ≥ 1.3 per ADR-0003), `packages/{schemas,kernel,cli,cc-plugin}` stubs, `bun test` + fast-check at the root, `typecheck` script (activates the existing `.claude/hooks/typecheck.mjs` hook), GitHub Actions CI (`oven-sh/setup-bun`): `bun run typecheck && bun test` plus spec-lint over `docs/`.
**Verify:** `bun run typecheck && bun test` green on empty packages; editing a `.ts` file in-session triggers the typecheck hook.

## Task 2 — `packages/schemas`

Zod schemas per ERD for Phase 0 entities: `Session`, `Task` (lifecycle enum per §3 of the PRD), `StepEvent`, `InterventionEvent`, `Artifact`, `TraceLink`, `DriftEvent`, `PackManifest` (with `capabilities` field — SEC-4 shape), `Lockfile`/`LockfileEntry`. Shared scalars: ULID, ISO-8601 UTC, SHA-256 hex, micro-USD int, `schema_version`. JSON Schema export script (feeds the §8.7 contract later).
**Verify:** obligation-style PBT — every schema round-trips `parse(serialize(x))` for generated values; no package deps besides zod.

## Task 3 — `packages/kernel` storage

`bun:sqlite` bootstrap at `~/.kelson/kelson.db` (WAL), forward-only numbered SQL migrations + runner, migration `0001` creating Phase 0 tables (append-only event tables get no UPDATE path in the data layer).
**Obligation tests:** OSS-6 — v1-created store readable after adding migration `0002` in a fixture; rows carry `schema_version`.

## Task 4 — Artifact store (ART-1, ART-2)

`artifacts` module in kernel: SHA-256 content hashing of files under `docs/` conventions, `TRACE_LINK` recording with `upstream_hash_at_link`, transitive staleness flagging via recursive CTE (ADR-0002), `rebuildIndex()` from files (ERD §1 — SQLite disposable). *Scope note (P0-4 audit):* full rebuild-from-files needs the Phase 1 kelspec manifest (DSL-6) to recover upstream declarations; Phase 0 ships `rehashFromDisk` (hash refresh of indexed artifacts) and the full rebuild is discharged with DSL-6.
**Obligation tests:** ART-1 and ART-2 PBTs over generated artifact DAGs (exactly the transitive downstream set flags on edit); index rebuild idempotence.

## Task 5 — Telemetry capture (TEL-1, TEL-2, TEL-5, TEL-7 skeleton)

Transcript/hook-event ingestion → `SESSION`, `STEP_EVENT`, `INTERVENTION_EVENT` rows; session pins `lockfile_hash` at start (LOOP-7 groundwork); local-only storage with no network path (TEL-2 — there is no transmit code in Phase 0 at all, the strongest form of the obligation); collector failure marks session `incomplete` and never aborts (TEL-5, KERN-1 telemetry path); task lifecycle state machine with legal-transition enforcement (TEL-7 — acceptance signals stubbed to explicit `/kelson:accept` only).
**Obligation tests:** TEL-1 PBT (synthetic transcripts), TEL-2 (no outbound calls — assert no network module imports via lint + runtime recorder in integration test), TEL-5 fault injection, TEL-7 transition PBT.

## Task 6 — Pack format + lockfile

Pack directory layout + manifest loader (validate against `PackManifest`, refuse undeclared-surface content per SEC-4's shape — enforcement depth grows in Phase 5), lockfile read/write/hash with `parent_hash` chaining.
**Verify:** fixture pack loads; tampered manifest refused; lockfile hash stable across key order.

## Task 7 — `packages/cc-plugin` shell

SessionStart/SessionEnd/PostToolUse hooks feeding Task 5's ingestion; `/kelson:status` (UX §3) reading pinned lockfile + session state; statusline segment stub (`stage · model · budget` with stage/budget hardcoded until Phase 3).
**Verify (exit criterion):** run a real session in this repo → `kelson.db` contains the session with step events summing to transcript tokens; edit a spec file → downstream `TRACE_LINK` staleness flags appear; `/kelson:status` renders.

## Sequencing

1 → 2 → 3 → {4, 5 in parallel} → 6 → 7. Tasks 4–6 are pure kernel work testable without Claude Code; Task 7 integrates.

## Out of scope for Phase 0

Eval harness, router, context compiler, OTel export, spec compiler, sandboxing, the loop — Phases 1–5 per PRD §16. Resist pulling them forward; the exit criterion is rails, not features.
