---
name: postmortem
description: Mine the current session for friction and propose improvements to this repo's Claude Code config (CLAUDE.md, skills, agents, hooks) — the manual emulation of Kelson's self-improvement loop (LOOP-1), with the human as the eval gate. Use at the end of a substantial working session, when the user says "postmortem", "what should we improve", "mine this session", or after any session with repeated corrections, retries, or permission friction.
---

# Session Postmortem (manual emulation of LOOP-1..2)

Kelson's loop mines transcripts → proposes pack diffs → gates on evals. Until the eval harness exists (Phase 2), this skill runs the same pipeline with the human as the gate: **propose-only, never auto-apply**.

## Procedure

1. **Mine this session**, `.kelson/telemetry/events.jsonl`, and `.kelson/findings.json` plus `.kelson/archive/findings.json` (closed findings live in the archive — mine both; root-cause taxonomy is in the active file — look for repeating root_cause values across tasks) for friction, in these classes:
   - **Corrections:** the user redirected or amended something you did — quote the exchange.
   - **Retries:** a tool call or approach failed and was re-attempted — what made the first attempt fail?
   - **Rule misses:** an existing rule/skill/hook should have fired or helped and didn't (or fired wrongly).
   - **Repeated manual work:** anything done ≥ 2 times by hand that a skill, hook, or script could own.
   - **Hook blocks:** spec-lint/kelspec-lint/typecheck rejections — were they correct (working as intended) or noise?
2. **Compile lessons:** one line each — `evidence → inference`. Discard anything without a quotable trace (LOOP-1's rule: no evidence link, no proposal).
3. **Propose diffs**, each tied to its lesson: a concrete edit to CLAUDE.md, a skill, an agent, a hook, or a new small script. State the expected effect in Kelson's terms (fewer corrections / fewer retries / fewer tokens) so the claim is checkable later. Never propose weakening a lint/gate to stop it from firing — that's the Goodhart move LOOP-4 exists to prevent.
4. **Gate = the human.** Present proposals as a numbered list with evidence; apply only what's approved. Record applied ones in the commit message (`postmortem: <lesson>`), which serves as the changelog until Phase 4.

## Output format

```
## Lessons (evidence → inference)
1. …
## Proposals
1. [target file] — diff summary — expected effect — evidence: lesson 1
```
