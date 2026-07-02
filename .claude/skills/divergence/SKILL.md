---
name: divergence
description: Run Kelson-style divergence testing (SPEC-4) on a spec clause or requirement — two isolated agents interpret the same text blind, and differences in their concrete readings expose ambiguity. Use when asked to "divergence test" a clause, check whether a requirement is ambiguous, stress-test a spec before implementation, or whenever a clause is about to gate implementation work and hasn't been divergence-tested. Also use on any /divergence invocation.
---

# Divergence Testing (manual emulation of SPEC-4)

Two competent readers who produce different behavior from the same clause have found a spec bug, not a reading error. This skill runs that experiment with subagents, emulating Kelson's divergence tester until Phase 5 automates it.

## Procedure

1. **Extract the clause verbatim** — just the requirement text (plus its domain/context definitions if the spec declares any). Deliberately exclude surrounding prose, rationale, sibling clauses, and this conversation's context: divergence testing measures what the *text alone* pins down.
2. **Spawn two `general-purpose` agents in parallel, in one message**, each with an identical prompt:
   > You are implementing exactly this requirement, with no other context: <clause text + domain definitions>. First invent 4–6 concrete probe inputs, biased toward boundaries (empty, zero, max, ties, simultaneous events). Then for EACH probe input state precisely what your implementation observably does: return value, resulting state, emitted events/errors. Answer as a table. Do not hedge with alternatives — commit to one behavior as you would in code.
3. **Compare the tables** on the union of probe inputs (ask a follow-up via SendMessage if an agent skipped an input the other probed). **Material divergence** = any difference in return value, state, or events on the same input, excluding fields the spec declares nondeterministic (PRD §7.3 definition).
4. **Report** per divergence: the probe input, reading A, reading B, and a drafted clarifying clause (EARS form + obligation) that would force one reading. The clarifying clause must quote the readers' committed predicates **verbatim** — comparison operators and boundary values especially; summarizing them mispinned §3.1 against both readers (postmortem: F-065). No divergence across all probes → report "no divergence found on N probes" with the probe list (absence of evidence is only as strong as the probe set — say so).
5. If the clause lives in this repo's specs, offer to apply the clarifying clauses via the spec-sync skill.

## Cost note

Two agents per clause is deliberate (that's the mechanism). Don't run this on whole documents — pick the clauses that gate the next implementation step, or the ones a reviewer flagged.
