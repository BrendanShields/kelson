---
name: divergence
description: Run Kelson-style divergence testing (SPEC-4) on a spec clause or requirement — two isolated agents interpret the same text blind, and differences in their concrete readings expose ambiguity. Use when asked to "divergence test" a clause, check whether a requirement is ambiguous, stress-test a spec before implementation, or whenever a clause is about to gate implementation work and hasn't been divergence-tested. Also use on any /divergence invocation.
---

# Divergence Testing (manual emulation of SPEC-4)

Two competent readers who produce different behavior from the same clause have found a spec bug, not a reading error. This skill runs that experiment with subagents, emulating Kelson's divergence tester until Phase 5 automates it.

## Procedure

1. **Extract the clause verbatim** — just the requirement text (plus its domain/context definitions if the spec declares any). Deliberately exclude surrounding prose, rationale, sibling clauses, and this conversation's context: divergence testing measures what the *text alone* pins down.
2. **Spawn two `general-purpose` agents in parallel, in one message**, each with an identical prompt:
   > You are implementing exactly this requirement, with no other context: <clause text + domain definitions>. First invent 4–6 concrete probe inputs, biased toward boundaries (empty, zero, max, ties, simultaneous events). Then for EACH probe input state precisely what your implementation observably does: return value, resulting state, emitted events/errors. Answer as a table. Do not hedge with alternatives — commit to one behavior as you would in code. Also state up front the load-bearing decisions you had to make where the text was silent — the choices another competent implementer might make differently.

   The convergent case is now the common one: recent tests (F-117, F-120, F-122, AGT-11) found *no* material split, yet both readers independently committed to unstated load-bearing semantics. When that happens the deliverable is not "no bug" — it is the **implicit contract both competent readers assumed**, which you fold into the clause verbatim (step 4). Prompting readers to surface their assumptions (above) makes that contract explicit instead of having to reverse-engineer it from agreeing probe tables.
3. **Compare the tables** on the union of probe inputs (ask a follow-up via SendMessage if an agent skipped an input the other probed). **Material divergence** = any difference in return value, state, or events on the same input, excluding fields the spec declares nondeterministic (PRD §7.3 definition).
4. **Report** per divergence: the probe input, reading A, reading B, and a drafted clarifying clause (EARS form + obligation) that would force one reading. The clarifying clause must quote the readers' committed predicates **verbatim** — comparison operators and boundary values especially; summarizing them mispinned §3.1 against both readers (postmortem: F-065). No divergence across all probes → report "no divergence found on N probes" with the probe list (absence of evidence is only as strong as the probe set — say so). Before applying a clarifying clause, grep its predicates against sibling clauses that read or derive the same state — a ruling consistent with the probed clause can still contradict a neighbor (postmortem: F-113 — AGT-6's pause derivation broke AGT-2's resume and surfaced twice before the audit caught it).
5. A convergent result (no divergence across all probes) is **not** a green light to pin-and-ship: both readers can agree on a reading the target architecture can't implement (postmortem: F-120 — both blind readers pinned "switch model while busy" that the serialized-turn TUI has no latch for; the audit caught it as unimplemented + a mid-step orphan risk). Before pinning an agreed reading, sanity-check it against the surface that will implement it; if it can't, re-pin to what the surface supports rather than spec'ing machinery you won't build. Divergence validates that the *text* pins one reading — not that the pinned reading is *buildable here*.
6. If the clause lives in this repo's specs, offer to apply the clarifying clauses via the spec-sync skill.

## Cost note

Two agents per clause is deliberate (that's the mechanism). Don't run this on whole documents — pick the clauses that gate the next implementation step, or the ones a reviewer flagged.
