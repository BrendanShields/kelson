# Handover — Kelson, Phase 0 COMPLETE (2026-07-02)

Session-continuation notes. Read alongside `CLAUDE.md` (conventions, workflow, source-of-truth table) and `.kelson/tasks.json` (live board). Repo: https://github.com/BrendanShields/kelson (`main`, CI green).

## Where we are

Spec suite complete (8 specs + 3 ADRs, ambiguity-swept). **Phase 0 (docs/plans/2026-07-02-phase-0-rails.md) is done — all 7 tasks completed, exit criterion verified.**

- P0-1 scaffold · P0-2 `@kelson/schemas` · P0-3 storage/migrations · P0-4 artifact store · P0-5 telemetry · P0-6 pack loader + lockfile (PACK-1/2/4, SEC-4; F-007 discharged) · P0-7 cc-plugin shell (TEL-1/2/5, ART-2, KERN-1).
- Exit criterion verified against this session's **real transcript**: 327 steps (unique message ids), all four token classes exactly matching an independent dedup-by-id count; a PRD edit flagged 7 downstream specs stale via trace links; `/kelson:status` and the statusline stub render. 64 tests + 2 todos, all gates green.
- The cc-plugin hooks are wired in `.claude/settings.json` (SessionStart/SessionEnd/PostToolUse) and the repo's own artifact store is seeded — **the next session dogfoods for real** (db at `.kelson/kelson.db`, gitignored).
- **Next:** plan Phase 1 (kelspec DSL parser, spec-first pipeline — PRD §15 phases), or run the postmortem skill over this session first. Findings log at 39 rows; spec-quality root causes still dominate.

## The proven loop (repeat for each task)

1. Flip task `in_progress` via `bun scripts/board.mjs task <id> in_progress`.
2. Implement; spec bugs found by code get fixed **spec-first** (spec-sync skill) in the same commit.
3. `bunx biome check --write .` then `bun run gates` (all 6 must pass).
4. `git add -A`, then launch **clause-auditor** agent on the staged diff with task context + specific questions. It has found real violations every task (see `.kelson/findings.json` — 39 entries, root-cause taxonomy in the file).
5. Fix findings (spec-first for spec_gap/contradiction), add findings rows (`bun scripts/board.mjs finding '<json>'`), flip task `completed` (`bun scripts/board.mjs task <id> completed --note "..."`).
6. Commit (reference clause IDs + audit outcome), push, confirm CI with `gh run watch $(gh run list -L1 --json databaseId -q '.[0].databaseId') --exit-status`.

## Session-critical operational notes

- **Hooks were NOT active in the Phase 0 sessions** (added mid-session; Claude Code can't restart). If they are active now, spec-lint/typecheck fire on edits and the cc-plugin captures telemetry; otherwise run manually: `bun run gates` before every commit; `echo '{"tool_input":{"file_path":"<file>"}}' | node .claude/hooks/spec-lint.mjs` after spec-doc edits.
- **User preferences:** push after committing (often asks); task lists always JSON, marked off live (also in memory + CLAUDE.md); ponytail active (terse, minimal); wants corrections tracked → findings.json discipline is non-negotiable.
- **Gotchas that cost time:** Biome rewraps after every Write — run `biome check --write` before gates, and re-Read before editing. Bash `cd` persists across calls — stay at repo root. `bun test` empty-suite exit code differs macOS/Linux (F-003). `it.todo` needs a function arg to typecheck. PBT seeds differ on CI — a locally-green property can fail there (F-039); treat CI PBT failures as real findings, not flakes to rerun.
- **Verification lesson (F-031):** never validate a parser against a ground truth computed with the parser's own boundary definition — the P0-7 exit check was self-referential and hid a 3x token over-count until the auditor computed an independent count.
- **Model routing emulation:** delegate mechanical work (renames, formatting sweeps) to the `mechanical` agent (Haiku).

## Deferral ledger (nothing else is open)

| What | Where recorded | Discharges |
|---|---|---|
| OSS-6 pt 2: cross-version eval comparison refusal | it.todo in OSS-6.test.ts | Phase 2 |
| PACK-2 pt 2: Ed25519 signature verify + `--unsigned` telemetry flag | it.todo in PACK-2.test.ts | Phase 5 (registry keys) |
| merge_clean acceptance (correction window) | thrown error in telemetry.ts + F-020 | post-Phase-0 (now unblocked) |
| rebuild-from-files (needs kelspec manifest); register.ts hardcodes the 8 spec paths | plan doc Task 4 note + F-015 | Phase 1 / DSL-6 |
| Phase 0 telemetry stubs: sdlc_step='build', effort='medium', cost=0, task-per-session | F-034 | Phase 3 (stage/budget/prices) |
| KERN-1 hook fault-injection matrix | F-033 | Phase 0.5 |

## Architecture facts you'll need (avoid re-deriving)

- Stack: Bun 1.3.14 (pinned in CI + engines; doctor enforces), `bun:sqlite`, Zod v4 in `packages/schemas` (single source of truth — kernel imports its types), fast-check, Biome, OpenTUI planned for CLI (ADR-0003).
- Storage: sessions born `incomplete` → `complete` on clean end; `degraded` = sticky fault marker; only `complete` sessions gate. Event tables append-only via triggers; drift_event is insert-then-resolve. artifact PK is (repo, logical_id); trace_link/drift_event are repo-scoped (F-013). Lockfile hash pinned on session start (LOOP-7 shape); `kelson.lock` (git-tracked, empty) exists at the repo root.
- TEL-1 boundary (PRD §6.1): a step in a Claude Code transcript is a **unique assistant `message.id`** (one line per content block; last usage wins). Zod v4 strips `__proto__` record keys before key validation — pinned by test, keys constrained to identifier tokens (F-039).
- Task lifecycle: open→in_progress→delivered→{accepted|corrected}; abandoned from any non-terminal; acceptance requires signal; Phase 0 signal = 'approval' only.
- Findings log `.kelson/findings.json`: every auditor violation/warning + surfaced spec bug gets a row in the fix's commit. Zero defects reached main across all 7 tasks; the auditor found real violations in 3 of 5 audited diffs.
