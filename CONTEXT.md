# Kelson

Self-improving, token-efficient engineering harness: work flows feedback → ideation → planning → spec → build → verify, every behavioral claim compiles to an executable check, and the harness's own configuration evolves only through evidence. This file is the ontology — the canonical vocabulary. Requirements live in `docs/specs/`; this file owns what the words mean.

## Language

### Architecture & Change Control

**Kernel**:
The four stable, human-governed components — telemetry, eval harness, router, artifact store. The self-improvement loop has no write path to it.
_Avoid_: core, engine

**Pack**:
The versioned, evaluable, revertible unit of everything outside the kernel: skills, rules, routing tables, agent entries, eval suites. One mechanism governs all of them.
_Avoid_: plugin, extension, addon

**Lockfile**:
The pinned set of installed packs. Its content hash *is* the configuration's identity — sessions pin it, eval runs record it, proposals transition it parent → child.
_Avoid_: config hash, environment

**Pack registry**:
The public repository where packs are published with signatures and ledger evidence. Always qualify which registry you mean — there are three (pack, agent, model).

**Ledger**:
The public, machine-generated record of eval evidence per pack version. Entries are produced only by the eval runner, never hand-authored.
_Avoid_: results file, scoreboard

**Proposal**:
A candidate pack diff moving through the loop's state machine (proposed → gated → applied → monitoring → stable | reverted). The only way the harness changes itself.
_Avoid_: suggestion, patch, PR

**Gate**:
The statistical decision that approves or rejects a proposal: non-inferiority on both north-star metrics, improvement on at least one, at minimum sample size. Underpowered is always rejected.
_Avoid_: check, review

**Evidence link**:
A machine-checkable pointer from a proposal to the telemetry that motivated it. A proposal without resolvable evidence never reaches the gate.

**Monitor**:
The post-apply watch on a proposal's live metrics. A regression inside the monitoring window triggers auto-revert and quarantine.

**Changelog**:
The append-only record of every applied, reverted, or human-made configuration change. Entries are never rewritten; corrections are new entries.
_Avoid_: history log, audit table

**Quarantine**:
Exile pending human release. Two senses, same rule: a *flaky benchmark task* is quarantined out of gating; a *reverted proposal* is quarantined against re-apply and re-proposal (by id and content). Only a human releases either.

**Postmortem compiler**:
The loop component that mines session telemetry for friction (retries, corrections, overruns) and compiles it into proposals.
_Avoid_: retro bot, analyzer

**Finding**:
A recorded defect or violation row — spec bug, audit violation, clause gap — with root cause and fix status. The raw feedstock the loop mines.
_Avoid_: issue, ticket

### Pipeline & Work

**Stage**:
One of the six SDLC phases: feedback, ideation, planning, spec, build, verify. Each stage's behavior is a pack.
_Avoid_: SDLC step, phase (reserved for delivery phases 0–10)

**Step**:
One assistant turn — exactly one model call plus the tool executions it requests. The unit of routing, budgeting, and telemetry. A step happens *within* a stage; never use step and stage interchangeably.
_Avoid_: turn, iteration

**Signal**:
A normalized inbound feedback record from any source — human report, telemetry insight, external production event — triaged into the idea backlog.
_Avoid_: alert, notification

**Idea**:
A triaged backlog entry derived from signals, carrying a priority bucket (now/next/later/dismissed) and a rationale.
_Avoid_: feature request, story

**Task**:
The unit of routed work, with lifecycle open → in_progress → delivered → accepted | corrected | abandoned. Tasks outlive sessions and resume across them.
_Avoid_: job, ticket

**Acceptance**:
A delivered task's terminal success, by exactly one of two paths: explicit human approval, or a merge that survives the correction window untouched.

**Correction window**:
The period (default 24h) after merge during which any corrective edit or requirement-changing re-prompt moves the task to corrected instead of accepted.

**Intervention**:
A human action during a session, classified as correction, clarification, or approval, linked to the artifact it concerns. Corrections drive the correction-rate metric.
_Avoid_: feedback (that's the stage), interruption

**FPAR**:
First-Pass Acceptance Rate — the fraction of tasks accepted with zero corrective edits and zero requirement-changing re-prompts. North-star metric, up.

**TPAC**:
Tokens Per Accepted Change — cost-normalized tokens (weighted by per-model prices at execution time) per accepted change. North-star metric, down. Raw token counts are never comparable across models.

**Harness overhead ratio**:
Spend on evals, replay, and the loop divided by spend on product work. Capped; overflow queues rather than runs.

### Specs & Traceability

**Spec**:
A kelspec document: human-reviewable Markdown whose fenced blocks are the machine-parseable contract between planning and build.

**Clause**:
An addressable requirement inside a spec, in EARS form, with a stable never-renumbered ID. The atom of traceability — links, drift, and obligations are all clause-level.
_Avoid_: requirement (informally fine, but the addressable thing is the clause)

**Obligation**:
The executable check a clause compiles to — property test, metamorphic relation, model check, or proof. A clause that cannot compile to one is vague by definition and rejected.
_Avoid_: unit test, spec test

**EARS**:
The requirement-syntax taxonomy every clause uses: ubiquitous, event-driven, state-driven, unwanted-behavior, optional.

**Criticality tier**:
The rigor ladder — T0 (compiled obligations), T1 (adds a model-checked state machine), T2 (adds formal treatment of the core). Escalation is mechanical; humans may raise a tier, never lower it.
_Avoid_: severity, priority

**Authority**:
A clause's provenance: authored (human-written), inferred (excavated from code, alerts only), or confirmed (human-promoted inferred). Only non-inferred clauses can block builds.

**Excavation**:
Inferring candidate spec clauses from an existing codebase's code, tests, and behavior. Everything excavated arrives as inferred.
_Avoid_: reverse engineering, spec mining

**Artifact**:
Any traceable unit in the chain signal → idea → PRD → spec clause → code region → test. Identity is its logical location; versions are content hashes.

**Trace link**:
A directed upstream/downstream edge between artifacts with both endpoints' hashes frozen at link time. Drift detection compares frozen hashes against current ones.

**Drift**:
A linked artifact's content moved after linking: code changed under an unchanged spec, spec changed over unchanged code, or an upstream went stale. Flagged transitively downstream.
_Avoid_: staleness (that's the upstream-hash condition, one cause of drift)

**Divergence testing**:
Two isolated agents implement the same clause blind; any difference in observable behavior on shared probes is a material divergence — proof of under-specification, routed back to planning.
_Avoid_: A/B implementation, dual build

### Routing & Budgets

**Router**:
The kernel component mapping (stage, feature vector) → (model, effort, loadout, agent) per step, from the active routing policy.

**Feature vector**:
The routed step's normative features: stage, tier, size, language, novelty, task type, repo. Recorded on every decision.

**Task type**:
`mechanical` (touches no clause-governed logic: renames, formatting, changelog lines) or `standard`. Mechanical work routes cheap by policy.

**Agent registry**:
The open catalog of routing targets: base models at effort tiers, subagents, and custom/fine-tuned agents with declared capabilities and a cost class.
_Avoid_: unqualified "registry"

**Loadout**:
The set of packs loaded for a routed step.
_Avoid_: context (that's the bundle), toolkit

**Budget**:
The token allowance attached to every routed step. Exceeding it records an overrun; 2× pauses for triage rather than burning on.

**Triage**:
The human (or headless-policy) decision at a budget pause: continue, escalate, or re-spec.

**Escalation ladder**:
The ordered stronger targets a failed step retries on, capped at two automatic escalations before triage. Ladders order upward only.

**Regret**:
The recorded cost of having routed too cheap — every escalation emits one. The router's error signal.

**Exploration**:
The bandit's controlled try-the-cheaper-config move: T0 only, downward in cost only, reproducible from telemetry. Its entire write surface is selection weights — never policy structure.
_Avoid_: experimentation (that's evals)

**Arm**:
One selectable target within a rule that the bandit weighs.

### Evaluation

**Eval suite**:
A pack of benchmark tasks with a role: gating (its verdicts can approve proposals) or staging (evidence-free holding pen; gates nothing until promoted).

**Benchmark task**:
A golden task: verbatim statement, content-addressed repo snapshot, checks that must pass, and a budget ceiling. Exceeding budget is failure — cost discipline is part of correctness.

**Snapshot**:
A content-addressed capture of repo state plus an environment manifest, sufficient to restore bit-identically.

**Ablation**:
The paired suite run answering "does pack X help?": current lockfile vs the same with X toggled, per-task paired deltas.

**Replay**:
Re-executing a past real session's task under a candidate configuration, scored by the original checks. The bridge between benchmark evidence and real work — a veto stage, subject to validity rules.

**Advisory**:
A replay that failed validity (snapshot mismatch, model mismatch, incomplete original). Reported, never gated on.

**Executor**:
The named producer of a session under test: `claude` (Claude Code headless), `command` (scripted fixture), or `api` (the native runtime). Only `claude`-executor runs publish to the ledger.

**Bench run**:
A comparison of *agents* (executor vs executor) under one configuration — "does the native runtime beat Claude Code here?" Never pack evidence; structurally unpublishable.
_Avoid_: eval run (that compares configurations)

**Verdict**:
The gate's four-valued outcome: helps, hurts, no_effect, underpowered — always with effect sizes and confidence intervals, never bare pass/fail.

**Flaky**:
A benchmark task with materially mixed results across identical configurations. Auto-quarantined out of gate math.

**Sandbox profile**:
The isolation level of an eval run: `container` (the security boundary, mandatory for anything not operator-authored) or `worktree` (operator-convenience isolation, not a security boundary). Required-but-unavailable container means refuse, never degrade.

**Run manifest**:
The recorded reproduction key of an eval run — lockfile, suite version, models, seed, executor, sandbox profile. Every ledger claim traces to one.

### Native Runtime & Sessions

**Runtime**:
Kelson's own agent loop — sessions, steps, tools, permissions, provider access — with Claude Code remaining one executor among peers.
_Avoid_: agent (overloaded; qualify as agent loop or registry agent)

**Session**:
One continuous run of the harness, pinning its lockfile at start and recording its runner (`cc` or `native`). Sessions are events on a tree, never mutated history.

**Head**:
The session's current position, derived from the event chain — never a mutable pointer.

**Fork**:
A new branch sharing every ancestor of its fork point. Both branches' histories coexist; nothing is lost.
_Avoid_: checkpoint, restore

**Compaction**:
A summary event substituting for a covered span during context reconstruction. The covered events remain; forks from before it keep full history.
_Avoid_: truncation, pruning

**Pause**:
A durable, resumable suspension of a step with a reason (permission ask, budget triage). Survives process death; resuming never re-executes completed work.

**Permission rule**:
`{tool glob, arg glob, allow | ask | deny}`. Deny always wins; among the rest, most-specific wins; defaults are allow for read-only tools, ask for everything else.

**Auth kind**:
How a session paid: `api_key`, `subscription`, or `none`. Subscription costs are list-price yardsticks, not spend — and never ledger evidence.

**Model registry**:
The catalog of known models — context windows, capabilities, prices — shipped defaults overlaid by user entries.
_Avoid_: unqualified "registry"

**Bundle**:
The context compiler's minimal task context: compressed repo map, governing clauses, neighbor signatures — never raw whole-file dumps by default. Token-accounted exactly.

**Bundle miss**:
An on-demand content load the bundle didn't include. Tracked per task type; the compiler's error signal.

**Degraded**:
A session marked when a kernel capability failed mid-run. The session continues (the harness never blocks work) but is excluded from all eval math.

**Promotion**:
A human elevating something into a more authoritative role. Four senses, one principle — machines propose, humans promote: inferred clause → confirmed; staged suite task → gating; session → benchmark task; quarantined item → released.
