# Brownfield Adoption Guide

Adopting Kelson on an existing codebase (UC4/P2). Greenfield gets specs from day one; brownfield earns them incrementally.

## Day 0: install without changing behavior

```bash
bun packages/cli/src/index.ts init
```

`init` is non-destructive: existing `.claude/settings.json` hooks are preserved, an existing `kelson.lock` is left untouched. From the first session, telemetry accrues locally (TEL-2) — nothing else changes.

## Week 1: excavate inferred specs (SPEC-7)

Run excavation on the modules you touch most. Inferred clauses land with `authority: inferred`, each linked to the code evidence it was inferred from. **Inferred clauses never block builds** — they are drift *detectors*: violating one raises an alert; violating a human-`confirmed` clause blocks per ART-4. Expectations are set explicitly: nothing blocks anything until you promote it.

## Ongoing: promotion by survival (SPEC-8)

An inferred clause that survives 20 sessions without violation or human edit queues for one-click batched promotion (`promotionQueue`/`promoteInferred` in the kernel; the `kelson drift promote` CLI surface ships with the TUI). Promoted clauses become `confirmed` and start gating. Drift alerts arrive batched at session end — never mid-flow — grouped by module, with inferred violations visually distinct from confirmed ones.

## When to write your first authored kelspec

The first time a change matters enough to argue about: write the clause, give it a `check` predicate, and let the compiler hold the line. T1+ components additionally require a formal model file for their invariants (DSL-5). New specs at T1+ get divergence-tested by default (SPEC-4) — two independent implementations probe the spec for ambiguity before you build on it.
