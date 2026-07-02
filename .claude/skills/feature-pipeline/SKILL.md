---
name: feature-pipeline
description: Run a feature through Kelson's SDLC stage discipline inside Claude Code — the manual emulation of /kelson:feature (UX J1). Use when starting any new feature or behavior change in this repo, when the user says "feature pipeline", "run the pipeline", or "/feature", or when work is about to jump straight to code without a spec stage. Explicit stages, ambient enforcement: announce each stage transition in one line.
---

# Feature Pipeline (manual emulation of UX J1)

Kelson's pipeline is ideation → planning → spec → build → verify, with the user always knowing which stage they're in. Run the same discipline manually; each stage has an exit condition — don't advance past a failed one.

## Stages

1. **Ideation** — interview one question at a time (PIPE-2 discipline): surface the unknowns, resolve them before any solutioning. *Exit: no open unknowns.*
2. **Planning** — write the requirement as EARS clauses **with obligations** directly in the governing spec doc (spec-sync skill owns the mechanics). Architecturally significant choices get an ADR draft (PIPE-4). *Exit: spec-lint hook passes; clauses reviewed by the user.*
3. **Spec hardening** — for clauses that gate non-trivial implementation, run the **divergence** skill on the riskiest 1–2 clauses; fold clarifying clauses back in. *Exit: no material divergence on probed clauses.*
4. **Build** — implement per the clauses. Route mechanical sub-work (renames, formatting, path updates, changelog lines) to the **mechanical** agent — that's the RTR routing emulation; don't burn frontier tokens on it. Obligation tests land with the code (obligation-test skill). *Exit: code + `<CLAUSE-ID>.test.ts` exist for every touched clause.*
5. **Verify** — run tests; run the **clause-auditor** agent on the diff; fix violations. *Exit: `AUDIT: PASS`.*
6. **Close** — commit spec+code+tests together referencing clause IDs; if the session had friction, offer the **postmortem** skill.

State transitions out loud, one line each: `stage: planning → spec (2 clauses added: RTR-6, RTR-7)`. If the user redirects mid-pipeline, say which stage you're re-entering — never silently skip back.
