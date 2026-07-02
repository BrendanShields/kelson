# UX & User Journeys: Kelson

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Upstream:** [PRD](./2026-07-02-agent-harness-prd.md) (personas §4, requirements referenced by ID), [ERD](./2026-07-02-agent-harness-erd.md)
- **Decisions bound here:** terminal + git as the v1 review surface with a legible TUI (local web UI is a post-v1 surface, §8); explicit pipeline stages with ambient enforcement.

## 1. UX Principles

- **UX-P1 — Never block, never surprise.** Harness failure degrades to vanilla Claude Code (KERN-1) with one quiet marker, not an error wall. Ambient mechanisms (telemetry, routing, rules, budgets) surface only when they change something the user would notice.
- **UX-P2 — Explicit stages, ambient enforcement.** The user always knows which SDLC stage they're in because they invoked it. They never manage telemetry, routing, or budgets manually.
- **UX-P3 — Evidence at the point of decision.** Every prompt that asks a human anything shows the evidence and the default: a gate rejection shows the failing metric with CI; a budget pause shows spend vs. budget and the cheapest viable option first.
- **UX-P4 — Legible, not just printed.** CLI output is structured — panels, tables, aligned diffs, sparklines, semantic color — never raw text walls. Every view has `--json` for scripts and a `NO_COLOR`/plain fallback for accessibility and CI.
- **UX-P5 — Every state comes with its verb.** Any status a user can see names the one command that acts on it (`3 proposals awaiting review → kelson loop review`).
- **UX-P6 — Files are the UI of record.** Everything reviewable is a git-tracked file; the TUI renders and navigates, it never owns state. PR review is a first-class review path.

## 2. Surfaces

| Surface | Role | Notes |
|---|---|---|
| **Claude Code session** | Where work happens: `/kelson:*` commands, stage flow, hook-injected context | Injected context is minimal (UX-P1); a statusline segment shows `stage · model@effort · budget` |
| **`kelson` CLI/TUI** | Where the harness is operated: evals, loop review, routing, drift, signals | OpenTUI component rendering per §7 (ADR-0003); every command scriptable via `--json` |
| **Repo files** | Review of record: specs, changelog, ledger, packs | PRs review them like any code |
| **OTel → external dashboards** | Metrics over time | Per ADR-0001, Kelson builds no dashboards in v1 |
| **Local web UI** | Post-v1 (§8) | Richer proposal/ledger browsing when TUI hits its ceiling |

## 3. Command Surface

**In-session (explicit stages):**

- `/kelson:feature <idea>` — runs the full pipeline: ideation interview → PRD section → spec → build → verify. The spine of UC1.
- `/kelson:spec`, `/kelson:build`, `/kelson:verify` — enter a single stage explicitly (resume, partial work).
- `/kelson:status` — current task, stage, budget state, pinned lockfile.
- `/kelson:accept` — explicit acceptance (TEL-7 signal).

**CLI:**

- `kelson init` — install/onboard (J0).
- `kelson pack lint|new` — pack authoring: version-bump lint (PACK-3) and scaffolding (J5).
- `kelson eval ablate|compare|replay|report|suite|publish` — the eval tool (PRD §10); `publish` writes the ledger entry for a completed run (EVT-3/EVP-6).
- `kelson loop propose|status|review|gate|approve|reject|apply|release|revert` — improvement-loop operations (J4).
- `kelson route explain <task>` — routing transparency (PRD §11).
- `kelson agents register <manifest>` — custom agent onboarding.
- `kelson drift list|promote` — drift review and batched clause promotion (SPEC-8).
- `kelson signals inbox|triage` — feedback-stage inbox (PIPE-1).
- `kelson index rebuild` — regenerate the SQLite index from files (ERD §1).

## 4. User Journeys

Format: trigger → numbered touchpoints (**what the user does / sees**) → success criterion → edge paths. Personas and UCs from PRD §4.

### J0 — Onboarding (any persona; OSS-5: < 30 minutes to first value)

1. `npx kelson init` → detects Claude Code, existing config, repo type (greenfield/brownfield); shows a plan panel of what it will install (plugin, CLI, local store) and **changes nothing until confirmed (TUI journey; the plain CLI form `kelson init` is non-interactive: it prints each action as it is taken, is idempotent, and never overwrites existing config — the non-destructive guarantee is the same, the confirmation panel is TUI-only)**.
2. Confirmation → installs, runs a 60-second self-check (telemetry round-trip, sandbox availability), prints a "first steps" panel: greenfield → *run `/kelson:feature`*; brownfield → *run excavation (J2)*.
3. First session shows the statusline segment — the only visible change to normal Claude Code use.

**Success:** first `/kelson:feature` or excavation started within 30 minutes. **Edge:** no container runtime → operator-authored suites/replays still run under the `worktree` profile with a warning badge; anything requiring the `container` profile (community suites/packs) **refuses** with a diagnostic per EVP-2 — the security boundary never degrades.

### J1 — Greenfield feature (P1, UC1)

1. `/kelson:feature "rate-limit the public API"` → ideation interview: one question at a time (PIPE-2), each with evidence of why it's unresolved.
2. PRD section drafted → user reviews as a diff in-session; EARS clauses lint live (PIPE-3 compile rate shown as `18/19 clauses compile`, the failing one highlighted with its diagnostic).
3. Spec compiles to obligations (SPEC-1); tier auto-assigned with the reason shown (`T1: two state variables, two event sources`). If tier ≥ T1, divergence testing runs — progress shown as a background job, not a spinner the user must watch.
4. Build: statusline shows routed model/effort per step; edit batches run obligations continuously (PIPE-7) — failures appear as compact inline panels naming the violated clause.
5. Verify: structured report (PIPE-8) → `/kelson:accept` (immediate, terminal) or merge (rides the correction window) — TEL-7 and PRD §3.

**Success:** accepted first pass; the session never asked the user to manage routing, budgets, or telemetry. **Edges:** divergence found → the two probe behaviors rendered side-by-side, spec goes back with mandatory clauses attached (SPEC-5); budget pause → §5.1.

### J2 — Brownfield adoption (P2, UC4)

1. `kelson init` in an existing repo → offers excavation with an honest cost/time estimate before starting.
2. Excavation emits inferred clauses (SPEC-7) → summary table by module: clause counts, confidence, evidence links. Nothing blocks anything yet (alert-only) — stated explicitly so expectations are set.
3. Over subsequent sessions, drift alerts arrive **batched** per session end (never mid-flow, §5.4); `kelson drift list` shows a survival table of inferred clauses.
4. `kelson drift promote` — one screen, sorted by survival (SPEC-8), space-to-select, enter-to-promote. Promoted clauses now block per ART-4.

**Success:** first confirmed clause within the first week; drift alerts read as signal, not noise. **Edge:** flag flood → the batch view collapses by module and the loop may propose threshold tuning (visible as a proposal in J4, never a silent change).

### J3 — "Is pack X worth it?" (any persona, UC2)

1. `kelson eval ablate ponytail --suite seed` → cost/time estimate + sandbox profile shown before running (SEC-3); runs headless.
2. Verdict panel (EVT-1): decision (`helps / hurts / no-effect / underpowered`) rendered with effect sizes and CIs as aligned bars, per-metric — never a bare pass/fail. `underpowered` says exactly how many more task-runs are needed (UX-P5).
3. Verdict links its run manifest (EVAL-4) for reproduction and its ledger entry.

**Success:** the user can defend "keep it / drop it" with the panel alone. **Edge:** quarantined flaky tasks are listed with their exclusion reason, so the n in the stats is never mysterious.

### J4 — Improvement-loop review ritual (P4, UC3)

1. Ambient: postmortems mine sessions; proposals gate in the background under the EVAL-7 budget cap. Nothing interrupts work.
2. Weekly (or on `kelson loop status`): summary panel — applied N (monitoring), awaiting review M, quarantined K, overhead ratio vs. cap sparkline.
3. `kelson loop review` — one proposal per screen: the diff, the evidence links that motivated it (LOOP-1), its gate verdict with CIs, and monitoring status. Verbs: approve / reject / defer.
4. Auto-applied diffs appear in the changelog file (PR-reviewable); auto-reverts (LOOP-3) notify at next session start with the regression evidence and the one-command re-release path (`kelson loop release <id>`).

**Success:** the operator trusts the changelog enough to stop reading every entry — spot-checks only. **Edge:** revert storm → quarantine view groups related proposals and shows the shared evidence they were built on.

### J5 — Pack contributor (P3)

1. `kelson pack new` → scaffold with manifest: capability declarations (SEC-4) are required fields with inline docs, not an afterthought.
2. Local iteration: `kelson eval ablate ./my-pack --suite seed` — same verdict panel as J3; the contributor sees exactly what reviewers will see.
3. Submission: PR carrying the pack + reproducible run manifest. CI re-runs the ablation (OSS-4), static-scans (SEC-5), and posts the verdict panel as a PR comment.
4. Merge → signed release → ledger entry (EVT-3).

**Success:** a contributor who has never spoken to a maintainer can predict whether their pack will merge. **Edge:** scan hit → the PR comment names the flagged pattern and the declaration surface it exceeds; no human gatekeeping mystery.

### J6 — Routed build with escalation (UC5)

1. During any build, the statusline shows the routed target per step. Curious user: `kelson route explain <task>` → feature vector, chosen target, and the next candidates with estimated cost deltas (PRD §11).
2. A step fails verification at a cheap tier → RTR-2 escalation happens silently (ambient); it is visible afterward in `route explain` as `escalated: haiku → sonnet (regret recorded)`.
3. Fine-tuned agent registered via `kelson agents register` → immediately visible as a candidate in `route explain`, measurable via J3 from day one.

**Success:** the user never picks a model manually, but can always answer "why this model?" after the fact.

## 5. Key Moments (interaction-level spec)

### 5.1 Budget pause (CTX-4)

At 2× budget the step pauses with a compact triage panel: spent vs. budget, what the step was doing, and three verbs with the cheapest viable default first — `continue (+est. cost)` / `escalate to <next tier> (+est.)` / `re-spec (recommended when obligations keep failing — shown with the failure count)`. One keystroke resumes. The panel is the *only* time ambient budgeting interrupts anyone (UX-P1).

### 5.2 Divergence found (SPEC-4/5)

Side-by-side render of the two implementations' behavior on the divergent probe input — values, not diffs of code. Below: the drafted clauses that would resolve the ambiguity, pre-attached to the spec going back to planning. The message never says "ambiguity detected" without showing the concrete input that proves it.

### 5.3 Gate rejection & auto-revert (EVAL-2, LOOP-3)

Rejections show which metric failed, by how much, with CI — and whether more samples could change the verdict (`underpowered` vs. `hurts`). Auto-revert notices lead with the regression evidence and end with the re-release verb (UX-P5). Neither ever appears mid-task; they land at session boundaries.

### 5.4 Drift alerts (ART-2/3, SPEC-7)

Never mid-flow. Batched to session end and `kelson drift list`; grouped by module; inferred-clause violations visually distinct (informational) from confirmed-clause violations (blocking). The fatigue budget is explicit: if a session would show > 10 drift items, the view auto-collapses to module counts.

### 5.5 Degraded mode (KERN-1)

A single statusline badge (`degraded: telemetry`) and one line at session start. No repeated warnings. `kelson doctor` names the failing component and its fix.

## 6. UX Requirements (EARS + obligations, PRD format)

- **UX-1.** Every `kelson` CLI command shall support `--json` emitting schema-validated output equivalent to its rendered view.
  *Obligation:* CI matrix — every registered command runs with `--json`; output validates against its Zod schema.
- **UX-2.** Every interactive prompt shall display the evidence for the decision, a recommended default, and shall be dismissible with a single keystroke selecting the default.
  *Obligation:* prompt-component unit tests + a lint rule that no prompt renders without `evidence` and `default` props.
- **UX-3.** While a session is healthy, ambient mechanisms shall render at most the statusline segment; when degraded or paused, exactly one panel explains why and names the verb (UX-P5).
  *Obligation:* golden-session snapshot tests — healthy benchmark sessions produce zero harness-originated panels; each degraded/paused fixture produces exactly one.
- **UX-4.** All TUI views shall render correctly at 80 columns, honor `NO_COLOR`, and degrade to plain sequential text when not a TTY.
  *Obligation:* snapshot tests at 80/120 columns, with `NO_COLOR`, and piped (non-TTY).
- **UX-5.** When any status view reports an actionable state, it shall name the single command that acts on it.
  *Obligation:* registry test — every actionable state enum member maps to a command string; status renderers fail closed if unmapped.
- **UX-6.** The onboarding flow (J0) shall complete on a clean machine, through first self-check, in under 10 minutes unattended, and shall change nothing before explicit confirmation.
  *Obligation:* the OSS-1 clean-machine CI test, extended with a timer assertion and a pre-confirmation filesystem-diff assertion (empty).

## 7. TUI Legibility Spec

- **Component set:** panel (titled box), key-value grid, table with aligned numerics, inline bar/sparkline for effect sizes and trends, side-by-side diff, select-list. Built once in `packages/cli` (OpenTUI `@opentui/core`, per ADR-0003), used everywhere; no ad-hoc `console.log` formatting outside the component layer.
- **Color semantics (fixed):** green = passing/helps, red = failing/hurts, yellow = attention/underpowered, cyan = identifiers, dim = metadata. Color is never the only signal (symbols accompany: `✓ ✗ ~ ?`) — UX-4.
- **Density rule:** a view answers its one question in the first 10 lines; detail is progressive (expand/`--full`), not default.
- **Numbers:** effect sizes always carry CIs; costs always carry units (`$0.42`, `31k tok`); never bare floats.

## 8. Post-v1 Surface: Local Web UI

Deferred, on record: when proposal volume or ledger exploration outgrows the TUI (signal: operators exporting `--json` to inspect elsewhere), `kelson ui` serves a local, read-mostly web app — changelog browsing, proposal diffs with linked evidence, ledger exploration. Same files/SQLite as source of truth; the TUI's `--json` schemas (UX-1) become its API for free. No auth surface in v1-scope thinking: localhost, read-mostly, actions still via CLI.
