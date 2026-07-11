---
name: feature-pipeline
description: Run a feature through Obligato's SDLC stage discipline inside Claude Code — the manual emulation of /obligato:feature (UX J1). Use when starting any new feature or behavior change in this repo, when the user says "feature pipeline", "run the pipeline", or "/feature", or when work is about to jump straight to code without a spec stage. Explicit stages, ambient enforcement: announce each stage transition in one line.
---

# Feature Pipeline (manual emulation of UX J1)

Obligato's pipeline is ideation → planning → spec → build → verify, with the user always knowing which stage they're in. Run the same discipline manually; each stage has an exit condition — don't advance past a failed one.

## Stages

1. **Ideation** — interview one question at a time (PIPE-2 discipline): surface the unknowns, resolve them before any solutioning. *Exit: no open unknowns.*
2. **Planning** — write the requirement as EARS clauses **with obligations** directly in the governing spec doc (spec-sync skill owns the mechanics). Architecturally significant choices get an ADR draft (PIPE-4). Plans reference new clauses by *feature name*; clause numbers are assigned at landing time (next free number then), never pre-allocated in a plan — landing order and plan order diverge (postmortem 2026-07-05: a plan's "AGT-13 compaction" collided with robust-edit landing first). *Exit: spec-lint hook passes; clauses reviewed by the user.*
3. **Spec hardening** — for clauses that gate non-trivial implementation, run the **divergence** skill on the riskiest 1–2 clauses; fold clarifying clauses back in. The skill may be **soundly skipped** for a clause when *both* hold: every fresh predicate the clause introduces already carries exact operators/boundaries in its text (comparison, split point, tie-break), *and* the load-bearing semantics wholesale reuse an already-divergence-ruled mechanism (e.g. PERM-5 matching reused the PERM-1 evaluate ruling). When you skip, state the rationale in the clause commit and give the clause-auditor a pointed "judge whether this skip was sound" question — the audit is the backstop, and it has both endorsed a skip and surfaced the one genuine two-reading edge it left (PERM-5, 2026-07-11: the empty-arg-glob case). Skipping saves two agent runs; skipping *silently* forfeits the backstop. *Exit: no material divergence on probed clauses, or a recorded sound-skip the auditor is asked to check.*
4. **Build** — implement per the clauses. Route mechanical sub-work (renames, formatting, path updates, changelog lines) to the **mechanical** agent — that's the RTR routing emulation; don't burn frontier tokens on it. Obligation tests land with the code (obligation-test skill). *Exit: code + `<CLAUSE-ID>.test.ts` exist for every touched clause.*
5. **Verify** — run tests; run the **clause-auditor** agent on the diff; fix violations. *Exit: `AUDIT: PASS`.*
6. **Close** — commit spec+code+tests together referencing clause IDs; if the session had friction, offer the **postmortem** skill.

State transitions out loud, one line each: `stage: planning → spec (2 clauses added: RTR-6, RTR-7)`. If the user redirects mid-pipeline, say which stage you're re-entering — never silently skip back.

## Task tracking

At pipeline start, add the feature's stages/tasks to `.obligato/tasks.json` (the CLAUDE.md JSON-task convention); set each `in_progress` on entry and `completed` with a timestamp on exit. The JSON file is the tracker of record — no markdown checklists.
