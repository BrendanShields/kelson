# Kelson — Self-Improving Engineering Harness

Open-source harness covering feedback → ideation → planning → spec → build → verify. Pre-code phase: the spec suite is the codebase right now.

## Source of Truth

| Document | Owns |
|---|---|
| `docs/specs/2026-07-02-agent-harness-prd.md` | Requirements (EARS clauses `TEL-*`, `EVAL-*`, `RTR-*`, `ART-*`, `SPEC-*`, `PIPE-*`, `LOOP-*`, `EVT-*`, `CTX-*`, `SEC-*`, `OSS-*`, `KERN-*`), metrics, phases |
| `docs/specs/2026-07-02-agent-harness-erd.md` | Data model, storage tiers, package layout |
| `docs/specs/2026-07-02-agent-harness-ux.md` | Command surface, journeys, TUI rules (`UX-*`) |
| `docs/specs/2026-07-02-kelspec-dsl.md` | The spec DSL grammar (`DSL-*`) |
| `docs/specs/2026-07-02-pack-format.md` | Pack/lockfile/registry formats (`PACK-*`) |
| `docs/specs/2026-07-02-eval-procedure.md` | Benchmark format, replay validity, gate math (`EVP-*`) |
| `docs/specs/2026-07-02-routing-policy.md` | Policy/registry formats, feature vector, bandit (`RPOL-*`) |
| `docs/specs/2026-07-02-signal-contract.md` | External signal schema (`SIG-*`) |
| `docs/adr/` | Decisions (0001 language/storage, 0002 no graph DB/RAG, 0003 Bun/OpenTUI/tooling) |

**Spec-first rule:** behavior changes start in the spec doc, never in code. Every behavioral requirement carries an `*Obligation:*` line (its executable test). A clause without an obligation is vague by definition and will be rejected by the spec-lint hook.

**Clause IDs are stable:** never renumber or reuse an ID. New requirements take the next free number in their family. Code, tests, and commits reference clause IDs.

## Conventions (from ADR-0001 / ERD §2, §9)

- TypeScript strict, ESM, Bun ≥ 1.3 (ADR-0003); Bun workspaces: `packages/schemas` (Zod, no internal deps) ← `kernel` ← `cli`, `cc-plugin`.
- Zod schemas in `packages/schemas` are the single source of truth for types; validate at every storage/IO boundary.
- SQLite via `bun:sqlite`, hand-written SQL, forward-only numbered migrations. No ORM.
- ULIDs for events; SHA-256 content hashes for artifacts; money as integer micro-USD; UTC ISO-8601 strings; append-only event tables (no UPDATE).
- Tests: `bun test` + fast-check. TUI: OpenTUI. Lint/format: Biome. Obligation tests live at `packages/<pkg>/test/obligations/<CLAUSE-ID>.test.ts` — see the obligation-test skill.
- Comments: only constraints the code can't express. No narration, no doc-comments on internals.

## Workflow

1. New feature or behavior change? Run the **feature-pipeline** skill (Kelson's SDLC stages, emulated: ideation → EARS clauses → divergence-test risky clauses → build → verify).
2. Changing behavior? Use the **spec-sync** skill (locate clause → edit spec + obligation → then code).
3. Writing tests for a clause? Use the **obligation-test** skill.
4. Mechanical work (renames, formatting, reference updates, changelog lines) → delegate to the **mechanical** agent (Haiku) — the routing emulation; don't do it at frontier cost.
5. Ambiguity suspected in a clause? Run the **divergence** skill (two blind agents, compare readings — SPEC-4 emulated).
6. Before committing a diff that touches behavior, run the **clause-auditor** agent on it.
7. Commit spec and code changes together, referencing clause IDs (`feat(kernel): implement TEL-1 step event emission`).
8. End of a substantial session → **postmortem** skill (LOOP-1 emulated, propose-only; human is the gate).

## Dogfood telemetry

Hooks append session/tool events to `.kelson/telemetry/events.jsonl` (gitignored, local-first per TEL-2). This is proto-TEL-1: its event shape informs the Phase 0 schema. Known gap discovered by dogfooding: Claude Code hooks expose no token counts — real TEL-1 needs transcript parsing, exactly as the PRD assumes.
