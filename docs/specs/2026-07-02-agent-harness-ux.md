# UX & User Journeys: Obligato

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Upstream:** [PRD](./2026-07-02-agent-harness-prd.md) (personas §4, requirements referenced by ID), [ERD](./2026-07-02-agent-harness-erd.md)
- **Decisions bound here:** terminal + git as the v1 review surface with a legible TUI, plus a read-only local web UI (§8, promoted 2026-07-03); explicit pipeline stages with ambient enforcement.

## 1. UX Principles

- **UX-P1 — Never block, never surprise.** Harness failure degrades to vanilla Claude Code (KERN-1) with one quiet marker, not an error wall. Ambient mechanisms (telemetry, routing, rules, budgets) surface only when they change something the user would notice.
- **UX-P2 — Explicit stages, ambient enforcement.** The user always knows which SDLC stage they're in because they invoked it. They never manage telemetry, routing, or budgets manually.
- **UX-P3 — Evidence at the point of decision.** Every prompt that asks a human anything shows the evidence and the default: a gate rejection shows the failing metric with CI; a budget pause shows spend vs. budget and the cheapest viable option first.
- **UX-P4 — Legible, not just printed.** CLI output is structured — panels, tables, aligned diffs, sparklines, semantic color — never raw text walls. Every view has `--json` for scripts and a `NO_COLOR`/plain fallback for accessibility and CI.
- **UX-P5 — Every state comes with its verb.** Any status a user can see names the one command that acts on it (`3 proposals awaiting review → obligato loop review`).
- **UX-P6 — Files are the UI of record.** Everything reviewable is a git-tracked file; the TUI renders and navigates, it never owns state. PR review is a first-class review path.

## 2. Surfaces

| Surface | Role | Notes |
|---|---|---|
| **Claude Code session** | Where work happens: `/obligato:*` commands, stage flow, hook-injected context | Injected context is minimal (UX-P1); a statusline segment shows `stage · model@effort · budget` |
| **`obligato` CLI/TUI** | Where the harness is operated: evals, loop review, routing, drift, signals | OpenTUI component rendering per §7 (ADR-0003); every command scriptable via `--json` |
| **Repo files** | Review of record: specs, changelog, ledger, packs | PRs review them like any code |
| **OTel → external dashboards** | Metrics over time | Per ADR-0001, Obligato builds no dashboards in v1 |
| **Local web UI** | Read-only visual surface: telemetry, evals, loop board, traceability (§8) | `obligato ui`; localhost, GET-only (UX-10/11/12) |

## 3. Command Surface

**In-session (explicit stages):**

- `/obligato:feature <idea>` — runs the full pipeline: ideation interview → PRD section → spec → build → verify. The spine of UC1.
- `/obligato:spec`, `/obligato:build`, `/obligato:verify` — enter a single stage explicitly (resume, partial work).
- `/obligato:status` — current task, stage, budget state, pinned lockfile.
- `/obligato:accept` — explicit acceptance (TEL-7 signal).

**CLI:**

- `obligato init` — install/onboard (J0).
- `obligato pack lint|new` — pack authoring: version-bump lint (PACK-3) and scaffolding (J5).
- `obligato eval ablate|compare|replay|report|suite|publish` — the eval tool (PRD §10); `publish` writes the ledger entry for a completed run (EVT-3/EVP-6).
- `obligato loop propose|status|review|gate|approve|reject|apply|release|revert` — improvement-loop operations (J4).
- `obligato route explain <task>` — routing transparency (PRD §11).
- `obligato agents register <manifest>` — custom agent onboarding.
- `obligato drift list|promote` — drift review and batched clause promotion (SPEC-8).
- `obligato signals inbox|triage` — feedback-stage inbox (PIPE-1).
- `obligato index rebuild` — regenerate the SQLite index from files (ERD §1).
- `obligato ui` — serve the local read-only web UI (§8); `obligato` with no arguments — interactive launcher (UX-7).
- `obligato chat` — interactive native-runtime session, OpenTUI chat surface (UX-14); `/model` switches the session model (UX-17).
- `obligato run -p "<task>"` — headless native-runtime session, plain/`--json` output (UX-15); `--allow <tool[:argGlob]>` grants asks granularly, `--allow-asks` grants all (PERM-3, PERM-5).
- `obligato auth login <provider>` — credential + default-model setup for the native runtime (UX-16, PROV-4); `anthropic`, `ollama`, or any `openai-compatible` endpoint (PROV-11).
- `obligato bench --suite <dir>` — cross-agent head-to-head (EVP-11): native runtime vs Claude Code on the same tasks/seeds, statistically gated (UX-18).
- `obligato doctor` — self-check: names each failing component and its fix (UX-19, §5.5).
- `obligato divergence list|show <id>` — review recorded divergence reports after the fact (UX-20, §5.2).
- `obligato db stats|backup <dest>` — local store maintenance, read-only stats and `VACUUM INTO` backup (UX-27).

## 4. User Journeys

Format: trigger → numbered touchpoints (**what the user does / sees**) → success criterion → edge paths. Personas and UCs from PRD §4.

### J0 — Onboarding (any persona; OSS-5: < 30 minutes to first value)

1. `npx obligato init` → detects Claude Code, existing config, repo type (greenfield/brownfield); shows a plan panel of what it will install (plugin, CLI, local store) and **changes nothing until confirmed (TUI journey; the plain CLI form `obligato init` is non-interactive: it prints each action as it is taken, is idempotent, and never overwrites existing config — the non-destructive guarantee is the same, the confirmation panel is TUI-only)**.
2. Confirmation → installs, runs a 60-second self-check (telemetry round-trip, sandbox availability), prints a "first steps" panel: greenfield → *run `/obligato:feature`*; brownfield → *run excavation (J2)*.
3. First session shows the statusline segment — the only visible change to normal Claude Code use.

**Success:** first `/obligato:feature` or excavation started within 30 minutes. **Edge:** no container runtime → operator-authored suites/replays still run under the `worktree` profile with a warning badge; anything requiring the `container` profile (community suites/packs) **refuses** with a diagnostic per EVP-2 — the security boundary never degrades.

### J1 — Greenfield feature (P1, UC1)

1. `/obligato:feature "rate-limit the public API"` → ideation interview: one question at a time (PIPE-2), each with evidence of why it's unresolved.
2. PRD section drafted → user reviews as a diff in-session; EARS clauses lint live (PIPE-3 compile rate shown as `18/19 clauses compile`, the failing one highlighted with its diagnostic).
3. Spec compiles to obligations (SPEC-1); tier auto-assigned with the reason shown (`T1: two state variables, two event sources`). If tier ≥ T1, divergence testing runs — progress shown as a background job, not a spinner the user must watch.
4. Build: statusline shows routed model/effort per step; edit batches run obligations continuously (PIPE-7) — failures appear as compact inline panels naming the violated clause.
5. Verify: structured report (PIPE-8) → `/obligato:accept` (immediate, terminal) or merge (rides the correction window) — TEL-7 and PRD §3.

**Success:** accepted first pass; the session never asked the user to manage routing, budgets, or telemetry. **Edges:** divergence found → the two probe behaviors rendered side-by-side, spec goes back with mandatory clauses attached (SPEC-5); budget pause → §5.1.

### J2 — Brownfield adoption (P2, UC4)

1. `obligato init` in an existing repo → offers excavation with an honest cost/time estimate before starting.
2. Excavation emits inferred clauses (SPEC-7) → summary table by module: clause counts, confidence, evidence links. Nothing blocks anything yet (alert-only) — stated explicitly so expectations are set.
3. Over subsequent sessions, drift alerts arrive **batched** per session end (never mid-flow, §5.4); `obligato drift list` shows a survival table of inferred clauses.
4. `obligato drift promote` — one screen, sorted by survival (SPEC-8), space-to-select, enter-to-promote. Promoted clauses now block per ART-4.

**Success:** first confirmed clause within the first week; drift alerts read as signal, not noise. **Edge:** flag flood → the batch view collapses by module and the loop may propose threshold tuning (visible as a proposal in J4, never a silent change).

### J3 — "Is pack X worth it?" (any persona, UC2)

1. `obligato eval ablate ponytail --suite seed` → cost/time estimate + sandbox profile shown before running (SEC-3); runs headless.
2. Verdict panel (EVT-1): decision (`helps / hurts / no-effect / underpowered`) rendered with effect sizes and CIs as aligned bars, per-metric — never a bare pass/fail. `underpowered` says exactly how many more task-runs are needed (UX-P5).
3. Verdict links its run manifest (EVAL-4) for reproduction and its ledger entry.

**Success:** the user can defend "keep it / drop it" with the panel alone. **Edge:** quarantined flaky tasks are listed with their exclusion reason, so the n in the stats is never mysterious.

### J4 — Improvement-loop review ritual (P4, UC3)

1. Ambient: postmortems mine sessions; proposals gate in the background under the EVAL-7 budget cap. Nothing interrupts work.
2. Weekly (or on `obligato loop status`): summary panel — applied N (monitoring), awaiting review M, quarantined K, overhead ratio vs. cap sparkline.
3. `obligato loop review` — one proposal per screen: the diff, the evidence links that motivated it (LOOP-1), its gate verdict with CIs, and monitoring status. Verbs: approve / reject / defer.
4. Auto-applied diffs appear in the changelog file (PR-reviewable); auto-reverts (LOOP-3) notify at next session start with the regression evidence and the one-command re-release path (`obligato loop release <id>`).

**Success:** the operator trusts the changelog enough to stop reading every entry — spot-checks only. **Edge:** revert storm → quarantine view groups related proposals and shows the shared evidence they were built on.

### J5 — Pack contributor (P3)

1. `obligato pack new` → scaffold with manifest: capability declarations (SEC-4) are required fields with inline docs, not an afterthought.
2. Local iteration: `obligato eval ablate ./my-pack --suite seed` — same verdict panel as J3; the contributor sees exactly what reviewers will see.
3. Submission: PR carrying the pack + reproducible run manifest. CI re-runs the ablation (OSS-4), static-scans (SEC-5), and posts the verdict panel as a PR comment.
4. Merge → signed release → ledger entry (EVT-3).

**Success:** a contributor who has never spoken to a maintainer can predict whether their pack will merge. **Edge:** scan hit → the PR comment names the flagged pattern and the declaration surface it exceeds; no human gatekeeping mystery.

### J6 — Routed build with escalation (UC5)

1. During any build, the statusline shows the routed target per step. Curious user: `obligato route explain <task>` → feature vector, chosen target, and the next candidates with estimated cost deltas (PRD §11).
2. A step fails verification at a cheap tier → RTR-2 escalation happens silently (ambient); it is visible afterward in `route explain` as `escalated: haiku → sonnet (regret recorded)`.
3. Fine-tuned agent registered via `obligato agents register` → immediately visible as a candidate in `route explain`, measurable via J3 from day one.

**Success:** the user never picks a model manually, but can always answer "why this model?" after the fact.

## 5. Key Moments (interaction-level spec)

### 5.1 Budget pause (CTX-4)

At 2× budget the step pauses with a compact triage panel: spent vs. budget, what the step was doing, and three verbs with the cheapest viable default first — `continue (+est. cost)` / `escalate to <next tier> (+est.)` / `re-spec (recommended when obligations keep failing — shown with the failure count)`. One keystroke resumes. The panel is the *only* time ambient budgeting interrupts anyone (UX-P1).

### 5.2 Divergence found (SPEC-4/5)

Side-by-side render of the two implementations' behavior on the divergent probe input — values, not diffs of code. Below: the drafted clauses that would resolve the ambiguity, pre-attached to the spec going back to planning. The message never says "ambiguity detected" without showing the concrete input that proves it.

### 5.3 Gate rejection & auto-revert (EVAL-2, LOOP-3)

Rejections show which metric failed, by how much, with CI — and whether more samples could change the verdict (`underpowered` vs. `hurts`). Auto-revert notices lead with the regression evidence and end with the re-release verb (UX-P5). Neither ever appears mid-task; they land at session boundaries.

### 5.4 Drift alerts (ART-2/3, SPEC-7)

Never mid-flow. Batched to session end and `obligato drift list`; grouped by module; inferred-clause violations visually distinct (informational) from confirmed-clause violations (blocking). The fatigue budget is explicit: if a session would show > 10 drift items, the view auto-collapses to module counts.

### 5.5 Degraded mode (KERN-1)

A single statusline badge (`degraded: telemetry`) and one line at session start. No repeated warnings. `obligato doctor` names the failing component and its fix.

## 6. UX Requirements (EARS + obligations, PRD format)

- **UX-1.** Every `obligato` CLI command shall support `--json` emitting schema-validated output equivalent to its rendered view.
  *Obligation:* CI matrix — a JSON-output registry maps every entry in the `COMMANDS` dispatch table to either its Zod output schema or a recorded reason it is not matrix-validated (interactive/streaming surfaces like `chat`/`ui` that emit no single view, or a command whose `--json` is discharged by its own family's obligations); the registry's key set must equal the dispatch table's (the test fails closed, so a newly-registered command must declare its `--json` contract or its skip reason), and every offline schema-backed command emits `--json` validating against its declared schema.
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
- **UX-7.** When `obligato` is invoked with no arguments on an interactive terminal, it shall open the launcher menu with one selectable row per registered command (a collapsed or blank menu is a failure to open); when stdin or stdout is not a TTY, it shall print plain help and exit 0 without prompting.
  *Obligation:* integration test — `obligato` spawned with piped stdio prints help, exits 0, emits no prompt escape sequences, and terminates with no input (timeout-guarded); plus a headless render (test renderer) asserting the menu's laid-out height is at least its option count, so a height-collapsed menu (F-110: the select shipped with no `flexGrow`, laid out to height 1, clipping every row) fails.
- **UX-8.** Every launcher wizard shall dispatch its terminal action through the same entry function as the typed CLI command, and a cancelled wizard shall execute nothing.
  *Obligation:* unit test — wizard completion is asserted (by identity) to call the shared dispatch table entry the typed command uses; a cancel fixture asserts zero dispatch calls and clean exit.
- **UX-9.** All rendered CLI output shall route through the §7 component layer.
  *Obligation:* source-tree gate test scanning `packages/*/src/**/*.ts` — all workspace packages, kernel included, `test/` excluded — for `console.log(`/`process.stdout.write(` call sites outside the component layer's single sink and an explicit file-path-keyed allowlist (`--json` emitter, non-TTY plain fallback, cc-plugin hook/statusline protocol emitters whose stdout is consumed by Claude Code); the test fails on any new unlisted write site. stderr writes are out of scope (divergence-tested 2026-07-03: both readers passed stderr; scan set diverged and is now pinned).
- **UX-10.** The `obligato ui` server shall bind only to the loopback interface and shall respond 405 to every non-GET request.
  *Obligation:* integration test — server started on an ephemeral port reports a loopback bind address; POST/PUT/PATCH/DELETE against every registered route return 405.
- **UX-11.** Every `obligato ui` API response shall validate against the same Zod schema as the corresponding `--json` output (UX-1); where a route serves a view no CLI command emits (aggregation, pagination envelope, composite), it shall validate against a dedicated view schema defined in `packages/schemas` that composes the CLI output schemas by reference wherever rows or branches overlap; if validation fails, the server shall return 500 rather than an invalid body.
  *Obligation:* CI matrix over all registered API routes — each response parses with its paired schema; a corrupted-store fault-injection fixture returns 500 with no partial body.
- **UX-12.** If the backing store is missing or empty, each `obligato ui` API route shall return a schema-valid empty result that names the CLI verb producing its data (UX-P5), and the corresponding view shall render a designed empty state, never an error.
  *Obligation:* empty-store fixture — every route returns 200 with a schema-valid payload carrying `empty_verb`; SPA empty-state render test asserts the verb is displayed.
- **UX-13.** When `obligato ui` starts without `--db`, it shall use `./.obligato/obligato.db` when that file exists in the working directory, and the user store (`~/.obligato/obligato.db`) otherwise; `--db` shall override both.
  *Obligation:* resolver unit test covering both branches, plus a wiring test — a server created with no `dbPath` in a temp working directory containing a seeded repo store serves that store's rows (fails if the default reverts to the user store).
- **UX-14.** When `obligato chat` runs in a TTY, it shall present the OpenTUI chat surface driven by a pure reducer (state transitions testable without a terminal); slash commands shall dispatch through the same functions as the typed CLI commands (the F-085 rule — wizards/slash surfaces are argument collectors, never parallel implementations); in a non-TTY it shall exit non-zero directing the user to `obligato run`.
  *Obligation:* reducer unit tests drive a full exchange headlessly (user input → streaming deltas → tool events → final state); non-TTY invocation exits non-zero naming `obligato run`; a slash command's dispatch target is the exported CLI function (identity check, not a reimplementation).
- **UX-15.** When `obligato run -p "<task>"` executes, it shall run the same `runTurn` driver as `obligato chat`, stream plain text to stdout (no OpenTUI), and with `--json` emit a final machine-readable result validating against its Zod schema (UX-1 discipline); exit code shall be 0 only if the session reached `done`.
  *Obligation:* CLI integration with a mock provider — plain mode emits the final text; `--json` output parses with the paired schema; a session ending paused/failed exits non-zero.
- **UX-16.** When `obligato auth login <provider>` completes, subsequent `obligato chat`/`obligato run` invocations shall start without further setup (PROV-4); the command shall never echo a credential to the terminal or store it outside `~/.obligato/auth.json`.
  *Obligation:* scripted login fixture — post-login chat proceeds past setup; captured stdout/stderr contain no credential substring; no file outside the temp HOME's auth.json gains the credential (recursive grep over the sandbox).
- **UX-17.** When `/model` is invoked in chat, it shall list the models from the same registry-resolution function the typed CLI uses (UX-8 identity — shipped registry + user overlay, overlay replacing a shipped entry wholesale on id collision, each id listed once), and selecting one shall switch the session's model for subsequent steps only: the switch is recorded as a session event, later StepEvents carry the new model id, and `.obligato/config.json`'s default is untouched. Divergence-pinned semantics (both readers, 2026-07-03) with an audit re-pin: the switch takes effect at the next model call — "a step's model id is fixed at the moment its model call is issued; tool executions inherit the id of the step that requested them". It may be invoked while **paused** (the suspended step keeps its model; the resumed step runs the new one). It shall **not** be applied mid-stream while a turn is actively generating — the TUI serializes turns, so a `/model` submitted while busy is rejected with a message, not queued or applied mid-step (audit re-pin 2026-07-03: both blind readers imagined a latch-and-apply implementation the shipped serialized-turn TUI does not have; applying mid-step would orphan the switch event off the reconstructed chain, F-088 class). Selecting the already-active model appends no event; an unknown id errors without appending; and a resumed/continued session derives its active model from the chain's last switch event, falling back to the session's starting model — never re-reading the config default.
  *Obligation:* reducer/unit — the /model listing comes from the exported registry function (identity check); after a scripted switch the next step's StepEvent.model is the new id and a session event records the switch; a switch while paused leaves the suspended step's attribution on the old model; a `/model` while busy is rejected with a message and appends nothing; same-model select and unknown id append nothing; config.json's bytes are unchanged throughout; `--continue` on a switched session resumes under the switched model, not the config default.
- **UX-18.** When `obligato bench --suite <dir> [--agents <a>,<b>] [--repeats <n>] [--seed <s>] [--json]` runs, it shall execute an EVP-11 bench run through the same kernel entry point its obligation tests drive (F-085 — no parallel implementation), defaulting agents to `api,claude`; it shall render a per-task matrix (per-agent FPAR symbol and cost with units) and the verdict with both effect sizes and CIs — never a bare verdict label (EVT-1 discipline) — through the §7 component layer, and with `--json` emit a `BenchReport` validating against its registered schema (UX-1). The exit code shall be 0 when the run completes to any verdict (a `hurts` or `underpowered` verdict is a successful measurement) and non-zero on refusal or failure; an `underpowered` verdict shall report its sample deficit.
  *Obligation:* CLI integration on a command-executor fixture suite — the rendered output carries the per-task matrix with symbols accompanying color and the verdict line with deltas + CIs; `--json` output round-trips the `BenchReport` schema and the command's `JSON_OUTPUT` registry entry declares that schema (UX-1 matrix); an underpowered fixture names the deficit; the CLI dispatch target is the exported kernel `runBench` (identity check).

- **UX-19.** When `obligato doctor` runs, it shall probe each harness component — store (present, openable and migration-compatible; a missing store fails naming `obligato init`, and the probe shall never create one), lockfile (parseable), auth (per configured provider; an expired oauth credential fails), telemetry directory (writable) — and render component → status → fix, naming for every failing component the single command or action that fixes it (UX-P5); with `--json` it shall emit a `DoctorReport` validating against its registered schema; the exit code shall be 0 only when no component fails; credential contents shall never be echoed. (Audit pin 2026-07-06: a diagnostic must not mutate — the prior probe's `openDb` created a missing store and reported it passing.)
  *Obligation:* fixture with no auth file — doctor names the auth component with `obligato auth login <provider>` as its fix, exits non-zero, `--json` parses with `DoctorReport`, and output contains no credential substring; a healthy fixture exits 0 with every component passing; a fixture with no store file reports the store failing with `obligato init` and the file still does not exist afterward.
- **UX-20.** When `obligato divergence show <id>` runs, it shall render the divergent probe input and both probe behaviors side-by-side (values, not code diffs — §5.2) with the report's clause ids; `obligato divergence list` shall order unresolved reports before resolved ones; `--json` output shall validate against the registered divergence view schema.
  *Obligation:* seeded `divergence_report` rows — `show` renders the probe input and both outcomes in one side-by-side block with clause ids; `list --json` orders unresolved first and parses with the registered schema.
- **UX-21.** When `obligato pack new <name>` completes, the scaffolded directory shall contain a manifest carrying every required field with explicit capability declarations consistent with the scaffolded content (SEC-4 ceiling), such that `obligato pack lint <dir> --prev <dir>` against itself exits 0 (an unchanged pack requires bump `none`) and the kernel pack loader accepts it without a capability refusal.
  *Obligation:* scaffold into a temp dir — `loadPack` succeeds with no SEC-4 refusal; self-lint through the real `pack lint` entry exits 0; the manifest's `capabilities` field is present and covers every scaffolded content dir.
- **UX-22.** When `obligato drift list` runs, it shall render inferred clauses as a survival table (sessions survived, per SPEC-8's promotion queue) alongside open drift events grouped by module, marking each drift row's authority with a literal token (inferred/informational vs confirmed/blocking — §5.4, never styling alone), and collapsing the drift section to per-module counts split by authority when the open-drift-event count exceeds 10 — exactly 10 renders itemized, 11 collapses; the survival table is exempt from the fatigue budget and always renders in full, and lists every violation-free inferred clause with its survived count (queue threshold 0 — review is the point of the list; `--min-sessions` filters to SPEC-8's promotion-ready candidates). `obligato drift promote` shall promote the selected inferred clauses through the same exported kernel function the excavation obligations drive (`promoteInferred` — F-085 identity), all-or-nothing: a selection containing any id that is not currently an inferred clause shall be rejected as a whole with the offending ids named and a non-zero exit, promoting nothing; duplicate ids dedupe to one promotion; an empty selection shall promote nothing and exit 0, through the same function. (Divergence-pinned 2026-07-06: both blind readers committed to the strict all-or-nothing batch the prior `promoteInferred` did not implement — silent partial promotion of a curated selection is data corruption; reader B's authority-split collapsed counts are pinned because collapsing must not erase the §5.4 blocking/informational signal. Promotion does not touch drift_event rows.)
  *Obligation:* seeded store with 11 open drift items across 2 modules renders authority-split module counts and no item rows, with 10 renders itemized rows, and the survival table renders fully in both; `promote` with valid ids flips exactly the named artifacts to `confirmed` (read back) via the exported `promoteInferred` (identity check); a selection containing one confirmed or unknown id exits non-zero naming it and flips nothing (read back: all `authority` values untouched); a duplicated id promotes once (deduped return); an empty selection exits 0 and flips nothing.
- **UX-23.** When `obligato eval report` runs, it shall re-render stored verdicts from the local store — decision with deltas and CIs and n, never a bare label (EVT-1) — without executing anything; when `obligato eval replay --session <id> --config <lockfile>` completes for a session previously promoted to a benchmark task, it shall re-run that task under the candidate config, record a `replay_record` linking source session and replay run with validity computed by the exported `validateReplay` (valid/advisory with reason), and render the replay outcome against the original; a session with no promoted task shall error naming `obligato promote`; a replay whose task execution fails shall still stamp its eval run's `finished_at` before the error propagates (no forever-running dangling rows).
  *Obligation:* `report` on a store with two verdicts renders both with CI bounds and inserts no new `eval_run` row; `replay` of a promoted fixture session under a toggled lockfile writes a `replay_record` whose `source_session_id` and `run_id` link the pair with validity from the exported `validateReplay` (identity check); an unpromoted session errors naming `obligato promote`; a replay against a missing snapshot exits non-zero with the run's `finished_at` set; `--json` output parses with its Zod result schema (the `eval` family's registry entry records the per-subcommand skip, UX-1 pattern).
- **UX-24.** When `obligato agents register <manifest>` completes, the manifest shall have been validated against `AgentRegistryEntry` and written into the repo registry (`.obligato/routing/agents/`), and the agent shall appear in `obligato route explain` candidates and in `obligato agents list` without restart — `route explain` shall include repo-registered agents, unioned by id with the resolved registry, repo entries winning; an invalid manifest shall change nothing.
  *Obligation:* register a fixture manifest — the same process's `route explain --json` lists the agent among candidates and `agents list --json` includes its capabilities; an invalid manifest exits non-zero and the registry directory gains no file.
- **UX-25.** The `obligato ui` eval surface shall include a bench view backed by `GET /api/bench` validating against a dedicated `UiBenchView` schema (UX-11 discipline), rendering per-run per-task agent matrices (pass/fail symbol and cost with units) and the verdict with deltas and CIs; on a missing or empty store the route shall return the schema-valid empty state naming `obligato bench` (UX-12).
  *Obligation:* route-matrix test — `/api/bench` parses with `UiBenchView` on a seeded bench run (per-task rows and a CI-carrying verdict present); an empty store returns 200 with the schema-valid empty payload whose `empty_verb` is `obligato bench`.
- **UX-26.** When `obligato index rebuild` runs, it shall reconcile the artifact index (artifact and trace-link rows) against the files of record — re-compiling `*.spec.md` obspec sources found by a filesystem scan of the repo root (excluding `.git`, `node_modules`, `.obligato`) and re-hashing rows whose logical_id resolves to a file on disk — through a single exported kernel rebuild entry running in one transaction, and render a reconciliation summary. Count semantics (divergence-pinned 2026-07-06): **ingested** = a row derived from the files of record with no prior store row; **changed** = a covered row whose recomputed content hash differs, overwritten in place; **discrepancy** = a covered row the files of record no longer regenerate — such rows are deleted only when provably spec-derived (logical_id naming a `*.spec.md` source), along with their dangling trace links, each deletion counted; a row counts in at most one bucket, and a row that recomputes identical counts in none. Rows outside the covered universe (logical_id neither resolving to a disk file nor naming a `*.spec.md` source) shall be untouched and uncounted. A obspec source that fails to compile shall abort the whole rebuild — rollback, non-zero exit, no summary; discrepancies alone exit 0; an immediately repeated rebuild reports all zeros. After rebuild, every artifact row whose logical_id resolves to a file shall carry that file's fresh hash. (Re-pinned against the surface: both blind readers enumerated files via the git index, but the kernel carries no git dependency — filesystem scan is pinned instead.)
  *Obligation:* corrupt one artifact row's `content_hash` in a seeded store — rebuild restores the disk hash and counts exactly one changed row; a clause row whose obspec source was deleted is removed and counted as a discrepancy while an opaque non-file row is untouched and uncounted; a second rebuild reports zeros; a syntactically broken obspec source exits non-zero leaving the store unchanged; the CLI dispatch target is the exported kernel rebuild function (identity check); `--json` validates its registered schema.
- **UX-27.** When `obligato db stats` runs, it shall render the resolved store path, file size, and per-table row counts, read-only — the store file's bytes shall be unchanged; when `obligato db backup <dest>` completes, `<dest>` shall be a consistent SQLite snapshot produced by `VACUUM INTO` (openable, per-table row counts equal to the source at backup time), an existing `<dest>` shall be refused with a non-zero exit and no modification to either file, and the source store shall be unchanged; both subcommands register `--json` per UX-1.
  *Obligation:* seeded store — `db stats` reports the exact seeded per-table counts and the store file hash is identical before/after; `db backup` into a temp path yields a file `bun:sqlite` opens with per-table row counts equal to the source; backup onto an existing path exits non-zero leaving both files byte-identical; `--json` outputs validate their registered schemas.

- **UX-28.** When chat-surface composition produces renderable content (the cockpit design, `2026-07-12-chat-cockpit-design.md`), it shall be expressed as a `WidgetTree` validating against the Zod schema in `packages/schemas`: `{ schema_version: 1, root: ChatWidget }`, where `ChatWidget` is a tagged union of exactly nine variants — `panel` (`title: string`, `children: ChatWidget[]` — the union's **only** recursion point), `table` (`columns: string[]`, `rows: string[][]`), `diff` (`unified: string`), `markdown` (`content: string`), `code` (`language: string`, `content: string`), `sparkline` (`label: string`, `values: number[]`), `tree` (flat `nodes: { id: string, label: string, parent: string | null }[]` — never nested nodes), `ticker` (`segments: { label: string, value: string, emphasis?: boolean }[]`), `badge` (`glyph_role: string`, `text: string`) — an unknown `type` failing parse. Objects are **strict**: an unrecognized key on any variant, node, segment, or the envelope fails parse with `unrecognized_keys` — never silently stripped (divergence ruling 2026-07-12: reader A strict vs reader B strip on the same probe; strip-mode erasure is the F-039 silent-drop class, and slice-7 `ui_hint` validation must reject malformed model output, not render an edited version of it) — so "never nested nodes" is enforced by rejection. Validation is **shape-only** (both readers convergent): ragged `table` rows, dangling/duplicate/self-parenting `tree` node references, and empty strings/arrays everywhere all parse — referential consistency is the composer's obligation, not the schema's; `schema_version` is the number literal `1`, never coerced (`"1"` fails); `z.number()` under zod 4 rejects `NaN` and `±Infinity` (inherited, load-bearing for `sparkline.values`); `emphasis` is optional with no default. `ChatWidget`'s recursive type is hand-written (zod 4 cannot `z.infer` through a recursive discriminated union, TS2615 — empirically pinned 2026-07-12), a recorded exception to the `z.infer` pairing convention; `WidgetTree` keeps the standard pairing. Alongside the schema the same module shall export `WIDGET_DEGRADE: Record<ChatWidget["type"], { col80: string, plain: string }>` — the per-**type** degrade rule map (80-column behavior; plain/non-TTY form), never per-instance degrade data on widgets: completeness is typechecker-enforced by the `Record` over the union's type literals and every descriptor is non-empty. Schema field changes update the paired round-trip arbitrary in the same edit (repo schema gate).
  *Obligation:* property — arbitrary `WidgetTree` (generator covering all nine variants, panels nested ≥ 2 deep) JSON round-trips through `parse` to a deep-equal value; a panel-in-panel-in-panel fixture parses; `{ type: "gauge" }` fails with `invalid_union`; a `tree` node carrying nested `children` and a `badge` carrying a stray key both fail with `unrecognized_keys` (strict, not stripped); the shape-only composite (ragged table rows + dangling/duplicate/self-parent tree nodes + empty segments) parses with zero issues; `schema_version: "1"` and `2` both fail at `["schema_version"]`; `[NaN]` and `[Infinity]` sparkline values fail at their index; `WIDGET_DEGRADE` has exactly the nine variant keys and every `col80`/`plain` is a non-empty string.

- **UX-29.** While the chat surface renders, every color and glyph shall resolve through the single token module `packages/cli/src/chat/theme.ts` exporting `CHAT_THEME`: color roles exactly `{ accent, user, tool, warn, err, ok, dim, fg }` with Quiet Pro defaults (accent `#8b9af7`, user `#e8ebf5`, tool `#6fc3d8`, warn `#e0b060`, err `#e07a7a`, ok `#7fc98a`, dim `#5c6480`, fg `#c3c9dd` — approved 2026-07-12) and glyph roles exactly `{ user: "❯", asst: "●", fold: "▸", unfold: "▾", err: "✖", info: "◆", cur: "▌", sep: "·", spin: [braille frame set, non-empty], bar: [ramp glyphs, non-empty] }`; role hues stay within §7's fixed color semantics (ok green-family, err red-family, warn yellow-family, tool cyan-family, dim metadata). No file under `packages/cli/src/chat/` — **recursive**, subdirectories included (the UX-9 gate's glob discipline, not a flat listing) — other than `theme.ts` shall contain a hex color literal or a hardcoded **marker** glyph (`user asst fold unfold err info cur`; `sep`, spin frames, and bar ramp are excluded as prose-safe — they legitimately appear in rendered output). When `NO_COLOR` is **present** in the environment — any value, the empty string included (presence semantics, matching the UX-4 mechanism in `components/theme.ts`/`sink.ts`; audit pin 2026-07-13: truthiness silently diverged on `NO_COLOR=""`) — every color role resolves to the no-op style (`resolveColor` returns `null`; renderers apply nothing) while glyphs and structure are unchanged. Theme replacement is a token-file swap: alternates ship as sibling token files, never as conditionals inside renderers.
  *Obligation:* `CHAT_THEME` color-role key set equals the enumerated eight and values equal the pinned Quiet Pro hexes; glyph-role key set equals the enumerated ten with `spin`/`bar` non-empty arrays; the NO_COLOR resolution path returns `null` for **every** color role (loop over all roles, not one representative) for both `NO_COLOR=1` and `NO_COLOR=""` (presence, not truthiness); a **recursive** source scan of `packages/cli/src/chat/**/*.ts` excluding `theme.ts` finds zero `#rrggbb` literals and zero marker glyphs, the marker set derived from `CHAT_THEME.glyphs` minus the recorded prose-safe exclusions (`sep`, `spin`, `bar`) — never a hardcoded copy.

## 7. TUI Legibility Spec

- **Component set:** panel (titled box), key-value grid, table with aligned numerics, inline bar/sparkline for effect sizes and trends, side-by-side diff, select-list. Built once in `packages/cli`, used everywhere; no ad-hoc `console.log` formatting outside the component layer. Static (print-and-exit) components are pure string renderers writing through the layer's single sink; interactive surfaces — select-list, launcher, wizards — render via OpenTUI `@opentui/core` (ADR-0003), which is an interactive-screen renderer and is not used for static output.
- **Color semantics (fixed):** green = passing/helps, red = failing/hurts, yellow = attention/underpowered, cyan = identifiers, dim = metadata. Color is never the only signal (symbols accompany: `✓ ✗ ~ ?`) — UX-4.
- **Density rule:** a view answers its one question in the first 10 lines; detail is progressive (expand/`--full`), not default.
- **Numbers:** effect sizes always carry CIs; costs always carry units (`$0.42`, `31k tok`); never bare floats.

## 8. Local Web UI

*(Promoted from post-v1 by the 2026-07-03 interface design — see `2026-07-03-interface-design.md` for architecture.)*

`obligato ui` serves a local, **read-only** web app from prebuilt static assets (`packages/ui`) plus a `GET /api/*` layer whose responses reuse the `--json` Zod schemas (UX-1). It resolves its store repo-first (UX-13). Localhost only, GET only, no auth surface; all actions stay in the CLI/TUI, shown as copyable commands (UX-P5). Four views: telemetry dashboard, eval explorer, improvement-loop board, traceability graph. Visual language: terminal-heritage dark, §7 color semantics and number rules apply. Governed by UX-10/11/12/13.
