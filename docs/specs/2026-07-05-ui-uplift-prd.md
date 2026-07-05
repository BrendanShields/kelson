# PRD: Interface Uplift — Every Event Stream Earns a Surface

Status: approved vision PRD (interface review + design pass, 2026-07-05). Formal
clauses land in their owning docs (UX spec for surface behavior, signal-contract for
SIG-*, routing-policy for RPOL-*) via feature-pipeline/spec-sync as each phase
starts; this document records the review, the feature catalog with draft clauses,
and the phase plan. Draft clauses here carry `UX-draft/<slug>` markers, not final
IDs — final IDs are assigned as next-free numbers in their family at landing time,
so no ID is speculatively claimed (clause-ID stability rule).

## 1. Vision

Kelson already has the *bones* of a great interface: a legibility spec (UX §7)
every surface obeys, machine output on every command (UX-1), statuses that name
their verb (UX-5), and files as the review surface of record (UX-P6). What it lacks
is *reach*: the store records far more than any surface shows, and several verbs
the UX spec promises do not exist. Meanwhile the event-sourced session model
(append-only trees, deterministic reconstruction per SES-2) makes capabilities that
are exotic elsewhere — time-travel inspection, fork-and-race, counterfactual
browsing — structurally cheap here. This PRD closes the promise gaps, uplifts the
daily-driver surfaces, and then spends the architectural dividend.

Two draft principles extend UX-P1..P6 (landing as UX-P7/P8 with the first phase):

- **The store is explorable, not just recorded (draft UX-P7).** Every event stream
  the harness writes earns a surface that can answer "what happened and why" without
  hand-written SQL. A table with no view is an unkept promise to the operator.
- **The human's queue is a first-class object (draft UX-P8).** Attention is budgeted
  like tokens (§5.4's fatigue budget generalized): everything awaiting a human is
  one queue, each item carries its evidence and exactly one verb, and the queue is
  itself queryable (`--json`) so "is anything blocked on me" is scriptable.

Surface split (decision, 2026-07-05): **TUI = live operation** (mission control,
tree navigation, in-run evidence overlays), **web = deep inspection** (session DAG,
scrubber, observatories, explorers). Each feature below names its natural surface.

## 2. Interface review (2026-07-05)

**Strong today.** The §7 component discipline is real and enforced (single sink,
UX-9 source gate); chat streams with live cost and serialized turns; the launcher
dispatches through the same table as typed commands (UX-8); the web UI validates
every response against the same Zod schemas as `--json` (UX-11); verdicts never
ship without effect sizes and CIs.

**Promise gaps.** UX §3 advertises verbs that are absent from the shipped
`COMMANDS` table (`packages/cli/src/index.ts`): `drift list|promote`,
`signals inbox|triage`, `agents register`, `index rebuild`, `doctor`, plus the
`eval replay|report` and `pack new` verbs inside existing families. J2 (brownfield
adoption) — a headline journey — is not operable end-to-end.

**Recorded but invisible.** Tables with no surface anywhere: `divergence_report`
(the §5.2 render exists only in-session), `routing_weight`/`routing_outcome` (the
bandit is illegible), `budget_event` history, cost provenance (`auth_kind`,
`priced_as` markers), `bundle_event`/`bundle_miss_event` (the ADR-0002 tripwire has
no gauge), the session tree (`fork/compare/compact` are CLI verbs with no visual
DAG), and `bench_run` (absent from the web eval explorer).

## 3. Feature catalog

Format per feature: description · surface · data read · draft clause with
obligation · effort (S under a few days, M one–two weeks, L multi-week or new
kernel/spec work). Cross-cutting requirements in §7 apply to every item and are not
restated.

### Tier 1 — Keep the spec's promises

**T1.1 `kelson drift list | promote`** — the J2 spine. `list` renders drift events
grouped by module with survival counts, confidence, and evidence links; inferred
clauses render visually distinct from confirmed (informational vs blocking, §5.4);
above 10 items the view collapses to module counts (fatigue budget). `promote` is
the SPEC-8 one-screen ritual: sorted by survival, space-to-select,
enter-to-promote; promoted clauses then block per ART-4. Kernel already writes
`drift_event` (`packages/kernel/src/artifacts.ts`) — this is purely a surface.
Surface: CLI + OpenTUI select screen; launcher row. Data: `drift_event`,
`artifact`, `trace_link`. Effort: M.
*Draft clause (UX-draft/drift-list):* When `kelson drift list` runs, the system
shall render drift events grouped by module with survival counts and evidence
links, collapsing to module counts when items exceed 10. *Obligation:* seeded store
with 11 drift events across 2 modules renders module-count collapse; with 3 events
renders full rows; `--json` validates against the drift view schema.

**T1.2 `kelson signals inbox | triage`** — the PIPE-1 feedback stage. Untriaged
signals (user feedback, TEL-7 accept/reject, postmortem observations) render as an
inbox with per-signal evidence panel (UX-2); triage routes each to
`now|next|later|dismissed` with an editable rationale. Requires kernel work first:
no `signal` table exists — migration + Zod schema + SIG-* obligations land via
feature-pipeline before the surface. Surface: CLI + TUI triage screen; web inbox
later. Data: new `signal` table, `intervention_event`, `session`. Effort: L.
*Draft clause (UX-draft/signals-inbox):* When `kelson signals inbox` runs, the
system shall list untriaged signals with source evidence, and each row shall name
`kelson signals triage` as its verb. *Obligation:* seeded signal rows render with
evidence and verb; triaging one records the priority bucket and rationale and
removes it from the inbox; empty inbox renders one line naming the producing verb.

**T1.3 `kelson agents register <manifest> | list`** — custom-agent onboarding
(RTR-4). `register` validates a manifest and adds it to the model-registry overlay
so it appears immediately in `route explain` candidates and `bench --agents`;
`list` shows endpoint ref, capabilities, prices, and routing win-rate so far.
Surface: CLI; registry table reused by T3.6. Data: registry overlay
(`~/.kelson/models.json`), `routing_weight`, `routing_outcome`. Effort: M.
*Draft clause (UX-draft/agents-register):* When `kelson agents register` completes,
the system shall include the agent in `kelson route explain` candidates and
`kelson agents list` without restart. *Obligation:* register a fixture manifest,
assert the same process's `route explain --json` lists it as a candidate and
`agents list --json` includes its capabilities.

**T1.4 `kelson index rebuild`** — the ERD §1 guarantee behind UX-P6: regenerate
every derived SQLite table from the files of record, then render a reconciliation
summary (rows rebuilt, orphans dropped, hash mismatches). Surface: CLI. Data:
`.kelson/` files, specs, changelog, ledger → derived tables. Effort: M.
*Draft clause (UX-draft/index-rebuild):* When `kelson index rebuild` completes,
every derived table shall match a fresh scan of the files of record and the summary
shall report any discrepancy count. *Obligation:* corrupt one derived row in a
fixture store, rebuild, assert the row matches the file of record and the summary
counted exactly one discrepancy.

**T1.5 `kelson doctor`** — the resolution verb §5.5's `degraded: telemetry` badge
already names. Runs the self-check battery (store integrity, telemetry round-trip,
sandbox/container availability, auth validity per PROV-7, OTel endpoint probe) and
renders component → status → fix command. Surface: CLI. Effort: S–M.
*Draft clause (UX-draft/doctor):* When `kelson doctor` runs, the system shall name
each failing component and the single command or action that fixes it.
*Obligation:* with a fixture store missing its auth file, doctor's `--json` output
names the auth component failing and `kelson auth login <provider>` as the fix;
never echoes credential contents.

**T1.6 `kelson eval replay | report`** — the two missing eval verbs. `replay`
re-runs a recorded run or promoted session counterfactually under a different
lockfile/config (kernel `replay.ts` + `replay_record` exist) and renders
actual-vs-replay deltas with CIs; `report` re-renders any past run's EVT-1 verdict
panel from the store without re-running. Surface: CLI. Data: `eval_run`,
`eval_task_result`, `replay_record`, `verdict`, manifests. Effort: M.
*Draft clause (UX-draft/eval-replay):* When `kelson eval replay <run> --config
<lockfile>` completes, the system shall render actual-vs-replay deltas with CIs and
record a `replay_record` linking both runs. *Obligation:* replay a fixture run
under a toggled lockfile, assert a replay_record row links source and replay run
ids and the rendered/`--json` deltas carry CI bounds.

**T1.7 `kelson divergence list | show`** — the after-the-fact surface for
`divergence_report` rows. `show` renders the §5.2 view: the divergent probe input
and both behaviors side-by-side (values, not code diffs) with the drafted resolving
clauses; `list` shows unresolved reports first. Unresolved reports also feed T3.5.
Surface: CLI (`sideBySideDiff`). Data: `divergence_report`. Effort: S.
*Draft clause (UX-draft/divergence-show):* When `kelson divergence show <id>` runs,
the system shall render the divergent probe input and both probe behaviors
side-by-side with the drafted resolving clauses. *Obligation:* a fixture report
renders both behaviors in one side-by-side block and its clause drafts; `list
--json` orders unresolved before resolved.

**T1.8 Bench tab in the web eval explorer** — `bench_run`/`bench_task_result` exist
and UX-18 renders them in the terminal, but the web explorer reads only
`eval_run`. Add a bench tab: run list → per-task agent matrix (FPAR symbol + cost
with units) → verdict with effect sizes and CIs, cells cross-linked to the sessions
they ran. Surface: web. Data: `bench_run`, `bench_task_result`, `session`.
Effort: S–M.
*Draft clause (UX-draft/bench-web):* When the eval explorer's bench tab loads a
run, it shall render the per-agent matrix and verdict with deltas and CIs,
validating against the `BenchReport` schema. *Obligation:* the `/api/` bench route
validates against `BenchReport` (500 on mismatch, UX-11 pattern); empty store
returns the schema-valid empty state naming `kelson bench` (UX-12 pattern).

**T1.9 `kelson pack new`** — the J5 scaffold: generate a pack skeleton with the
required capability declarations (SEC-4) so a contributor's first `eval ablate
./my-pack` works unedited. `kelson pack` currently accepts only `lint`. Surface:
CLI + launcher wizard. Data: pack-format templates. Effort: S.
*Draft clause (UX-draft/pack-new):* When `kelson pack new <name>` completes, the
scaffolded pack shall pass `kelson pack lint` and declare its capabilities
explicitly. *Obligation:* scaffold into a temp dir, run the real lint entry
function on it (exit 0), and assert the manifest's capability field is present and
non-implicit.

### Tier 2 — Daily driver

**T2.1 Attention-first launcher home** — bare `kelson` currently opens a command
menu; make the first screen a status panel: `3 proposals awaiting review`,
`7 drift items`, `1 budget pause`, `2 unresolved divergences`, overhead sparkline —
each row selectable, dispatching its verb's wizard through the same `COMMANDS`
table (UX-8). Empty state degrades to today's menu. Shares T3.5's kernel view
function. Surface: TUI launcher. Data: `proposal`, `drift_event`, `budget_event`,
`divergence_report`, `loop_event`, `monitor_record`. Effort: M.
*Draft clause (UX-draft/launcher-home):* When the launcher opens and actionable
states exist, it shall list each state with its count and dispatch its named verb
on selection; with none it shall render the command menu. *Obligation:* reducer
test — seeded actionable states produce one row per state with count and verb;
selection dispatches through the shared table; empty store yields the menu model.

**T2.2 Chat transcript legibility pack** — three compounding upgrades to
`kelson chat`: (a) tool results over N lines fold to a one-line summary naming the
expand keybind; (b) edit/write tool calls render through `sideBySideDiff` instead
of raw text; (c) reverse-search over the transcript, reconstructed from the session
event chain so it spans `--continue`. All pure-reducer state (UX-14), headlessly
testable. Surface: TUI chat. Data: reducer state, `session_event`. Effort: M.
*Draft clause (UX-draft/chat-collapse):* When a tool result exceeds the fold
threshold, the transcript shall render a collapsed summary naming the expand
keybind, and expanding shall render the full result. *Obligation:* reducer test
with an over-threshold fixture result asserts collapsed line + keybind name, then
expanded state after the keybind event.

**T2.3 In-chat evidence overlays `/route` and `/budget`** — `/route` shows the
current step's routing decision (feature vector, chosen target, next candidates
with cost deltas, any silent RTR-2 escalation with recorded regret) via the same
exported function `kelson route explain` uses (F-085 rule); `/budget` shows spend
vs budget with a per-step burn sparkline. Surface: TUI chat overlays. Data:
`routing_decision`, `routing_outcome`, `budget_event`, `step_event`. Effort: S–M.
*Draft clause (UX-draft/chat-route):* When `/route` is invoked in chat, the overlay
shall render the same payload as `kelson route explain` for the session's latest
step, produced by the same exported function. *Obligation:* identity test — the
chat dispatch resolves to the same function reference as the CLI command's; overlay
model equals the CLI `--json` payload for a fixture session.

**T2.4 Session tree glyph view** — `/tree` in chat and `kelson session tree`:
git-log-style indented glyph rendering of the `parent_id` DAG — branch heads,
per-branch cost with units, outcome symbols, compaction markers; cursor + enter
checks out a head in chat. Prerequisite visual for T3.1/T3.2. Surface: TUI chat +
CLI static render. Data: `session_event` (parent chain, `head_moved`, compaction),
`step_event` (cost rollup). Effort: M.
*Draft clause (UX-draft/session-tree):* When `/tree` is invoked, the system shall
render every branch of the session DAG with head markers and per-branch cost with
units, and selecting a head shall resume it. *Obligation:* a fixture 3-branch tree
renders 3 branches with heads and costs; reducer test asserts head selection emits
the resume effect for the chosen head id.

**T2.5 Cost provenance everywhere** — surface what the store records but no view
shows: `auth_kind` (API key vs subscription), `priced_as: "list"` counterfactual
markers, price snapshots. Web telemetry gains a provenance breakdown tile
("$4.12 metered / $9.80 list-priced subscription"); the chat cost ticker prefixes
counterfactual totals with `~`; `session` views gain per-step provenance badges.
Counterfactual cost is never presented as spend. Surface: web + TUI + CLI. Data:
`step_event` cost fields, registry price snapshots, session auth metadata.
Effort: S–M.
*Draft clause (UX-draft/cost-provenance):* When any view renders a cost derived
from subscription usage, it shall mark it list-priced and shall never aggregate it
with metered spend unmarked. *Obligation:* fixture session with mixed
`priced_as` steps — chat ticker shows `~`-prefixed total, telemetry tile separates
metered from list-priced, and no unmarked combined figure appears in any `--json`.

**T2.6 Web step timeline drill-down** — upgrade the telemetry view's per-session
drill-down to a vertical step timeline: model badge, duration, token/cost bar, tool
calls with ✓/✗ glyphs, permission asks, budget events, UX-17 model-switch events —
each entity cross-linked (step → routing decision → bundle). The read-only sibling
of the chat transcript and the on-ramp to T3.2. Surface: web. Data: `step_event`,
`session_event`, `budget_event`, `routing_decision`, `intervention_event`.
Effort: M.
*Draft clause (UX-draft/step-timeline):* When a session is opened in the web UI,
its steps shall render in event order (rowid) with per-step model, cost with units,
and tool outcomes with symbols. *Obligation:* the session view route validates its
composite schema; a fixture session's steps appear rowid-ordered with model, cost
units, and outcome symbols in the payload.

**T2.7 Bundle lens** — ADR-0002's own consequence clause requires bundle-miss
telemetry to be good "since it is the tripwire that would justify a retrieval
pack"; today `bundle_event`/`bundle_miss_event` have no surface. `route explain
--bundle` lists each bundle member with the structural reason it was retrieved
(trace link / symbol graph / invariant — explainable by design) plus the miss-rate
trend; the web step timeline embeds the same panel. Surface: CLI + web panel.
Data: `bundle_event`, `bundle_miss_event`, `trace_link`. Effort: M.
*Draft clause (UX-draft/bundle-lens):* When `route explain --bundle` runs for a
step, the system shall list each bundle member with its structural retrieval reason
and report the bundle-miss rate with its CI. *Obligation:* fixture bundle events
render one row per member with reason; miss-rate line carries CI bounds; `--json`
validates.

**T2.8 Web command palette** — Cmd-K over the SPA: fuzzy-jump to any entity
(session, run, proposal, clause); every *action* result is a copyable CLI command —
the UX-5 copy-verb pattern as a first-class interaction. No new viz dependency.
Surface: web. Data: existing `GET /api/*` + one small search route with its own
view schema. Effort: S.
*Draft clause (UX-draft/palette):* When a palette action is selected, the UI shall
display and copy the exact CLI command and shall perform no write request.
*Obligation:* component test — action selection renders the command string and
issues no non-GET request; search route validates its view schema.

**T2.9 Monitoring inline in `loop review`** — the review screen already shows gate
verdict + CIs; add the post-apply `monitor_record` trajectory against the revert
threshold, so approve/reject/defer sees the same evidence LOOP-3's auto-revert acts
on. UX-P3, literally. Surface: TUI. Data: `monitor_record`, `proposal`, `verdict`,
`loop_event`. Effort: S.
*Draft clause (UX-draft/review-monitoring):* When a proposal under review has
monitoring history, its review screen shall render the monitored metric's
trajectory against the revert threshold. *Obligation:* fixture proposal with
monitor records renders the trajectory sparkline and threshold value; one without
renders no monitoring block.

### Tier 3 — Multiverse (the architectural dividend)

**T3.1 Session race (fork-and-race)** — `kelson session race <head> --models
a,b,c [--repeats n]` and `/race` in chat: fork the session N ways at an event
boundary (forks are shared `parent_id` — free in the tree schema), run each branch
headlessly through `runTurn` with a pinned model under existing sandbox profiles,
render a race matrix (outcome symbol, cost, wall time, obligation pass rate), with
`session compare` one keystroke away. Winner checkout is a `head_moved` event —
append-only, reversible. Branch usage lands as ordinary step events, so racing
feeds the bandit (`routing_outcome`). Surface: CLI + chat; results visible in T3.2.
Data: `session_event` tree, `step_event`, `routing_outcome`. Effort: L
(parallel-branch workspace isolation is the hard part; the data model needs
nothing new).
*Draft clause (UX-draft/session-race):* When `kelson session race` completes, the
system shall render one row per branch with outcome, cost with units, and
obligation results, and shall name `kelson session compare` for any pair.
*Obligation:* race a fixture session across two mock models — assert two branch
rows with distinct parent-shared fork points, costs with units, and the compare
verb named; winner checkout appends `head_moved` without rewriting events.

**T3.2 Time-travel scrubber** — the flagship application of SES-2 deterministic
reconstruction, and a perfect fit for read-only web: open any session, drag a
scrubber across the event chain, and the context pane reconstructs *exactly what
the model saw* at that step — post-compaction messages, bundle contents, spec
clauses in force, active permission rules, the model id fixed at call issue
(UX-17) — using the same reconstruction function the runtime uses (F-085 identity).
A "why" sidebar shows the routing decision and budget state at that instant; fork
points render as branches (React Flow, already in the dep budget); "fork from here"
emits a copyable `kelson session fork <event-id>`. Surface: web primary; TUI lite
via `/tree` + step inspector. Data: `session_event`, `step_event`, `bundle_event`,
`routing_decision`, `budget_event`. Effort: L.
*Draft clause (UX-draft/scrubber):* When the scrubber selects an event, the context
pane shall render the reconstructed model input for that step produced by the same
reconstruction function the runtime uses. *Obligation:* API-route test — the
context payload for a fixture event equals the runtime reconstruction function's
output for that event id (identity-shared import, not a reimplementation).

**T3.3 Live mission control** — watch a running eval suite, bench, or race live:
per-task lanes (queued/running/✓/✗), streaming cost total, ETA from historical
per-task durations, quarantine events as they happen. Ships TUI-first as
`kelson eval ablate|compare --watch` / `bench --watch` (no pinned-decision
conflict). The web variant uses SSE-over-GET — structurally read-only, UX-10's
non-GET-405 obligation holds — but requires an explicit interface-design amendment
(its out-of-scope list names websockets/live transport) via spec-sync before
shipping. Tailing is trivial: append-only tables, rowid cursor. Surface: TUI first,
web after amendment. Data: `eval_run`, `eval_task_result`, `bench_task_result`,
`step_event` tail. Effort: M (TUI) / L (web SSE + amendment).
*Draft clause (UX-draft/mission-control):* While an eval run is in progress, the
watch surface shall reflect each task-state transition within 2 seconds without
issuing any non-GET request. *Obligation:* drive a fixture run through state
transitions; assert the watch model receives each transition (rowid-cursor tail)
and, for web, that the transport is a GET stream.

**T3.4 Counterfactual explorer** — the visual layer over T1.6: pick a completed
run or promoted session, toggle lockfile dimensions (pack on/off, model, policy),
and browse actual-vs-replay side by side — per-task outcome flips highlighted,
verdict deltas with CIs, cost delta. Every cell is a real `replay_record`; the
explorer browses evidence, it never simulates. "Run this cell" emits a copyable
`kelson eval replay …`. Surface: web + `eval replay --matrix` for scripted grids.
Data: `replay_record`, `eval_run`, `eval_task_result`, `verdict`, manifests,
`benchmark_task`. Effort: M (given T1.6).
*Draft clause (UX-draft/counterfactual):* When two runs share a replay link, the
explorer shall render per-task outcome flips and the verdict delta with CIs, and
shall never display an unexecuted configuration as a result. *Obligation:* fixture
pair renders flips and CI-carrying delta; a configuration with no replay_record
renders as a proposed command, never as a result cell.

**T3.5 Attention queue (`kelson inbox`)** — UX-P8 industrialized: one kernel view
function aggregating everything awaiting a human — proposals awaiting review,
unresolved divergences, drift batches, budget pauses, auto-revert notices,
quarantined flaky tasks, expired auth (PROV-7), untriaged signals (once T1.2
lands). Each item: evidence summary, age, exactly one verb. `kelson inbox` renders
it; the launcher home (T2.1) is its TUI face; a web view its ambient face; `--json`
makes "is anything blocked on me" scriptable. Surface: CLI + TUI + web, one data
spine. Data: `proposal`, `divergence_report`, `drift_event`, `budget_event`,
`loop_event`, `monitor_record`, quarantine, `signal`. Effort: M.
*Draft clause (UX-draft/inbox):* When `kelson inbox` runs, every actionable item
shall carry its evidence summary and exactly one verb, and an empty inbox shall say
so in one line. *Obligation:* seeded store with one item of each kind renders each
with evidence + single verb and validates the inbox schema; empty store renders one
line; the launcher home consumes the same view function (identity test).

**T3.6 Routing observatory** — make the bandit legible: current `routing_weight`
per feature-bucket × model as a labeled heat grid, the recent `routing_decision`
stream with chosen-vs-runner-up cost deltas, RTR-2 escalations with recorded
regret, and a cumulative-regret sparkline over the local store's rows. Scoped to
current state + recent local history — long-horizon time-series stays OTel→Grafana
(ADR-0001); this is an observatory, not a metrics warehouse. Surface: web view +
`kelson route observe`. Data: `routing_weight`, `routing_decision`,
`routing_outcome`, `budget_event`. Effort: M.
*Draft clause (UX-draft/observatory):* When the observatory loads, it shall render
current weights and the recent decision stream with regret, sourcing only the local
store. *Obligation:* fixture weights/decisions render the grid and stream with
regret values; the view function takes only a store handle (no network), asserted
structurally.

**T3.7 `kelson ask` — natural-language store queries** — "which pack regressed
FPAR last month?", "why did step 4 escalate?" — answered by the native runtime
itself equipped with exactly one tool: a read-only SQL executor over the store
(connection opened read-only; schema + table docs injected as context). Not RAG:
the agent writes SQL against the structural schema, and the rendered answer always
shows every SQL statement executed plus its result table — deterministic,
reproducible, explainable, exactly the ADR-0002 properties. Dogfoods the runtime;
every `ask` session is itself telemetry and promotable via EVP-10 (the harness
improving its own query skill). Any future semantic-search variant ships only as an
eval-gated pack per the ADR's escape hatch. Surface: CLI + `/ask` in chat. Data:
whole store via read-only connection; model via the normal routing path.
Effort: M.
*Draft clause (UX-draft/ask):* When `kelson ask` answers, it shall display every
SQL statement executed alongside its result, and the store connection shall reject
writes structurally. *Obligation:* fixture-driven run (recorded stream, no live
endpoint) shows each SQL + result block; an INSERT attempted through the tool fails
at the connection layer, asserted by the error the tool returns.

**T3.8 Spec health heatmap** — enrich the traceability DAG view: per clause
family, obligation pass rate, last-verified age, downstream drift pressure, and
divergence history — the "is my spec suite load-bearing" view. Node color stays
drift status (already specced); add family rollup bars and a stalest-clause callout
naming `kelson drift list`. Surface: web (trace view v2) + `kelson spec health`
panel. Data: `trace_link`, `artifact`, `verification_report`, `drift_event`,
`divergence_report`. Effort: M.
*Draft clause (UX-draft/spec-health):* When the traceability view renders, each
clause family shall show its obligation pass rate and staleness, with the stalest
item naming its verb. *Obligation:* fixture store renders per-family pass rates and
ages; the stalest item's payload carries the drift verb; composite view schema
validates.

**T3.9 Harvest queue (`kelson promote --suggest`)** — EVP-10 promotion is manual;
the store already knows which sessions make good benchmark tasks: human
interventions, fail-then-succeed step patterns, budget escalations, accepted
outcomes on risky clauses. `--suggest` ranks candidates with the qualifying signal
named; selection dispatches the existing promote entry point into the staging suite
(LOOP-6 semantics: non-gating until human-promoted). Closes the loop's intake — the
harness proposes its own regression suite from lived experience. Surface: CLI +
launcher row. Data: `session`, `intervention_event`, `step_event`, `budget_event`,
`verification_report`. Effort: M.
*Draft clause (UX-draft/harvest):* When `promote --suggest` runs, each candidate
session shall show the signal that qualified it, and selection shall dispatch the
existing promote entry point. *Obligation:* fixture sessions with an intervention
and an escalation both surface with their named signals; dispatch identity test
against the promote entry function.

**T3.10 Shootout scheduler** — where bandit uncertainty is highest (wide weight
variance for a feature bucket, or a newly registered agent with no outcomes),
propose — never auto-run — the targeted `kelson bench` invocation that would shrink
it fastest, with a cost estimate up front (SEC-3 discipline). Surfaces as an
attention-queue item: "routing is guessing on `refactor/T1` → `kelson bench …`
(~$1.20) would resolve it." Turns exploration spend into a deliberate,
evidence-priced decision. Surface: `kelson route observe --gaps` + inbox item.
Data: `routing_weight` variance, `routing_outcome` counts, `benchmark_task`,
registry prices. Effort: M–L.
*Draft clause (UX-draft/shootout):* When routing uncertainty for a feature bucket
exceeds its threshold, the system shall propose exactly one bench command with its
cost estimate and shall never execute it unprompted. *Obligation:* fixture weights
with high variance yield one proposed command + estimate in `--json`; no eval/bench
row is created by the proposal path.

## 4. Web write path (pin challenge — approved for proposal 2026-07-05)

The interface-design doc pins the web UI read-only. The most-requested closures of
the loop — approving a proposal from the kanban, promoting drift, answering a
paused session's permission ask — need writes. This PRD proposes revising that pin,
explicitly and late:

- **Transport:** localhost-only POST with a per-server-session CSRF token; UX-10's
  loopback bind unchanged; non-POST/non-GET still 405.
- **One dispatch rule extended to HTTP:** every write route calls the *same* kernel
  entry function as its CLI verb (UX-8/F-085 over the wire) — no parallel
  implementation can grow in the server.
- **Audit:** every write is recorded as an event naming the surface (`web`) —
  append-only, same as CLI-originated actions.
- **Initial verb set:** loop approve/reject (with LOOP-2's required reason), drift
  promote, permission-ask answer, fork/race launch.
- **Gating:** Phase D only, entered after Phases A–C ship and the attention queue
  demonstrates demand (items repeatedly copied-then-executed). Entering Phase D
  requires a new ADR revising the read-only decision (PIPE-4) plus spec-sync
  amendments to UX-10/interface-design. Nothing in Phases A–C depends on writes;
  every earlier web feature ships copy-verb only.
*Draft clause (UX-draft/web-write):* When a web write route is invoked with a valid
CSRF token, the server shall dispatch the same kernel entry function as the
corresponding CLI verb and append an audit event naming the surface; without a
valid token it shall respond 403 and dispatch nothing. *Obligation:* identity test
route-handler → CLI entry function; valid-token request appends the audit event;
invalid-token request returns 403 with no state change (store diff empty).

## 5. Phased rollout

- **Phase A — keep the promises:** T1.5 doctor → T1.7 divergence → T1.9 pack new →
  T1.1 drift → T1.6 eval replay/report → T1.3 agents → T1.8 bench-in-web → T1.4
  index rebuild; SIG-* spec/kernel work for T1.2 starts here. Rationale: every item is already
  advertised by a shipped spec or has an orphaned table; all S/M; drift unlocks J2
  end-to-end.
- **Phase B — daily driver:** T3.5 inbox kernel view first (the spine three
  surfaces share) → T2.1 launcher home → T2.2 chat pack → T2.3 overlays → T2.4
  tree glyphs → T2.5 provenance → T2.6 step timeline → T2.7 bundle lens → T2.8
  palette → T2.9 review monitoring; T1.2 signals inbox lands.
- **Phase C — multiverse (read-only):** T3.2 scrubber (pure leverage over existing
  data; makes everything after it inspectable) → T3.4 counterfactual explorer →
  T3.1 session race → T3.3 mission control (TUI watch first; web SSE after the
  interface-design amendment) → T3.6 observatory → T3.7 ask → T3.8 spec health →
  T3.9 harvest → T3.10 shootout.
- **Phase D — web write path:** ADR revision + §4 verb set, gated on A–C and
  demonstrated demand.

## 6. Constraint compliance

| Feature | Pin touched | Resolution |
|---|---|---|
| T3.3 mission control (web) | interface-design out-of-scope: websockets; polling freshness | SSE-over-GET preserves the UX-10 non-GET-405 obligation; still requires an explicit interface-design amendment via spec-sync before the web variant ships. TUI `--watch` has no conflict — ships first. |
| T3.6 observatory | ADR-0001: no dashboards-over-time in v1 (OTel→Grafana) | Scoped to current state + recent local-store rows; if review judges the regret sparkline crosses the line, drop it and keep the state grid. |
| T3.7 ask | ADR-0002: no RAG/graph-DB | Compliant as specced: SQL over the structural schema, SQL always shown, read-only connection. Semantic variants only as eval-gated packs. |
| T3.1 race | EVP-2 sandbox boundary | Parallel branches run under existing sandbox profiles; no container runtime → same refusal semantics as evals. |
| §4 write path | interface-design read-only pin; UX-10 | Explicitly proposed as a Phase-D ADR revision; Phases A–C ship nothing that depends on it; all earlier web features are copy-verb only. |

## 7. Cross-cutting requirements

Every feature in this PRD, without restatement per item:

- New commands register in the UX-1 JSON registry (schema or recorded skip) and
  the UX-9 sink allowlist discipline; launcher rows/wizards and chat slash commands
  dispatch through the shared `COMMANDS` table (UX-8).
- New web routes pair a Zod view schema (UX-11) and a designed empty state naming
  the producing verb (UX-12); no third visualization dependency (charting lib +
  React Flow only).
- All shared queries live in kernel view functions — one data spine feeding CLI,
  TUI, and web (the T3.5/T2.1 identity obligation is the pattern).
- Event-stream reads order by rowid; costs carry units; effect sizes carry CIs;
  color never the only signal (UX §7).
- LLM-touching features (T3.7, T3.1) follow the fixture-based test rule: recorded
  streams, no live endpoints in gates.

## 8. Success metrics

- **Promise integrity:** % of UX §3 advertised verbs that exist in `COMMANDS` —
  target 100% by end of Phase A (today: 10 of 15 advertised command families
  exist — `agents`, `doctor`, `drift`, `index`, `signals` are absent — and within
  existing families `eval replay|report` and `pack new` are also missing).
- **Blocked-on-me latency:** time to answer "is anything awaiting me" — one command
  (`kelson inbox`, scriptable via `--json`) by end of Phase B.
- **Surface coverage:** every event-table family (drift, divergence, budget,
  routing weights/outcomes, bundle, bench, session tree, provenance) has at least
  one view by end of Phase C — target 100% (today: ~40%).
- **Inspection depth:** any past session step's exact model input reachable in ≤3
  interactions from the session list (scrubber), verified by the T3.2 obligation.
- **Loop closure (Phase D):** median proposal review→decision time, before vs
  after web writes — the demand evidence that gates the ADR revision.
