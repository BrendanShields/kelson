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
- Zod schemas in `packages/schemas` are the single source of truth for types; validate at every storage/IO boundary. Every exported Zod schema is paired with `export type X = z.infer<typeof X>` in the same file — a value export without its type export is incomplete (postmortem: caused a TS2749 typecheck retry). Every schema *field* change updates the paired arbitrary in `packages/schemas/test/roundtrip.test.ts` in the same edit — otherwise the round-trip gate fails at gates time, not edit time (postmortem: TraceLink.downstream_hash_at_link).
- SQLite via `bun:sqlite`, hand-written SQL, forward-only numbered migrations. No ORM.
- ULIDs for events; SHA-256 content hashes for artifacts; money as integer micro-USD; UTC ISO-8601 strings; append-only event tables (no UPDATE). Event-stream queries order by `rowid`, never by ULID or timestamp — both tie within one millisecond (F-060, F-067).
- Tests: `bun test` + fast-check. TUI: OpenTUI. Lint/format: Biome. Obligation tests live at `packages/<pkg>/test/obligations/<CLAUSE-ID>.test.ts` — see the obligation-test skill.
- Comments: only constraints the code can't express. No narration, no doc-comments on internals.
- **Task lists are JSON, always.** Multi-step work is tracked in `.kelson/tasks.json` (committed): `{id, title, state: open|in_progress|completed, clauses[], completed_at}` — mirror of the TEL-7 lifecycle, simplified until Phase 0 builds the real store. Mark tasks `in_progress` when started and `completed` (with timestamp) the moment they finish — never leave state stale, never use markdown checklists for tracking. Edit the board and the findings log with `bun scripts/board.mjs` (validates shape, stamps timestamps, auto-numbers finding IDs) — not hand-written JSON edits; `board.mjs task <id> <state> --title "..."` creates a task that doesn't exist yet.

**Registry-before-versions rule:** never write a dependency version or tool config from memory — get versions from the registry (`npm view <pkg> version` / `bun pm view`) and scaffold configs with the tool's own init command, then edit. (Postmortem lesson: guessed versions and stale config syntax both failed this way.)

**Gates:** `bun run gates` runs every gate (doctor → spec-lint → kelspec-lint → typecheck → biome → test). CI runs exactly this script. Session hooks (spec-lint/kelspec-lint/typecheck on edits, cc-plugin telemetry) fire automatically — but still run `bun run gates` before every commit; hooks check single files, gates check everything. `scripts/doctor.mjs` fails on bun/CI-pin skew and writes the environment manifest to `.kelson/env.json` (proto EVP §4).

**Gotchas (each cost real time once):** run `bunx biome check --write .` before gates — Biome rewraps after every Write, and string replacements miss after a rewrap (re-Read before editing). Bash `cd` persists across calls — stay at repo root. `bun test` exits 1 on an empty suite on Linux only (F-003). `it.todo` needs a function argument to typecheck. After `git push`, fetch the CI run id in a *separate* command before `gh run watch` — querying in the same breath grabs the previous run. Before any paid or quota-burning batch run, smoke-test ONE unit end-to-end through the identical code path (a $0.25 session caught 3 wiring bugs before a 12-session run). Never interpolate content into `sh -c` strings — pass it via env var (backticks in a task statement broke the shell). Container-backed bun tests need explicit timeouts (the 5s default dies on image pull). Scripted string replacements (python `.replace()`, sed) silently no-op on mismatch — every scripted edit must verify its own effect (assert-the-change in the script, or grep immediately after); a no-op produced a false 'fixed' findings row (F-063).

## Workflow

1. New feature or behavior change? Run the **feature-pipeline** skill (Kelson's SDLC stages, emulated: ideation → EARS clauses → divergence-test risky clauses → build → verify).
2. Changing behavior? Use the **spec-sync** skill (locate clause → edit spec + obligation → then code).
3. Writing tests for a clause? Use the **obligation-test** skill.
4. Mechanical work (renames, formatting, reference updates, changelog lines) → delegate to the **mechanical** agent (Haiku) — the routing emulation; don't do it at frontier cost.
5. Ambiguity suspected in a clause? Run the **divergence** skill (two blind agents, compare readings — SPEC-4 emulated).
6. Before committing a diff that touches behavior, run the **clause-auditor** agent on the *staged* diff, giving it the task context and pointed questions about the riskiest choices — it has found real violations in most audited diffs, including two that would have shipped corrupted telemetry. Every violation/warning it raises — and every spec bug implementation surfaces — gets a row in `.kelson/findings.json` (id, task, source, severity, clauses, summary, root_cause from the file's taxonomy, fix, status) appended in the same commit as the fix. This log is proto-LOOP-1 evidence: the postmortem skill and future benchmark tasks (LOOP-6) mine it.
7. **Verification-independence rule:** an exit criterion or manual verification must compute its expected values by a route independent of the implementation under test — different derivation, different boundary definition, or auditor-computed. A check that shares logic with the code it validates is not evidence (postmortem: a self-referential transcript check hid a 3x token over-count, F-031).
8. Commit spec and code changes together, referencing clause IDs (`feat(kernel): implement TEL-1 step event emission`). Confirm CI with `gh run watch $(gh run list -L1 --json databaseId -q '.[0].databaseId') --exit-status` — never a guessed `sleep`.
9. End of a substantial session → **postmortem** skill (LOOP-1 emulated, propose-only; human is the gate).

## Dogfood telemetry

Hooks append session/tool events to `.kelson/telemetry/events.jsonl` (gitignored, local-first per TEL-2). This is proto-TEL-1: its event shape informs the Phase 0 schema. Known gap discovered by dogfooding: Claude Code hooks expose no token counts — real TEL-1 needs transcript parsing, exactly as the PRD assumes.
