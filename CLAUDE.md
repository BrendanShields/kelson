# Keel — Self-Improving Engineering Harness

Open-source harness covering feedback → ideation → planning → spec → build → verify. Pre-code phase: the spec suite is the codebase right now.

## Source of Truth

| Document | Owns |
|---|---|
| `docs/specs/2026-07-02-agent-harness-prd.md` | Requirements (EARS clauses `TEL-*`, `EVAL-*`, `RTR-*`, `ART-*`, `SPEC-*`, `PIPE-*`, `LOOP-*`, `EVT-*`, `CTX-*`, `SEC-*`, `OSS-*`, `KERN-*`), metrics, phases |
| `docs/specs/2026-07-02-agent-harness-erd.md` | Data model, storage tiers, package layout |
| `docs/specs/2026-07-02-agent-harness-ux.md` | Command surface, journeys, TUI rules (`UX-*`) |
| `docs/adr/` | Decisions (ADR-0001 stack, ADR-0002 no graph DB/RAG) |

**Spec-first rule:** behavior changes start in the spec doc, never in code. Every behavioral requirement carries an `*Obligation:*` line (its executable test). A clause without an obligation is vague by definition and will be rejected by the spec-lint hook.

**Clause IDs are stable:** never renumber or reuse an ID. New requirements take the next free number in their family. Code, tests, and commits reference clause IDs.

## Conventions (from ADR-0001 / ERD §2, §9)

- TypeScript strict, ESM, Node ≥ 22; pnpm workspaces: `packages/schemas` (Zod, no internal deps) ← `kernel` ← `cli`, `cc-plugin`.
- Zod schemas in `packages/schemas` are the single source of truth for types; validate at every storage/IO boundary.
- SQLite via better-sqlite3, hand-written SQL, forward-only numbered migrations. No ORM.
- ULIDs for events; SHA-256 content hashes for artifacts; money as integer micro-USD; UTC ISO-8601 strings; append-only event tables (no UPDATE).
- Tests: vitest + fast-check. Obligation tests live at `packages/<pkg>/test/obligations/<CLAUSE-ID>.test.ts` — see the obligation-test skill.
- Comments: only constraints the code can't express. No narration, no doc-comments on internals.

## Workflow

1. Changing behavior? Use the **spec-sync** skill (locate clause → edit spec + obligation → then code).
2. Writing tests for a clause? Use the **obligation-test** skill.
3. Before committing a diff that touches behavior, run the **clause-auditor** agent on it.
4. Commit spec and code changes together, referencing clause IDs (`feat(kernel): implement TEL-1 step event emission`).
