---
name: spec-sync
description: Keep Kelson's spec suite (PRD/ERD/UX EARS clauses) and code in sync. Use whenever changing any behavior of the harness, adding or editing a requirement in docs/specs/, implementing a clause (TEL-*, EVAL-*, RTR-*, ART-*, SPEC-*, PIPE-*, LOOP-*, EVT-*, CTX-*, SEC-*, OSS-*, KERN-*, UX-*, DSL-*, PACK-*, EVP-*, RPOL-*, SIG-*), renaming or renumbering anything in the spec docs, or when a code change doesn't obviously map to an existing clause. If you're about to edit kernel/pipeline behavior and haven't opened the spec, that's the trigger — use this skill first.
---

# Spec Sync

Kelson's own PRD rule applies to Kelson's development: a behavioral claim without an executable obligation is vague by definition. This skill is the discipline that keeps the spec suite authoritative while code grows underneath it.

## Why this matters

The spec docs are not documentation *about* the system — they are the system's contract, and Phase 1 turns them into the harness's own conformance suite (PRD §17). Every drift between spec and code that lands now becomes a false conformance result later. Sync is cheaper at edit time than at excavation time.

## The workflow

1. **Locate the governing clause.** Grep the clause family across `docs/specs/` (e.g. `grep -rn "TEL-" docs/specs/`). Three outcomes:
   - Clause exists and covers the change → note its ID, go to step 3.
   - Clause exists but the change alters its meaning → step 2.
   - No clause governs the behavior → step 2 (new clause).
2. **Edit the spec first.** Write or amend the EARS clause *and its `*Obligation:*` line together* — never one without the other. Rules:
   - EARS forms: ubiquitous ("shall"), event ("When X, ... shall"), state ("While X, ... shall"), unwanted ("If X, then ... shall"), optional ("Where X, ... shall").
   - New clauses take the next free number in their family. IDs are permanent: never renumber, never reuse a retired ID (mark retired clauses `~~struck through~~` with a one-line reason instead of deleting).
   - The obligation must name a concrete check (PBT property, integration/fault-injection test, schema validation, golden set with a threshold) — "will be tested" is not an obligation.
   - If the change ripples (e.g. a new metric → §3 table, secondary-metrics list, and any clause referencing it), fix every reference in the same edit. Grep the old text to find them.
3. **Then change the code.** Implementation follows the clause; the obligation test follows the obligation-test skill's conventions.
4. **Verify sync before committing:**
   - The spec-lint hook runs automatically on spec edits (unique IDs, every requirement has an obligation) — heed its failures, don't work around them.
   - Commit spec + code + obligation test together, message referencing the clause ID.

## Judgment calls

- **Small enough to skip?** No. A change that seems too small for a clause either (a) is non-behavioral (rename, formatting) — genuinely exempt, or (b) reveals the governing clause is too coarse — split it.
- **Spec says X, code needs Y:** stop and resolve in the spec first (this is PIPE-9's own rule applied to us — never patch code to match a wrong spec silently).
- **Cross-document consistency:** PRD owns requirements, ERD owns data shapes, UX owns interaction. A change touching two docs updates both; the ERD field-comment convention (each field cites its PRD clause) is the trace link — keep it.
