# PRD: Kelson — a Self-Improving, Token-Efficient Engineering Harness

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Name:** Kelson — the keelson is the member that binds a ship's frames to its keel: the piece that fastens everything to the spine. npm package `kelson` and binary name verified available 2026-07-02; no known tool collision (unlike "keel", taken on npm and colliding with keel.sh).
- **Deliverable scope:** This PRD covers the product from feedback ingestion through build and verification. Deployment and production monitoring are adjacent concerns (§2.2, §8.7).

---

## 1. Overview & Problem Statement

Engineers using coding agents today lose value in three compounding ways:

1. **Ambiguity in, rework out.** Agents are given prose task descriptions that admit multiple reasonable interpretations. The agent picks one; the engineer wanted another. The cost is paid as review cycles, corrections, and re-runs — the most expensive tokens are the ones spent redoing work.
2. **Token waste.** Sessions load whole files when a signature would do, models narrate when they should act, generated code carries comments nobody asked for, and frontier models are used for mechanical work a small model does equally well.
3. **No feedback loop.** Every session starts from zero. The lessons of yesterday's session — which skill helped, which instruction was ignored, which model wasted effort — evaporate. Configuration (skills, rules, MCP servers, agents) accumulates by intuition, never by evidence. Nobody can answer "does skill X actually make outcomes better?"

Kelson is an open-source harness that attacks all three:

- **Ambiguity** is eliminated structurally: work flows through specs written in a constrained format where every behavioral claim must compile to an executable obligation (a property-based test or a formal-model check). A claim that cannot be compiled is, by definition, vague — and is rejected before build starts.
- **Token waste** is attacked by a learned router (right model, effort, context, and agent per step) and a context compiler (minimal task bundles instead of raw file loads), plus efficiency rules (verbosity control, comment suppression, compression).
- **The missing feedback loop** is the core of the product: telemetry from every session feeds a postmortem compiler that proposes improvements to the harness's own configuration, and a built-in eval harness gates those changes — only measurable improvements are applied, and regressions auto-revert.

The unifying design idea: **everything the system can change about itself is a versioned, evaluable, revertible artifact ("pack")**, and one uniform mechanism — propose diff → eval gate → apply → monitor → revert — governs all self-improvement.

## 2. Goals & Non-Goals

### 2.1 Goals

- G1. Raise the fraction of agent tasks that are accepted **first pass**, without human correction or rework.
- G2. Reduce **tokens per accepted change** without reducing acceptance quality.
- G3. Make specs the **single source of truth**: unambiguous, executable, drift-detected against code.
- G4. Make the harness **self-improving**: each session's telemetry can change future sessions' configuration, gated by evidence.
- G5. Provide a built-in **eval tool** that answers, with statistics rather than vibes: "is this skill / MCP server / agent / rule / model choice helping?"
- G6. Route every SDLC step to the **cheapest configuration that meets the quality bar**, including custom fine-tuned agents.
- G7. Ship as a usable **open-source product**: installable, documented, privacy-respecting, community-extensible.

### 2.2 Non-Goals

- NG1. **Deployment pipelines and production monitoring.** Kelson does not deploy code or observe production. It defines a *signal ingestion contract* (§8.7) so external deployment/monitoring systems can feed the feedback stage, and sketches what a future integration looks like — but building those pipelines is out of scope.
- NG2. **Replacing the underlying agent runtime.** V1 layers on Claude Code (§5.4); it does not reimplement session management, permissions, or tool execution.
- NG3. **General project management.** Kelson maintains an idea backlog derived from signals; it is not a Jira replacement.
- NG4. **Proving arbitrary user code correct.** Full formal verification is an escalation tier applied to qualifying components (§7.4), not a promise for all code.

### 2.3 End State (v-final)

The v1 phases (§16) climb toward a defined asymptote. Kelson is *done* — in the sense that further work is refinement, not construction — when:

- **E1 — Human role converges to two jobs.** Authoring/approving specs, and governing the gates (eval suites, safety thresholds, tier escalations). Everything between a confirmed spec and a verified change is agent work.
- **E2 — The outer loop closes.** A production signal (via the §8.7 contract, carried by a future Kelson Deploy companion) becomes a proposed spec diff → verified fix → gated release candidate with no human drafting — the human reviews and approves.
- **E3 — Configuration is fully learned.** No hand-tuned routing entries remain: every routing-policy entry and every default pack carries reproducible eval evidence, and operator config effort trends to zero while FPAR holds.
- **E4 — Numbers.** FPAR ≥ 90% sustained on live work (not just benchmarks); harness overhead ratio (§3) ≤ 15%; the kernel's own T2 obligations fully discharged (model-checked loop, verified gate core).
- **E5 — Evidence network.** Federated pack ledgers: packs travel with reproducible cross-org evidence, so the ecosystem is a marketplace where value is proven, not claimed.

Each end-state criterion is measurable, so post-v1 roadmaps are scored against E1–E5 rather than argued from taste.

## 3. North-Star Metrics & Success Criteria

Two north stars; every mechanism in this PRD must justify itself against one of them.

| Metric | Definition | Direction |
|---|---|---|
| **FPAR** — First-Pass Acceptance Rate | % of tasks whose output is accepted with zero human corrective edits and zero re-prompts that change the requirement | ↑ |
| **TPAC** — Tokens per Accepted Change | **Cost-normalized** tokens (each step's tokens weighted by the per-model unit prices recorded on the step event — raw tokens are not comparable across a routed multi-model system) across all models and steps, including eval overhead attributable to the task, divided by accepted changes | ↓ |

**Task and acceptance, defined** (FPAR is meaningless without these): a **task** is the unit of routed work with lifecycle `open → in_progress → delivered → accepted | corrected | abandoned`; `abandoned` is reachable from any non-terminal state (work can be dropped before delivery), the other transitions follow the chain. A delivered task is **accepted** by exactly one of two paths: (a) explicit human approval (`/kelson:accept`) — immediate and terminal; later edits feed the correction-rate metric but do not reopen the task; or (b) merge, which holds the task in `delivered` until the correction window (default 24h) closes — any corrective edit or requirement-changing re-prompt inside the window moves it to `corrected` instead. A task's `correction_count` is the number of correction-class interventions (TEL-4) recorded against it, maintained at ingestion time — the correction-rate metric derives from it.

**TPAC attribution rule:** eval/obligation runs triggered by the task's own stages (PIPE-7 continuous checks, its verify stage) count toward that task's TPAC; loop proposals, suite runs, and replays are never attributed to individual tasks — they are visible only in the harness overhead ratio (EVAL-7).

Secondary metrics (diagnostic, feed the improvement loop):

- Retry rate (agent-internal re-attempts per task)
- Correction rate (human edits to agent output within 24h of acceptance)
- Spec-drift incidents (code/spec hash mismatch events, §6.4)
- Eval gate pass rate for proposed improvements (too low = postmortem compiler is noisy; too high = gate may be weak)
- Ambiguity catch rate (spec defects found by divergence testing before build vs. discovered during/after build)
- Routing regret (estimated tokens wasted by routing to a stronger config than needed, from bandit counterfactuals)
- Harness overhead ratio (cost-normalized tokens spent on evals, replay, and the improvement loop ÷ tokens spent on product work; capped per EVAL-7)

Success criteria for v1 (measured on the maintainers' own usage plus opt-in community telemetry):

- S1. FPAR improves ≥ 15 percentage points on the benchmark suite versus the same tasks run on vanilla Claude Code with the same base model.
- S2. TPAC improves ≥ 30% on the benchmark suite under the same comparison.
- S3. The eval tool can detect a deliberately-injected harmful rule (a "regression canary" pack) with ≥ 95% probability at the configured sample sizes.
- S4. At least one self-proposed improvement passes the eval gate and survives 30 days without revert.

## 4. Personas & Primary Use Cases

- **P1 — Solo OSS engineer, greenfield.** Starts a new project with Kelson from day one. Wants: ideas → PRD → spec → code with minimal back-and-forth, and confidence the config is actually tuned rather than cargo-culted.
- **P2 — Team engineer, brownfield.** Adopts Kelson on an existing codebase. Wants: spec excavation to bootstrap invariants from existing code/tests, drift detection from then on, and evidence before the team standardizes on a skill/MCP loadout.
- **P3 — Pack contributor.** Builds a skill/rule/routing pack and submits it. Wants: a clear contract, and an objective bar — the eval gate — rather than maintainer taste, for whether the pack merges.
- **P4 — Harness operator.** Runs Kelson long-term. Wants: a changelog of every self-applied change, one-command revert, and hard guarantees the system cannot modify its own safety mechanisms.

Primary use cases:

- UC1. "Take this feature request through ideation → PRD → spec → build → verify."
- UC2. "Is `ponytail` (or any pack) actually improving my outcomes? Run the ablation."
- UC3. "Mine my last 50 sessions and propose config improvements; apply what proves out."
- UC4. "Retrofit specs onto this existing service and alert me when code drifts from them."
- UC5. "Route this refactor's mechanical steps to a cheap model, its design step to a frontier model, and its domain-specific migration step to our fine-tuned agent."

## 5. Architecture: Kernel + Evolvable Packs

### 5.1 Overview

Kelson is a **small human-governed kernel** plus **versioned packs** for everything else.

```
┌────────────────────────────────────────────────────────────┐
│                         KERNEL (stable, human-governed)     │
│  ┌───────────┐ ┌──────────────┐ ┌────────┐ ┌─────────────┐ │
│  │ Telemetry │ │ Eval Harness │ │ Router │ │ Artifact    │ │
│  │           │ │  (gate)      │ │        │ │ Store       │ │
│  └─────┬─────┘ └──────┬───────┘ └───┬────┘ └──────┬──────┘ │
└────────┼──────────────┼─────────────┼─────────────┼────────┘
         │              │             │             │
   events in      gates diffs    reads policy   traceability
         │              │        packs          hashes
┌────────┴──────────────┴─────────────┴─────────────┴────────┐
│                    PACKS (versioned, evolvable)             │
│  stage packs · efficiency packs · spec tooling · routing    │
│  tables · eval suites · agent registry entries              │
└─────────────────────────────────────────────────────────────┘
              ▲                                    │
              │ eval-gated diffs                   │ configure
┌─────────────┴──────────────┐        ┌────────────▼──────────┐
│  Self-Improvement Loop     │◄───────│  SDLC Pipeline        │
│  (postmortem compiler)     │ mined  │  feedback→…→verify    │
└────────────────────────────┘ from   └───────────────────────┘
```

### 5.2 The Kernel

Four components, and only four. The kernel is deliberately small so it can be held to the top of the rigor ladder (§7.4) and so the self-improvement loop has a crisp boundary it may never cross (§9.3).

1. **Telemetry** (§6.1) — turns session transcripts into structured events.
2. **Eval harness** (§6.2) — benchmark suites, ablation, counterfactual replay, statistical gating.
3. **Router** (§6.3) — per-step policy: model, effort, context loadout, agent.
4. **Artifact store** (§6.4) — specs/PRDs/ERDs/ADRs with hash-linked traceability and drift detection.

### 5.3 Packs

A **pack** is a versioned directory with a manifest, containing any subset of: skills/prompt fragments, rules (e.g., comment suppression), routing table entries, agent registry entries, spec tooling (generators, templates), and eval suites. Properties:

- **Versioned:** semver; the installed set is pinned by a **lockfile**.
- **Evaluable:** any pack can be ablated (on/off) in the eval harness; every eval result records the lockfile hash it ran under, making results reproducible and comparable.
- **Diffable & revertible:** self-improvement operates only by proposing diffs to packs; every applied diff is a changelog entry with a one-command revert.
- **Uniform:** a community-contributed skill, an auto-generated rule tweak, and a routing table are the same kind of object, governed by the same gate.

### 5.4 Form Factor: Three Options Compared

| Criterion | (A) Claude Code-native layer | (B) Standalone CLI on Agent SDK | (C) Hybrid: CC layer + external services |
|---|---|---|---|
| Build cost | Lowest — skills/hooks/subagents/plugins | Highest — rebuild session mgmt, permissions, context handling | Medium |
| Control over loop (routing, context assembly) | Partial — hooks can steer but not fully own the loop | Total | Inner loop partial; outer loop (evals, replay, telemetry) total |
| Eval isolation (run benchmarks headless, repeatably) | Weak — evals inside interactive sessions are awkward | Strong | Strong — eval runner is an external CLI driving headless sessions |
| Telemetry depth | Transcripts + hooks give most of what we need | Everything | Transcripts + hooks; external store does aggregation |
| Lock-in | Claude Code only | None (but v1 would still target Claude models) | Inner loop CC; outer components runtime-agnostic by design |
| Self-improvement mechanics | Config/skill files are already the unit of change — natural fit | Must invent equivalent | Same natural fit, plus out-of-session gating |

**Decision: v1 ships as (C), the hybrid.** A Claude Code-native plugin (skills, hooks, subagents, slash commands) provides the inner loop; three external components — the **eval runner CLI**, the **telemetry store**, and the **replay engine** — run outside sessions, because gating and replay must be headless, repeatable, and isolated from the session being measured.

**Migration criteria to (B), a standalone Agent SDK harness** (documented so the community can hold us to it): we migrate if (a) routing requires mid-turn model switching that hooks cannot express, or (b) the context compiler needs byte-level control of the prompt that Claude Code does not expose, or (c) ≥ 2 of the kernel's components are blocked by Claude Code release timing for > 1 quarter. The external components are runtime-agnostic from day one so migration replaces only the inner-loop plugin.

## 6. Kernel Component Requirements

Requirements use EARS syntax. Each carries an **Obligation** — the executable check that makes the requirement testable (dogfooding §7.2: a requirement without an obligation is vague by our own definition).

One requirement spans all four components:

- **KERN-1.** If any kernel component fails or is unavailable, then the harness shall degrade to vanilla Claude Code behavior for the affected capability — never blocking the user's work — and shall mark affected sessions as degraded (excluded from eval computations, per TEL-5's pattern).
  *Obligation:* fault-injection matrix — each kernel component killed in turn; the session completes, and the degraded marker is present.

### 6.1 Telemetry

Turns raw session transcripts and tool logs into a structured event stream.

**Event schema (minimum):** session id, task id, SDLC step, timestamp, model + effort used, packs active (lockfile hash), tokens in/out per step, retries, tool errors, human interventions (classified: correction / clarification / approval), diff churn (lines added then removed within the session), test outcomes, spec-drift events.

- **TEL-1.** When a session ends, the telemetry component shall emit a structured event record for every SDLC step executed in that session. In a Claude Code transcript, a step boundary is a **unique assistant message id** — a transcript writes one JSONL line per content block, so lines sharing a `message.id` are one step, and the last-seen usage for that id is authoritative.
  *Obligation:* PBT — for any generated synthetic transcript containing N step boundaries (unique message ids, each possibly spanning several duplicate-id lines), parsing yields exactly N step records whose per-class token counts sum to the transcript total under the dedup rule.
- **TEL-2.** The telemetry component shall store all events locally by default, and shall transmit no event off-machine unless the operator has explicitly opted in.
  *Obligation:* integration test — with opt-in unset, a network-recording harness observes zero outbound telemetry calls across a full session.
- **TEL-3.** Where the operator has opted into sharing, the telemetry component shall strip source code content, file paths, and prompt text from shared events, sharing only numeric/categorical fields.
  *Obligation:* PBT — for any event containing marker strings planted in code/path/prompt fields, the serialized shared payload contains no marker.
- **TEL-4.** When a human intervention occurs, the telemetry component shall classify it as correction, clarification, or approval, and shall link it to the artifact hash it concerns.
  *Obligation:* golden-set test — ≥ 90% classification agreement with a hand-labeled intervention corpus (the classifier is Phase-deferred); plus a storage-linkage unit test — `ingestInterventionEvent` persists the intervention linked to its `artifact_hash`, and a `correction`-class event increments the target task's `correction_count` while `clarification`/`approval` leave it unchanged (the correction-rate metric derives from this count).
- **TEL-5.** If telemetry capture fails during a session, then the harness shall continue the session, mark the session's records as incomplete, and exclude them from eval computations.
  *Obligation:* fault-injection test — killing the collector mid-session neither aborts the session nor lets the partial record enter a gate computation.
- **TEL-6.** Where an OpenTelemetry exporter is configured (off by default), the telemetry component shall project sessions as traces and step events as spans over OTLP, with north-star and secondary metrics exported as OTel metrics, applying the same content-stripping rules as TEL-3 to all attributes.
  *Obligation:* integration test — a session against an OTLP collector fixture yields one trace, one span per step with token/cost attributes, and no marker strings from planted code/path/prompt content.
- **TEL-7.** The telemetry component shall track every task through the lifecycle defined in §3 (`open → in_progress → delivered → accepted | corrected | abandoned`), recording the acceptance signal (explicit approval, or clean merge past the correction window) that justified any `accepted` transition.
  *Obligation:* PBT — for any generated sequence of task events, the recorded state always follows the lifecycle's legal transitions, and every `accepted` record carries a signal.

### 6.2 Eval Harness

The gate. Two layers — **benchmark suites** (causal, curated) and **live telemetry** (ecological, passive) — plus **counterfactual replay** bridging them.

**Benchmark suites.** A suite is a pack containing golden tasks: input (repo state + task statement + spec), expected outcome checks (tests that must pass, properties that must hold, artifacts that must exist), and budget ceilings. Suites are runnable headless via the eval runner CLI.

**Ablation.** Because every capability is a pack, "does X help?" is: run suite with lockfile L and with L∖{X}, paired per task, compare FPAR/TPAC.

**Counterfactual replay.** The replay engine re-executes past real sessions' tasks under a candidate configuration (same task statement, same starting repo state, captured at session start) and scores outcomes with the same checks. This gives candidate changes exposure to *real* work distribution before they touch live sessions.

- **EVAL-1.** The eval harness shall support running any benchmark suite under any two lockfile configurations and shall report paired per-task deltas for FPAR, TPAC, and suite-specific checks.
  *Obligation:* self-test suite — a fixture pack with a known injected effect produces the expected sign of delta on every run.
- **EVAL-2.** The eval harness shall approve a candidate diff only if the configured statistical test (default: paired bootstrap on FPAR and TPAC; full procedure, margins, and defaults in the [Eval procedure spec](./2026-07-02-eval-procedure.md) §5) shows non-inferiority on **both** north-star metrics **and** improvement in at least one, at no less than the suite's configured minimum sample size.
  *Obligation:* statistical unit tests — synthetic result distributions with known effect sizes are accepted/rejected at the configured error rates (±2%); underpowered runs (n below minimum) are always rejected regardless of observed delta.
- **EVAL-3.** If a benchmark task is non-deterministic across identical configurations per the flakiness rule in the [Eval procedure spec](./2026-07-02-eval-procedure.md) §6 (which owns the window size, band, and config keys), then the eval harness shall quarantine the task and exclude it from gating until re-approved by a human.
  *Obligation:* flakiness detector test per EVP-5.
- **EVAL-4.** The eval harness shall record, for every eval run: lockfile hash, suite version, base model versions, seed, and per-task raw results, sufficient to reproduce the comparison.
  *Obligation:* round-trip test — re-running from a recorded manifest reproduces identical pass/fail verdicts for deterministic tasks.
- **EVAL-5.** When a candidate diff passes benchmarks, the eval harness shall additionally require counterfactual replay of the most recent 10 `complete` sessions that pass replay validity (session IDs recorded in the run manifest), judged by the replay decision rule in the [Eval procedure spec](./2026-07-02-eval-procedure.md) §5.1, before the diff is eligible for auto-apply.
  *Obligation:* integration test — a diff that improves benchmarks but degrades replayed real tasks is rejected; the manifest lists the exact session IDs replayed.
- **EVAL-6.** Eval suites that gate self-improvement shall be modifiable only through human-approved changes; the self-improvement loop shall have no write path to them (see LOOP-4).
  *Obligation:* permission test — a loop-originated diff targeting an eval-suite pack is rejected at the kernel boundary with an audit log entry.
- **EVAL-7.** The harness shall cap cost-normalized spend on evals, replay, and the improvement loop at a configured fraction of productive spend (default 15%, trailing 30 days); when the cap is reached, further loop/eval work queues rather than runs, and the harness overhead ratio is reported as a first-class metric.
  *Obligation:* simulation test — synthetic spend streams at/over the cap queue new eval work and never exceed the cap by more than one in-flight run.

### 6.3 Router

Maps `(SDLC step, task features)` → `(model, effort, context loadout, agent)`.

**Task features** (initial set): step type, estimated task size (files touched), language/framework, novelty, criticality tier of the touched spec (§7.4), and repo — each defined precisely, with buckets and the novelty formula, in the [Routing policy spec](./2026-07-02-routing-policy.md) §2.

**Routing targets** are entries in an open **agent registry** (a pack): base models at effort tiers, subagent definitions, and custom/fine-tuned agents with declared capabilities (e.g., "payments-domain migration agent"). Fine-grained routing to business-specific agents is a first-class case, not an extension.

**Learning.** The routing policy is a pack (a table plus a scoring model). It improves two ways: (a) offline — eval-gated diffs like any pack, using benchmark + replay evidence; (b) online — a conservative contextual bandit that may only explore *downward* in cost (try the cheaper config) on low-criticality tasks, with automatic escalation on failure.

- **RTR-1.** When an SDLC step begins, the router shall select model, effort, context loadout, and agent from the active routing policy pack and shall record the decision and its feature vector in telemetry.
  *Obligation:* PBT — for any feature vector, the router returns a target present in the registry, and the decision record round-trips through telemetry.
- **RTR-2.** If a routed step fails its verification checks, then the router shall escalate the retry to the next-stronger configuration on the policy's escalation ladder and shall record the escalation as a routing-regret event.
  *Obligation:* integration test — an injected failure at a cheap tier produces exactly one escalation and one regret event.
- **RTR-3.** While a task touches a spec at criticality tier T1 or above (§7.4), the router shall not select exploratory (bandit) configurations, only the policy's exploit configuration — exploration is a T0-only behavior (normative conditions in the [Routing policy spec](./2026-07-02-routing-policy.md) §4).
  *Obligation:* PBT — no generated sequence of bandit decisions ever assigns an exploration arm to a T1+ feature vector.
- **RTR-4.** The router shall support routing to registered custom agents, matched on declared capabilities, and shall fall back to the default agent when no capability matches.
  *Obligation:* unit tests — capability match, no-match fallback, and ambiguous-match (most specific wins) all covered.
- **RTR-5.** Online policy updates shall adjust only selection weights within the human-approved policy structure; structural changes to the policy (new arms, new features) go through the eval gate as pack diffs.
  *Obligation:* schema test — the online updater's write surface is limited to the weights field; any other mutation is rejected.

### 6.4 Artifact Store

Specs, PRDs, ERDs, ADRs live **in the target repo** (not in Kelson's own state), under a conventional directory, so they travel with the code and survive Kelson's removal.

**Traceability.** Every artifact carries content hashes of its upstream artifacts: `feedback signal → idea → PRD section → spec clause → code region → test/property`. Code regions link back via spec-clause IDs referenced in committed metadata (not code comments — see §12.3). Drift is mechanical: if an upstream hash no longer matches, everything downstream is flagged stale.

- **ART-1.** When an artifact is created or modified, the artifact store shall record the content hashes of its declared upstream artifacts.
  *Obligation:* PBT — for any generated artifact DAG, every node's recorded upstream hashes match the current upstream contents iff no intervening edit occurred.
- **ART-2.** When any artifact changes, the artifact store shall flag all downstream artifacts whose recorded upstream hash no longer matches, within the same session or on next harness activation.
  *Obligation:* PBT — for any edit to any node in a generated DAG, exactly its transitive downstream set is flagged.
- **ART-3.** The artifact store shall detect spec-code drift in both directions: code changed under an unchanged spec clause, and spec clause changed over unchanged code.
  *Obligation:* integration test — both directions raise distinct drift events.
- **ART-4.** If a build step is requested for a task that touches a stale **non-inferred** clause (`authority: authored` or `confirmed`), then: at tier T1 or above the harness shall block the build step and route to spec repair; at T0 it shall warn and proceed. `authority: inferred` clauses never block regardless of tier (SPEC-7 — they alert only). A recorded human override — persisting who overrode and why — may unblock any case.
  *Obligation:* integration matrix — stale-authored and stale-confirmed T1 block, stale-confirmed T0 warns and proceeds, stale-inferred any-tier proceeds with alert, override attribution (who, why) round-trips through storage.
- **ART-5.** When drift detection runs, the artifact store shall evaluate each trace link whose upstream is a spec clause against hashes frozen on the link itself (`upstream_hash_at_link`, `downstream_hash_at_link` — ERD §3), inserting drift events anchored on the link's downstream artifact: `code_under_spec` when only the downstream hash moved, `spec_over_code` when only the upstream spec-clause hash moved, both rows when both moved; and shall not insert while an open event exists for the same `(repo, artifact_id, direction)`. (Pins the ART-3 baseline: divergence testing found that syncing the code-side baseline from the rebuildable artifact index silently erases pending drift on index rebuild.)
  *Obligation:* integration test — an artifact-index re-sync between a code edit and detection does not erase pending `code_under_spec` drift; both-changed yields two rows on one link; re-detection while open inserts nothing.

## 7. Spec System

The anti-vagueness core. Specs are the contract between planning and build.

### 7.1 Spec Format

A constrained, reviewable DSL (YAML/Markdown hybrid; exact syntax is an implementation-plan decision) with these clause types:

- **Requirements** in EARS form (ubiquitous / event-driven / state-driven / unwanted-behavior / optional-feature) — as used throughout §6.
- **Invariants** — properties that must hold in every reachable state of the component.
- **Pre/postconditions** on operations.
- **Domain definitions** — types, ranges, units, enumerations (feeds PBT generators).
- **Criticality tier** (§7.4) and **authority status** (§7.5).

### 7.2 The Compile-to-Obligation Rule

**Every behavioral claim in a spec must compile to an executable obligation**: a property-based test (via Hypothesis/fast-check-class frameworks), a formal-model check (§7.4), or — where a direct oracle is impossible — a metamorphic relation (e.g., "resizing then cropping equals cropping the scaled region"). The spec compiler attempts compilation at spec time:

- **SPEC-1.** When a spec is submitted, the spec compiler shall attempt to compile every requirement, invariant, and pre/postcondition into at least one executable obligation, and shall reject the spec listing every clause that failed to compile.
  *Obligation:* golden corpus — a suite of deliberately vague clauses ("should be fast", "handles errors gracefully") is 100% rejected with clause-level diagnostics; a suite of well-formed clauses compiles 100%.
- **SPEC-2.** The spec compiler shall generate PBT generators from domain definitions, so that obligations run against the spec's declared input domains rather than ad-hoc examples.
  *Obligation:* PBT-of-PBT — generated generators produce only values satisfying the declared domain constraints, verified by sampling.
- **SPEC-3.** If a clause is behavioral but genuinely oracle-free (no property, model, or metamorphic relation exists), then the spec compiler shall require an explicit human-signed `unverifiable` annotation with justification, and shall report the ratio of unverifiable clauses per spec.
  *Obligation:* lint test — an unannotated uncompilable clause blocks the spec; an annotated one passes but increments the reported ratio.

### 7.3 Divergence Testing (the Ambiguity Linter)

Compilation catches vagueness; divergence testing catches *under-specification* — clauses that compile but still admit materially different implementations.

**Material divergence, defined:** any difference in observable behavior — return values, persisted state, or emitted events — between the two implementations on the same probe input, excluding fields the spec explicitly declares nondeterministic (timestamps, IDs). The **probe set** is generated from the spec's compiled domain generators plus their declared boundary values; it is shared verbatim by both implementations.

- **SPEC-4.** Where a spec is marked for divergence testing (default: all new specs at tier T1+), the harness shall have two isolated agents implement the spec independently, run both against the compiled obligation suite plus a shared behavioral probe set, and report any input where the two implementations' observable behavior differs.
  *Obligation:* fixture test — a spec with a known planted ambiguity (unspecified rounding rule) yields a reported divergence naming the probe input; a tightened version of the same spec yields none.
- **SPEC-5.** When divergence is found, the harness shall route the spec back to planning with the divergent inputs attached as mandatory new clauses, and shall not proceed to build.
  *Obligation:* integration test — the divergent spec cannot reach build; the repaired spec can.

Divergence testing is expensive (two implementations); the router treats it as a budgeted step and the eval loop tunes *when it pays for itself* (e.g., perhaps only for T1+ or for specs above a size threshold — that threshold is a routing-policy parameter, learned, not hardcoded).

### 7.4 The Rigor Ladder

| Tier | Applies to | Required rigor |
|---|---|---|
| **T0 — floor** | All code | Compiled obligations (PBT/metamorphic) from the spec |
| **T1 — stateful** | Components with nontrivial state machines, concurrency, or distributed interaction | T0 + a TLA+/Alloy (or equivalent) model of the state machine, model-checked; obligations include conformance checks between code and model where feasible |
| **T2 — critical** | Money paths, security boundaries, data-loss paths, and Kelson's own self-improvement loop | T1 + full formal treatment of the core logic: refinement types or a proof-assistant development (Lean) for the critical kernel of the component, with the verified core wrapped by conventionally-tested adapters |

**Escalation criteria** (mechanical, checked at spec time): a component is T1 if its declared persistent state is mutated by more than one event source (the union of `mutated_by` across its state variables holds ≥ 2 distinct events — the rate-limiter fixture, one state variable driven by two events, is the normative T1 case), or it declares any concurrent access; T2 if its `domains_of_concern` intersects the declared money/security/data-loss set, or it modifies Kelson's own packs (the pack-modification criterion is not yet mechanically enforced by the compiler — deferred). Humans may raise a tier, never lower one below the mechanical result.

- **SPEC-6.** When a spec's declared domains or state structure meet an escalation criterion (§7.4), the spec compiler shall reject any component whose declared tier is below the mechanical result and shall honor a declared tier at or above it (humans may raise, never lower).
  *Obligation:* unit tests over a criteria fixture matrix — a component whose declared state is mutated by ≥ 2 distinct event sources requires T1 and one mutated by a single source stays T0; a component whose `domains_of_concern` intersects {money, security, data_loss} requires T2; a declared tier below the mechanical result is a compile error naming the required tier and its reason (lowering rejected), while a declared tier at or above it compiles unchanged.

### 7.5 Spec Excavation (Brownfield)

For existing codebases: Kelson infers candidate specs from code, tests, types, and observed behavior (agent-driven analysis), and marks every inferred clause **non-authoritative**.

- **SPEC-7.** The excavation tool shall emit inferred spec clauses with `authority: inferred`, each linked to the code evidence it was inferred from, and the harness shall treat inferred clauses as drift *detectors* (alert on violation) but not build *blockers* until a human promotes them to `authority: confirmed`.
  *Obligation:* integration test — violating an inferred clause raises an alert but allows build; violating a confirmed clause blocks per ART-4.
- **SPEC-8.** When an inferred clause has survived N sessions (default 20) without violation or human edit, the harness shall queue it for one-click human promotion, batched.
  *Obligation:* unit test on the promotion queue logic.

Greenfield-first: the v1 benchmark suite and default packs optimize the spec-from-day-one flow; excavation ships in v1 but its depth (how much it infers) grows via the improvement loop.

## 8. SDLC Pipeline: Stage-by-Stage Requirements

The pipeline: **feedback → ideation → planning → spec → build → verify**. Each stage is a pack (evolvable); the kernel provides the rails (routing, telemetry, artifacts, gating).

### 8.1 Feedback Ingestion

An inbox of signals: human feedback, issues, telemetry insights (e.g., "spec drift cluster in module X"), and — via the §8.7 contract — external production signals.

- **PIPE-1.** When a signal arrives, the harness shall normalize it into a signal record (source, evidence links, affected artifacts if known) and triage it into the idea backlog with a priority bucket (closed enum: `now | next | later | dismissed`) and an agent-drafted, human-editable priority rationale.
  *Obligation:* schema validation + golden triage set (≥ 80% agreement with hand triage on the four-bucket enum).

### 8.2 Ideation

- **PIPE-2.** When an idea is taken up, the harness shall draft a problem statement with explicit unknowns and shall interview the human on unknowns before any solutioning (one question at a time; interviewing style itself is a pack).
  *Obligation:* transcript lint — no solution content precedes the last open unknown's resolution in the stage transcript.

### 8.3 Planning (PRD / ERD / ADR)

- **PIPE-3.** The planning stage shall produce a PRD whose behavioral sections are written as EARS clauses ready for spec compilation, and an ERD for data-model changes.
  *Obligation:* the PRD's clauses are run through the spec compiler in lint mode; compile rate is reported and gated (default ≥ 90%).
- **PIPE-4.** When a session makes an architecturally significant decision (heuristics: choosing between explored alternatives, adding a dependency, changing a boundary), the harness shall auto-draft an ADR capturing context, options considered, and decision, linked into traceability, for human confirmation.
  *Obligation:* golden set — sessions with known decision points yield ADR drafts for ≥ 80% of them; no ADR is finalized without human confirmation.

### 8.4 Spec

Covered by §7. Pipeline integration:

- **PIPE-5.** The spec stage shall not complete until SPEC-1 compilation passes and, where required, SPEC-4 divergence testing passes.
  *Obligation:* covered by SPEC-1/4/5 obligations plus a pipeline-order integration test.

### 8.5 Build

- **PIPE-6.** When a build step begins, the harness shall assemble the agent's context exclusively through the context compiler (§12.1): the compiled task bundle, the relevant spec clauses, and the step's loadout — not raw whole-file dumps by default.
  *Obligation:* context audit test — for benchmark tasks, the assembled context contains no file content beyond the bundle manifest (override requires a recorded justification event).
- **PIPE-7.** The build stage shall run obligations relevant to touched spec clauses after every tool-use batch (all tool calls within one assistant message) that modified at least one file governed by a spec clause, not only at stage end.
  *Obligation:* integration test — an edit violating an invariant is flagged before the stage completes.

### 8.6 Verify

- **PIPE-8.** The verify stage shall run: the full compiled obligation suite for touched clauses, the repo's conventional tests, drift checks (ART-3), and budget conformance (did the task exceed its routed token budget), and shall emit a structured verification report into telemetry.
  *Obligation:* report schema validation + fixture tasks exercising each failure class.
- **PIPE-9.** If verification fails, then the harness shall classify the failure (code defect / spec defect / obligation defect) before retrying, and shall route spec defects back to the spec stage rather than patching code to match a wrong spec.
  *Obligation:* fixture set — planted spec-defect failures result in spec-stage routing, not code edits.

### 8.7 Adjacent Concern: Deployment & Production Signals (out of scope, contract only)

Kelson defines a **signal ingestion contract**: a versioned schema (JSON) for external systems to post signals — deploy outcomes, incident summaries, SLO breaches, user-facing error clusters — each with severity, evidence links, and optional artifact references. Anything conforming lands in the §8.1 inbox. A future "Kelson Deploy" companion (release gating on spec conformance, canary interpretation feeding signals back) is sketched in an appendix-level ADR when work begins; nothing in v1 depends on it.

- **PIPE-10.** The harness shall accept and triage any signal conforming to the published contract schema without knowledge of its producer.
  *Obligation:* contract tests with synthetic producers.

## 9. Self-Improvement Loop

### 9.1 Mechanism

After each session (or batch), the **postmortem compiler** runs:

1. **Mine:** analyze transcripts + telemetry for friction: retries, corrections, escalations, budget overruns, drift, ambiguity found late.
2. **Compile lessons:** structured findings ("rule R was overridden by the human 4/5 times in context C", "routing sent T0 renames to a frontier model").
3. **Propose:** candidate pack diffs (edit a rule, adjust a routing weight structure, add a benchmark task capturing a novel failure, tweak a stage prompt), each linked to its evidence.
4. **Gate:** eval harness — benchmarks (EVAL-1/2) then counterfactual replay (EVAL-5).
5. **Apply:** auto-apply passing diffs; changelog entry with evidence, eval results, lockfile before/after.
6. **Monitor:** live telemetry watches post-apply metrics; regression triggers auto-revert.

- **LOOP-1.** When the postmortem compiler proposes a diff, the proposal shall include machine-checkable links to the telemetry evidence that motivated it.
  *Obligation:* schema validation — proposals without resolvable evidence links are rejected pre-gate.
- **LOOP-2.** The harness shall apply a loop-originated diff only after it passes the eval gate per EVAL-2 and EVAL-5 (EVAL-5's replay requirement per its own auto-apply scope), **or** on a recorded human approval that names the gate basis it overrides — the approval transition must carry either an auto-approvable gate basis or a human actor with an explicit override reason; a loop-actor approval without a passing basis is structurally rejected. The harness shall record a changelog entry sufficient to revert it in one command. Revert produces a **new child lockfile** removing exactly the reverted proposal's diff while preserving diffs applied after it; the result equals the pre-apply lockfile hash only when no later diff intervened.
  *Obligation:* end-to-end tests — single-diff apply/revert restores the exact prior lockfile hash; interleaved test (apply A, apply B, revert A) leaves B active and produces a new hash, not B's parent.
- **LOOP-3.** While a recently applied diff is within its monitoring window (default 14 days or 30 sessions, whichever is later), if live FPAR or TPAC regresses beyond the configured threshold (default: FPAR down ≥ 5 percentage points, or TPAC up ≥ 10%, at p < 0.05, unpaired bootstrap on session-level metrics comparing sessions whose pinned lockfile contains the diff against the pre-apply baseline window), then the harness shall auto-revert and quarantine. When multiple monitored diffs are statistically indistinguishable as the cause, revert in reverse apply order, one at a time, re-measuring over a fresh session window between reverts — never all at once.
  *Obligation:* simulation tests — injected post-apply regression triggers revert within the window; with two monitored diffs and one injected culprit, only the culprit ends quarantined; quarantined diffs cannot be re-proposed without human release.
- **LOOP-7.** Sessions shall pin their lockfile hash at session start; applied diffs shall take effect only for sessions started after the apply, so that concurrent sessions remain attributable to exactly one configuration.
  *Obligation:* concurrency test — two overlapping sessions spanning an apply record different pinned hashes, and every telemetry event joins to exactly one lockfile.

### 9.2 State Machine (formally specified — this component is T2 by its own rules)

States per proposal: `proposed → gated → {rejected, approved} → applied → monitoring → {stable, reverted → quarantined}`, with one human-only exit: `quarantined → proposed` (release, LOOP-9 — the released proposal must re-pass the full gate). The loop's state machine is specified in TLA+ and model-checked with at least these invariants:

- **I1 (gate soundness):** no proposal reaches `applied` without passing through `approved`.
- **I2 (bounded concurrency):** at most K proposals (default 3) in `monitoring` simultaneously, so regressions are attributable.
- **I3 (revert liveness):** from any `monitoring` state with a regression signal, `reverted` is reachable without human action.
- **I4 (no self-target):** no proposal's diff target is the kernel, the eval suites, or the loop's own specification (see §9.3).
- **I5 (monotone audit):** the changelog is append-only; revert adds an entry, never removes one.

- **LOOP-5.** The implementation shall include conformance checks linking the TLA+ model's actions to the implementation's state transitions.
  *Obligation:* model-based test — generated action sequences from the model executed against the implementation reach the same states.

### 9.2.1 Evidence links and monitoring semantics (pins the LOOP-1/LOOP-3 divergence splits)

**Evidence links (LOOP-1 made concrete).** A link is a string in exactly two grammars: `ev:db/<table>/<ulid>` where `<table>` is the closed enum of telemetry event tables and `<ulid>` is a 26-char Crockford ULID, or `ev:file/<allowlisted-path>#<record-id>` where the path allowlist is `{.kelson/findings.json}` plus ledger files and the record id matches that file's id pattern. Resolvability (`SELECT 1` against exactly the stated table, parameterized; exact id match within the stated file) is checked at proposal **creation** and re-checked **pre-gate**; a proposal whose creation-time links resolve can still be rejected pre-gate if the files changed. Resolution is all-or-nothing across the links; rejection never mutates the proposal document — it is a state transition on the proposal row plus an appended event carrying per-link results. An empty evidence array is a schema error, distinct from unresolvable.

- **LOOP-8.** Evidence links shall follow the two grammars above, resolve against exactly the stated table or file (no cross-table fallback — a link that misstates its location is a wrong claim), be checked at creation and pre-gate, and reject all-or-nothing via a recorded state transition, never document mutation.
  *Obligation:* unit matrix — valid db link, absent ULID, wrong-table ULID, valid findings id, absent findings id, empty array (schema error), 3-valid+1-dangling (atomic rejection with per-link results recorded).

**Monitoring semantics (LOOP-3 made concrete).** Baseline = the last 30 completed sessions started before apply whose pinned lockfile neither contains the diff nor any then-quarantined diff, frozen (by session id) into the monitor at apply; fewer than 30 → all; fewer than 8 → the monitor opens `baseline_insufficient` and can never auto-revert. Checks run at every post-apply session completion once both sides have ≥ 8 sessions; the window closes only when **both** arms are met (`days >= 14 AND post_sessions >= 30` — "whichever is later" is a conjunction), the bound-meeting session included. Test: unpaired **pooled-null** bootstrap (resample two groups of the original sizes from the pooled data), B = 10,000, seed derived from (diff id, check sequence) so every check replays; trigger requires the point estimate beyond the threshold AND p < 0.05, one-sided per metric. A regression may fire the moment both minimums are met — the window never delays a revert. A diff with no qualifying sessions emits one `stalled` event at day 14 and stays monitored indefinitely (absence of sessions is not a regression). **Attribution with multiple monitored diffs (A then B):** isolation examines the **two most recently applied** triggered suspects per sweep — with one revert per sweep, older simultaneous suspects resolve iteratively on subsequent sweeps — and isolates **on the metric family that triggered** (an FPAR-triggered regression isolates on FPAR, a TPAC-triggered one on TPAC). Compute the inter-apply stratum (sessions containing A but not B); if that stratum has ≥ 8 sessions, run two isolation tests — B's (A∧B sessions vs the A∧¬B stratum) and A's (the A∧¬B stratum vs A's frozen baseline); exactly one implicated → revert exactly that diff. Both, neither, or stratum < 8 → **indistinguishable** → revert the last-applied only, quarantine it, and open a fresh re-measure window for the survivor (fresh post-revert sessions vs its original frozen baseline, arming at 8) — one revert per fresh window, never two at once. Quarantine blocks re-apply and re-proposal by id **and content hash**; the only exit is explicit human release back to `proposed`, which must re-pass the full gate — release never restores `applied`.

- **LOOP-9.** The monitor shall implement the semantics above exactly: frozen quarantine-filtered baselines, min-8 both sides, conjunctive window closure, pooled-null seeded bootstrap with point-estimate AND significance triggers, the inter-apply-stratum attribution algorithm, single-revert-per-window, and content-hash quarantine blocking with human-only release to proposed.
  *Obligation:* simulation matrix (extends LOOP-3's) — day-3 revert at exactly 8 sessions; window open at day 14 with 20 sessions and closing inclusively on session 30; A/B injected-culprit isolation reverts exactly the culprit; stratum-starved case reverts last-applied only and re-measures; zero-session diff stalls without revert; quarantined content-hash re-proposal is rejected; two proposals applied within the same wall-clock instant attribute by apply order (`rowid`), not `applied_at`, so the A-before-B designation and the single-revert target are deterministic under a timestamp tie.

### 9.3 Safety Invariants (Goodhart Protection)

The evaluator must never grade its own homework, and the loop must never widen its own authority:

- **LOOP-4.** The self-improvement loop shall have no write path to: kernel code/config, eval suite packs, the loop's own state-machine specification, or the safety thresholds in EVAL-2/LOOP-3. Changes to any of these require human approval through the normal (non-loop) contribution path.
  *Obligation:* permission tests at the kernel boundary (shared with EVAL-6) — loop-originated diffs targeting each protected surface are rejected and audited; enforced by the artifact store's write ACL, not by prompt instructions.

The loop *may* propose **new benchmark tasks** (capturing observed failures) — additions only, into a staging suite that gates nothing until a human promotes it. This grows eval coverage without letting the loop weaken the gate.

- **LOOP-6.** Loop-proposed benchmark tasks shall enter a non-gating staging suite and shall join a gating suite only via human promotion.
  *Obligation:* integration test — a staged task never appears in a gate computation pre-promotion.

## 10. The Eval Tool (Operator-Facing)

The kernel's eval harness (§6.2) exposed as a first-class CLI — the answer to "is X worth it?":

```
kelson eval ablate <pack>[@version] --suite <suite> [--paired] [--n <min>]
kelson eval compare <lockfileA> <lockfileB> --suite <suite>
kelson eval replay --sessions <selector> --config <lockfile>
kelson eval report [--since <date>]     # live-telemetry trends by pack/config
kelson eval suite add|quarantine|promote ...
```

- **EVT-1.** `ablate` shall produce a verdict (helps / hurts / underpowered / no-effect) with effect sizes and confidence intervals for FPAR and TPAC, never a bare pass/fail.
  *Obligation:* output schema test + the EVAL-2 statistical unit tests.
- **EVT-2.** The eval tool shall evaluate any pack type uniformly — skills, MCP server enablement, agents, rules, routing tables — because each is togglable in a lockfile.
  *Obligation:* matrix test — one fixture of each pack type runs through `ablate` successfully.
- **EVT-3.** The eval tool shall maintain a public (in-repo) results ledger for the default suites, so the community can see which packs have evidence.
  *Obligation:* ledger schema validation; CI check that merged packs have a ledger entry.

Benchmark suite content for v1: (a) a seed suite of ~30 curated tasks spanning the pipeline stages, greenfield-weighted per §7.5; (b) regression canaries (S3, §3); (c) the operator's own promoted tasks from LOOP-6. Suite growth is itself part of the improvement loop.

## 11. Routing (Product-Level Behavior)

§6.3 gave kernel requirements; this section fixes product behavior:

- **Default policy shipped with v1** (a pack, human-tuned initially): frontier model + high effort for ideation/planning/spec and any T1+ build step; mid-tier for T0 build; small model for mechanical steps (renames, formatting, lockfile edits, changelog writing); verify runs at mid-tier with escalation on failure per RTR-2.
- **Custom agent onboarding:** `kelson agents register <manifest>` — manifest declares capabilities (domains, languages, task types), cost class, and constraints. Registered agents immediately become routing candidates for matching feature vectors (RTR-4) and appear in ablation (EVT-2), so their value is measurable from day one.
- **Learning cadence:** online bandit adjusts weights continuously within RTR-3/RTR-5 bounds; structural policy changes ship as loop proposals through the gate.
- **Transparency:** every routing decision is visible (`kelson route explain <task>`), showing the feature vector, chosen target, and the counterfactual cost of the next candidates — this is also the operator's lever for spotting misroutes to report as signals.

## 12. Token-Efficiency Mechanisms

All efficiency mechanisms are packs (evaluable via EVT-2 — efficiency claims get proven, not asserted).

### 12.1 Context Compiler

Builds a minimal task bundle instead of loading raw files: compressed repo map (symbol-level, headroom-style compression), the spec clauses the task touches, interface signatures of neighbors (not bodies), and the invariants in force. Bodies load on demand, recorded as bundle-miss events that feed compiler improvement.

- **CTX-1.** The context compiler shall produce, for any task, a bundle whose token count and content manifest are recorded in telemetry, including subsequent on-demand loads (bundle misses).
  *Obligation:* PBT — bundle token accounting matches actual context tokens within 2%.
- **CTX-2.** Bundle-miss rate per task type shall be a tracked metric; the improvement loop may propose compiler heuristic changes gated on: bundle-miss rate down without FPAR down.
  *Obligation:* covered by EVAL-2 applied to compiler packs.
- **CTX-5.** Bundle accounting shall use one version-pinned local tokenizer: the recorded count is the whole-text tokenization of exactly the assembled bundle content (plus per-miss counts as their own events), the manifest carries independently verifiable per-section counts, and session-reported token usage never participates; every bundle event records the tokenizer identity; a task with no bundleable content produces an empty bundle recording zero tokens with an empty manifest, never a synthetic preamble. (Pins the CTX-1 divergence split — empty-bundle value, tokenizer identity — and the implementation finding that per-section sums cannot hold 2% on small bundles: one BPE seam merge exceeds the whole tolerance, so the recorded number is the exact whole-text count and per-section sums are the manifest's verification route.)
  *Obligation:* unit tests — bundle events carry the tokenizer id; an empty compile records exactly zero with `manifest: []`; the CTX-1 PBT runs entirely offline with the pinned tokenizer on both sides.

### 12.2 Verbosity & Behavior Rules

Ponytail-class rules — terse output, act-don't-narrate, no speculative abstraction — ship as default efficiency packs, each with a ledger entry (EVT-3) demonstrating effect.

### 12.3 Comment & Code-Noise Suppression

- **CTX-3.** The build stage shall enforce (via rules + a lint pass) that generated code contains no comments beyond: constraint comments the spec requires, and annotations the repo's own conventions require. Traceability uses spec-clause metadata, not code comments.
  *Obligation:* lint fixture — generated outputs for the benchmark suite are comment-audited; violations fail verify.

### 12.4 Per-Step Budgets

- **CTX-4.** The router shall attach a token budget to every routed step (from policy, by task features); when a step exceeds budget, the harness shall record an overrun event and, at 2× budget, pause for triage (continue / escalate / re-spec) rather than burning on.
  *Obligation:* integration test — a runaway fixture step pauses at 2× with a triage prompt; the overrun event carries attribution.

## 13. Open-Source Product Requirements

- **OSS-1 Packaging.** One-command install (`npx kelson init` or equivalent) that: installs the CC plugin, the eval runner CLI, and the local telemetry store; detects existing Claude Code config and layers non-destructively.
  *Obligation:* clean-machine CI install test on macOS + Linux.
- **OSS-2 Privacy.** Telemetry local-first (TEL-2/3); the privacy policy is a repo document; shared-telemetry schema is published and versioned; no shared field may contain free text.
  *Obligation:* schema-level enforcement test (superset of TEL-3).
- **OSS-3 Versioning.** Kernel and packs semver independently; lockfile pins everything; kernel upgrades never auto-apply (human-governed, §9.3 consistency).
  *Obligation:* upgrade-path test — a project pinned to old packs runs unchanged after a kernel minor upgrade.
- **OSS-4 Contribution model.** Community packs merge only with: manifest + declared eval evidence (an `ablate` run on the public seed suite, reproducible via EVAL-4) + ledger entry. The eval gate replaces maintainer taste as the bar — this is the project's distinctive OSS mechanic and is documented prominently.
  *Obligation:* CI contribution-gate test — a PR adding a pack without reproducible eval evidence fails CI.
- **OSS-5 Docs.** Quickstart (greenfield UC1 in < 30 minutes), brownfield adoption guide (UC4), pack-author guide (P3), and the safety/self-improvement model (§9) documented for operators (P4).
  *Obligation:* docs CI — quickstart executed end-to-end in CI against each release.
- **OSS-6 Schema versioning.** Telemetry storage and artifact metadata schemas shall be versioned with forward migrations; every stored event carries its schema version, and eval comparisons across schema versions either migrate or refuse (never silently coerce).
  *Obligation:* migration test — a store created at schema v1 is readable after upgrade; a cross-version eval comparison without a migration path is rejected with a diagnostic.

## 14. Security & Isolation

Three attack surfaces the rest of the PRD creates and must therefore close: **execution** (benchmarks, divergence tests, and replays run arbitrary code — including snapshots of the operator's real repos), **packs** (packs are prompts, so a community pack is a prompt-injection vector; the eval gate measures helpfulness, not malice), and **local surfaces** (the read-only web UI serves files from the operator's machine, §14.3).

### 14.1 Execution Isolation

- **SEC-1.** The eval runner shall execute benchmark tasks, divergence-test implementations, and counterfactual replays only inside isolated workspaces. The full no-access guarantee (live repositories, credentials, session state) is enforced by the `container` profile, which is mandatory for anything not authored by the operator; the `worktree` profile (operator-authored work only) guarantees temp-HOME and workspace-cwd isolation for task checks and `command` sessions, uses detached clones (not shared-object worktrees, which share refs/objects with the live repo), and is a convenience tier, not a security boundary. One stated exception: under `worktree`, the `claude` executor's session process alone receives the operator's `HOME`/`USER` and auth tokens — it runs the operator's own agent, whose credentials are keyed to the operator account (EVP §2.1); no other part of the workspace environment inherits them, and the `container` profile never does.
  *Obligation:* escape test under the `container` profile — a fixture task that attempts to read outside its workspace, read credential paths, or write to a live repo fails with an audited violation event; a `worktree`-profile test verifies temp-HOME isolation, that ref writes cannot reach the source repo, and that the claude-executor passthrough is limited to exactly the auth set (HOME, USER, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN). (Dedicated violation *audit events* land with the Phase 4 telemetry expansion; Phase 2 records failures in `eval_task_result.check_results` — F-048.)
- **SEC-2.** While executing community-authored suites or packs under evaluation, the sandbox shall deny network access except an allowlist required by the task definition.
  *Obligation:* network test — a fixture task's non-allowlisted egress attempt is blocked and audited (audit-event half deferred with SEC-1's, F-048).
- **SEC-3.** Every eval run shall record its sandbox profile (isolation level, network policy) in the run manifest (extends EVAL-4).
  *Obligation:* manifest schema validation.

### 14.2 Pack Supply Chain

- **SEC-4.** Every pack shall declare its capabilities — which surfaces it may influence (stages, rules, routing, context assembly) — and the harness shall refuse to load a pack whose content addresses surfaces beyond its declaration.
  *Obligation:* fixture packs exceeding their declarations are refused at load with a diagnostic naming the excess surface.
- **SEC-5.** Community pack contributions shall pass static scanning for injection patterns (instructions targeting other packs, the gate, telemetry, or exfiltration) before entering eval, and pack releases shall be signed; the harness shall verify signatures at install.
  *Obligation:* scanner golden set (known-injection corpus ≥ 95% caught, clean corpus false-positive rate ≤ 5%); unsigned or tampered pack install is refused.
- **SEC-6.** No pack shall have write access to other packs, the lockfile, or kernel configuration; all pack changes flow through the proposal path (§9) or human edits.
  *Obligation:* permission test — a pack whose content directs writes to another pack produces no such write in a full pipeline run; the attempt is audited.

### 14.3 Local Surface Hardening

- **SEC-7.** When the local web UI (`kelson ui`) serves a static asset, the server shall resolve both the requested path and the static root via realpath and serve the file only when the resolved path sits inside the resolved root by segment boundary (`path.relative` yields no `..` component and no absolute path) — never a string-prefix comparison; a request resolving outside the root (dot-dot traversal, a sibling directory sharing the root's name as a prefix such as `dist2`, or a symlink inside the root pointing out) shall return 404 without reading the target file.
  *Obligation:* integration against a running UI server — encoded-slash traversal forms (`..%2f`, `%2e%2e%2f` — the only traversal spellings that reach the handler; the runtime clamps a raw literal `/../` to an in-root path before the fetch handler runs, so it never resolves outside and falls to the SPA fallback, asserted by content-absence over a raw socket), a request that a prefix comparison would match into a sibling `dist2` directory, and a symlink placed inside the asset root targeting an outside file each return 404 with the target's content absent from the response body; a legitimate asset still serves 200.

## 15. Failure Modes & Mitigations

| Failure mode | Risk | Mitigation |
|---|---|---|
| **Underpowered evals** — gate approves noise | Bad changes accumulate | EVAL-2 hard minimum sample sizes; underpowered = rejected, never "probably fine"; S3 canary measures detection power continuously |
| **Goodharting the gate** — loop optimizes metrics, not outcomes | Metric-good, work-bad | LOOP-4 write-ACL (loop cannot touch suites/thresholds); LOOP-6 staged suite growth; correction-rate (post-acceptance human edits) tracked as a gate metric so "accepted fast but wrong" is visible |
| **Runaway improvement loop** — cascading self-changes | Unattributable behavior | I2 bounded concurrent monitoring (≤ 3); model-checked state machine; kernel/loop-spec immutable to the loop |
| **Revert storms** — reverts triggering re-proposals triggering reverts | Thrash | Quarantine on revert (LOOP-3): reverted diffs need human release; I5 append-only audit for diagnosis |
| **Routing misfires** — cheap model on a hard task | Failed steps, wasted retries | RTR-2 escalation ladder (bounded: one failure = escalate); RTR-3 no exploration on T2+; regret tracked and mined |
| **Benchmark overfitting** — packs tuned to the suite | Suite-good, real-work-bad | EVAL-5 mandatory counterfactual replay on real sessions; suite grows from real failures (LOOP-6) |
| **Telemetry loss/corruption** | Blind improvement decisions | TEL-5 incomplete-session exclusion; gates fail closed on missing data (rejection, not assumption) |
| **Spec-compiler false confidence** — vague clause compiles to a weak obligation | Ambiguity leaks through | SPEC-4 divergence testing as the second, independent net; ambiguity-catch-rate metric (§3) monitors the leak rate |
| **Drift-flag fatigue** — brownfield floods of stale flags | Operators ignore drift | SPEC-7 inferred clauses alert-only; batched promotion (SPEC-8); flag volume is a tracked metric the loop may tune |
| **Kernel bug in the gate itself** | Everything downstream unsound | Kernel is T2 on its own ladder: state machine model-checked, gate statistics unit-tested against known distributions, EVAL-4 reproducibility for post-hoc audit |
| **Malicious or injected pack** — passes ablation while exfiltrating or weakening behavior | Compromised harness | SEC-4 capability declarations enforced at load; SEC-5 static scan + signing; SEC-6 no cross-pack writes; SEC-1/2 sandboxed evaluation with network deny |
| **Eval sandbox escape** — benchmark/replay code reaches live repos or credentials | Data loss, credential theft | SEC-1 workspace isolation with escape tests in CI; SEC-3 auditable sandbox profiles per run |
| **Local UI path escape** — static asset route serves files outside the built assets | Local file disclosure | SEC-7 realpath + segment-boundary containment on every static asset request |

## 16. Phased Delivery & Open Questions

Walking skeleton first — the full loop, thin — then deepen. Each phase is release-able.

- **Phase 0 — Rails.** Kernel scaffolding: telemetry capture (TEL-1/2/5), artifact store with hashing (ART-1/2), lockfile + pack format, CC plugin shell. *Exit: a session produces telemetry and traceable artifacts.*
- **Phase 1 — Specs that bite.** Spec DSL + compiler (SPEC-1/2/3), obligation execution in verify (PIPE-8), drift detection (ART-3/4). *Exit: a vague spec is rejected; a violated invariant blocks verify.*
- **Phase 2 — Eval tool.** Eval runner CLI with sandboxed execution (SEC-1..3), seed benchmark suite, ablation + statistical gating (EVAL-1..4, EVT-1..3). *Exit: `kelson eval ablate ponytail` returns a defensible verdict from an isolated run.*
- **Phase 3 — Routing.** Registry, default policy, escalation, budgets (RTR-1..4, CTX-4), context compiler v1 (CTX-1). *Exit: measured TPAC drop on the suite vs. Phase 2.*
- **Phase 4 — The loop.** Postmortem compiler, TLA+ model + conformance (LOOP-1..9), counterfactual replay (EVAL-5), monitoring/revert. *Exit: S4 — one self-proposed change passes the gate and sticks.*
- **Phase 5 — Open source.** Packaging, docs, privacy, contribution gate (OSS-1..6), pack supply-chain security (SEC-4..6), OTel exporter (TEL-6), divergence testing GA (SPEC-4/5), spec excavation (SPEC-7/8), bandit routing (RTR-5) — ordered within the phase by eval evidence.

**Resolved questions** (decisions recorded, 2026-07-02)

1. **Product name → Kelson.** npm `kelson` and GitHub availability verified; no tool collision. (Header of this document.)
2. **Spec DSL concrete syntax → resolved** by the [Kelspec DSL spec](./2026-07-02-kelspec-dsl.md): Markdown files with fenced `kelspec` YAML blocks — human-reviewable in PRs, machine-parseable, one grammar.
3. **Replay fidelity → resolved** by the [Eval procedure spec](./2026-07-02-eval-procedure.md) §4: git-bundle snapshots + environment manifest, with explicit validity rules for when a replay may gate.
4. **Divergence-testing default scope → resolved:** T1+ (as SPEC-4 already defaults); broadening is a routing-policy parameter only the eval loop can earn, through the normal gate.
5. **Tooling → resolved** by [ADR-0003](../adr/0003-runtime-and-tooling.md): Bun runtime, OpenTUI, Biome, `bun test` + fast-check.

**Remaining deferred item** (not ambiguity — a decision with a defined trigger)

- **Shared-telemetry aggregation** — an opt-in community dashboard (cross-user pack ledgers). Revisit at Phase 5; trigger: ≥ 3 external pack contributors asking for cross-org evidence.

## 17. Traceability of This Document

This PRD's behavioral sections follow the format they mandate: EARS clauses with obligations (§6–§14). When the spec compiler exists (Phase 1), this document becomes its first excavation target: clauses TEL-* through SEC-* compile into the harness's own conformance suite, and this PRD enters the artifact store as the root of Kelson's own traceability DAG.
