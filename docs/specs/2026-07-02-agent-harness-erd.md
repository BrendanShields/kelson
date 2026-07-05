# ERD: Kelson Data Model

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Upstream:** [PRD](./2026-07-02-agent-harness-prd.md) — entity requirements trace to PRD clause IDs noted per entity.
- **Implementation language:** TypeScript (see ADR-0001 for the language/storage decision record).

## 1. Storage Substrate

Three tiers, one rule each:

| Tier | Holds | Rule |
|---|---|---|
| **Git-tracked files** (in the target repo and in pack repos) | Specs/PRDs/ERDs/ADRs, spec clauses, packs (manifests, rules, routing policy structure, agent registry), lockfile, changelog, eval ledger | Anything a human reviews, a PR carries, or that must survive Kelson's removal is a file |
| **Local SQLite** (WAL mode; store resolved repo-first per UX-13 — `./.kelson/kelson.db` when that file exists in the working directory, else the per-operator `~/.kelson/kelson.db`) | Sessions, tasks, step events, interventions, routing decisions, bundle/budget events, verification reports, eval runs/results/verdicts, replay records, drift events, routing weights, the artifact index | Anything measured, high-volume, or queried statistically lives in SQLite |
| **OTel projection** (optional, off by default; PRD TEL-6) | Traces/spans/metrics derived from SQLite-bound events at emit time | A projection, never a source of truth; content-stripped per TEL-3 |

The **artifact index** (hashes, trace links, staleness) is derived from files and rebuildable at any time (`kelson index rebuild`) — SQLite is disposable without losing anything a human authored.

## 2. Conventions

- **IDs:** ULIDs for event-like rows (sortable, no coordination). Artifacts use a stable logical ID (`repo-relative path + anchor`) plus a current `content_hash` (SHA-256); identity is the logical ID, versions are hashes.
- **Schema versioning (PRD OSS-6):** one `schema_migrations` table, forward-only migrations shipped with the CLI; every event row carries `schema_version`.
- **Types:** Zod schemas in `packages/schemas` are the single source of truth. TS types are inferred (`z.infer`), SQLite rows validated at the boundary, and JSON Schema is generated from Zod for the external signal contract (PRD §8.7) and the OTel attribute conventions.
- **Append-only tables** (`changelog` is a file, but `step_event`, `intervention_event`, `eval_task_result`, `bench_task_result` are append-only in SQLite, enforced by BEFORE UPDATE/DELETE triggers): no UPDATE path in the data layer; corrections are new rows. `drift_event` is the exception — implementation surfaced that its `resolution`/`resolved_at` fields mutate in place as drift is resolved (ERD §3), so it is insert-then-resolve, not append-only.
- **Time:** UTC ISO-8601 strings (SQLite TEXT); durations in ms.
- **Money:** integer micro-USD (no floats in cost math).

## 3. Domain: Artifacts & Traceability

Implements PRD §6.4, §7 (ART-*, SPEC-*).

```mermaid
erDiagram
    ARTIFACT ||--o{ SPEC_CLAUSE : contains
    SPEC_CLAUSE ||--o{ OBLIGATION : "compiles to"
    ARTIFACT ||--o{ TRACE_LINK : "upstream of"
    ARTIFACT ||--o{ TRACE_LINK : "downstream of"
    ARTIFACT ||--o{ DRIFT_EVENT : flags

    ARTIFACT {
        string logical_id PK "repo-relative path + anchor; composite key with repo"
        string repo PK "composite key with logical_id"
        string type "signal|idea|prd|erd|adr|spec|code_region|test"
        string content_hash "SHA-256, current"
        string authority "authored|inferred|confirmed"
        string tier "T0|T1|T2"
        string created_at
        string updated_at
    }
    SPEC_CLAUSE {
        string clause_id PK "spec logical_id + clause key (e.g. TEL-3)"
        string spec_id FK
        string ears_type "ubiquitous|event|state|unwanted|optional"
        string kind "requirement|invariant|domain_def (pre/postconditions are fields on requirement clauses, Kelspec DSL 2.3)"
        string compile_status "compiled|failed|unverifiable_signed"
        string tier
        string authority
    }
    OBLIGATION {
        string id PK
        string clause_id FK
        string kind "pbt|metamorphic|model_check|proof"
        string target_ref "test file / model / proof artifact path"
        string status "passing|failing|stale"
        string last_run_at
    }
    TRACE_LINK {
        string id PK
        string repo "scopes both endpoints; logical_ids collide across repos"
        string upstream_id FK
        string downstream_id FK
        string upstream_hash_at_link "staleness = this != current upstream hash"
        string downstream_hash_at_link "code-side drift baseline (ART-5); frozen at link time like its upstream twin"
        string created_at
    }
    DRIFT_EVENT {
        string id PK "ULID, insert-then-resolve (see §2)"
        string repo "scopes artifact_id (composite artifact key)"
        string artifact_id FK
        string direction "code_under_spec|spec_over_code|upstream_stale"
        string detected_at
        string resolution "open|repaired|overridden|promoted"
        string resolved_at
        string resolved_by "null until resolved; ART-4 override attribution"
        string resolution_reason "null until resolved; ART-4 override attribution"
        int schema_version
    }
```

Notes: clauses are addressable sub-artifacts because traceability is clause-level (ART-1/2). `TRACE_LINK` freezes the upstream hash at link time; re-registering a downstream artifact **replaces** its trace links (hashes re-freeze at the new declaration) — trace_link is replace-on-register, not append-only; drift detection (ART-2/3) starts from every link where `upstream_hash_at_link ≠ current content_hash` and flags that link's **entire transitive downstream set** (recursive CTE, ADR-0002), run per session and on activation; code-side drift (ART-3/5) compares the downstream artifact's on-disk hash against `downstream_hash_at_link`, never against the rebuildable index's current hash. Drift events anchor on the link's **downstream** artifact in both directions; both-changed inserts two rows; an open `(repo, artifact_id, direction)` suppresses re-insert (ART-5). Files hold the authored content; these tables are the rebuildable index (§1).

## 4. Domain: Packs & Change Control

Implements PRD §5.3, §9 (LOOP-*), §14.2 (SEC-4..6).

```mermaid
erDiagram
    PACK ||--o{ LOCKFILE_ENTRY : "pinned by"
    LOCKFILE ||--|{ LOCKFILE_ENTRY : contains
    PACK ||--o{ PROPOSAL : targets
    PROPOSAL ||--o{ EVAL_RUN : "gated by"
    PROPOSAL ||--o{ CHANGELOG_ENTRY : produces
    PROPOSAL ||--o| MONITOR_RECORD : "watched by"
    PROPOSAL ||--o{ LOOP_EVENT : "audited by"

    PACK {
        string name PK
        string version PK "semver"
        string kind "stage|efficiency|spec_tooling|routing|eval_suite|agent_registry"
        json capabilities "declared surfaces (SEC-4)"
        string content_hash
        string signature "release signature (SEC-5)"
    }
    LOCKFILE {
        string hash PK "content hash of entries"
        string parent_hash "previous lockfile"
        string created_at
    }
    LOCKFILE_ENTRY {
        string lockfile_hash PK,FK
        string pack_name PK,FK
        string pack_version FK
        boolean enabled
    }
    PROPOSAL {
        string id PK "insert-then-transition (state machine §9.2)"
        string target_pack FK "never kernel/eval-suite/loop-spec (LOOP-4)"
        json diff "v1: inline lockfile ops (enable|disable); content diffs later"
        string diff_hash "canonical hash — quarantine blocks re-proposal by content (LOOP-9)"
        json evidence "ev: links (LOOP-1/LOOP-8)"
        string rationale
        string state "proposed|gated|approved|rejected|applied|monitoring|stable|reverted|quarantined"
        string created_by "loop|human"
        string quarantine_reason
        string created_at
        string updated_at
        int schema_version
    }
    CHANGELOG_ENTRY {
        int seq PK "append-only (invariant I5)"
        string proposal_id FK
        string action "apply|revert|human_change"
        string lockfile_before FK
        string lockfile_after FK
        string at
    }
    MONITOR_RECORD {
        string proposal_id PK "one monitor per applied proposal (LOOP-3/LOOP-9)"
        string applied_at
        string lockfile_after FK
        json baseline_session_ids "frozen at apply, quarantine-filtered (LOOP-9)"
        boolean baseline_insufficient "under 8 baseline sessions: alert-only, never auto-revert"
        string status "open|cleared|reverted|abandoned"
        int check_seq "bootstrap seed derives from (proposal_id, check_seq)"
        boolean stalled_notified "one stalled event at day 14 (LOOP-9)"
        string closed_at
        int schema_version
    }
    LOOP_EVENT {
        string id PK "append-only; the monotone audit trail (I5)"
        string proposal_id FK "nullable"
        string kind "proposal_created|evidence_check|acl_rejected|state_transition|monitor_opened|monitor_check|monitor_check_skipped|regression_detected|monitor_stalled|monitor_closed|quarantine_release"
        json payload
        string at
        int schema_version
    }
```

Notes: `PACK`, `LOCKFILE`, and `CHANGELOG_ENTRY` are files (git-tracked; changelog is an append-only JSONL); rows here are index. `PROPOSAL.state` is exactly the §9.2 state machine — the TLA+ model and this enum must not drift (LOOP-5 conformance tests bind them). LOOP-4's protected-surface check is a constraint on `target_pack` enforced in the write path, not a prompt rule.

## 5. Domain: Telemetry

Implements PRD §6.1 (TEL-*, KERN-1), §12 (CTX-*), LOOP-7.

```mermaid
erDiagram
    SESSION ||--o{ STEP_EVENT : contains
    TASK ||--o{ STEP_EVENT : "routed as"
    TASK ||--o{ INTERVENTION_EVENT : receives
    TASK ||--o{ VERIFICATION_REPORT : produces
    TASK ||--o{ ROUTING_DECISION : "steps routed by"
    TASK ||--o{ BUNDLE_EVENT : "context from"
    BUNDLE_EVENT ||--o{ BUNDLE_MISS_EVENT : "on-demand loads"

    SESSION {
        string id PK "ULID"
        string repo
        string lockfile_hash FK "pinned at start (LOOP-7)"
        string harness_version
        int schema_version
        string status "complete|incomplete|degraded"
        string runner "cc|native, nullable — pre-0008 rows null (SES-5)"
        string trace_id "OTel correlation (TEL-6)"
        string started_at
        string ended_at
    }
    TASK {
        string id PK
        string repo
        json spec_clause_refs
        string state "open|in_progress|delivered|accepted|corrected|abandoned (TEL-7)"
        string acceptance_signal "approval|merge_clean|null"
        int correction_count "count of correction-class interventions (TEL-4), maintained at ingestion"
        string opened_at
        string delivered_at
        string closed_at
    }
    STEP_EVENT {
        string id PK "ULID, append-only"
        string task_id FK
        string session_id FK
        string sdlc_step "feedback|ideation|planning|spec|build|verify"
        string model
        string effort
        string agent_id FK
        int tokens_in
        int tokens_out
        int tokens_cache_read
        int tokens_cache_write
        json unit_prices "price snapshot at execution (cost normalization, PRD 3); keys are lowercase identifier tokens (^[a-z][a-z0-9_.:-]*$) — never arbitrary strings"
        int cost_micro_usd "nullable: NULL = price unknown at ingest (PROV-3, never estimated); migration 0007 rebuilt the table via transient step_event_new to drop NOT NULL"
        int budget_tokens
        string overrun "none|soft|paused (CTX-4)"
        string span_id "OTel correlation"
        int schema_version
    }
    INTERVENTION_EVENT {
        string id PK "ULID, append-only"
        string task_id FK
        string session_id FK
        string class "correction|clarification|approval (TEL-4)"
        string artifact_hash "what it concerns"
        string at
        int schema_version
    }
    ROUTING_DECISION {
        string id PK "append-only"
        string task_id FK
        string step_id
        int attempt "0 = initial; escalations increment (RTR-2)"
        string kind "initial|escalation"
        json feature_vector "RTR-1"
        int rule_index "-1 = default rule (RPOL-1)"
        string matched_by "rule|capability — capability match overrides the rule target (RTR-4)"
        string target FK
        string effort
        json loadout
        int budget_tokens "CTX-4"
        json escalation "remaining ladder"
        string policy_hash "canonical policy content hash"
        boolean regret "escalation = the RTR-2 regret event"
        string at
        int schema_version
    }
    BUNDLE_EVENT {
        string id PK "append-only (CTX-1)"
        string task_id FK
        string tokenizer "pinned identity (CTX-5)"
        int token_count "whole-text tokenization of the assembled bundle (CTX-5)"
        json manifest "kind, ref, hash, tokens per section — the verification route"
        string at
        int schema_version
    }
    BUNDLE_MISS_EVENT {
        string id PK "append-only; on-demand loads join the accounting (CTX-1)"
        string bundle_id FK
        string ref
        int tokens "tokenization of the delivered content"
        string at
        int schema_version
    }
    BUDGET_EVENT {
        string id PK "append-only; ordering by rowid — ULIDs tie within 1ms (F-060)"
        string step_id
        string kind "overrun|triage_requested|triage_resolved (RPOL-6)"
        json payload "attribution on overrun; action/actor/reason on resolution"
        string at
        int schema_version
    }
    VERIFICATION_REPORT {
        string id PK
        string task_id FK
        json results "per check class (PIPE-8)"
        string failure_class "code_defect|spec_defect|obligation_defect|null (PIPE-9)"
        string at
    }
```

Notes: `TASK` is deliberately not owned by `SESSION` — tasks resume across sessions; `STEP_EVENT` carries both FKs, so FPAR joins tasks to configs through sessions' pinned lockfiles. Price snapshots are denormalized onto `STEP_EVENT` so historical cost math never depends on a mutable price table.

### Native runtime session events (Phase 6, SES-*)

```mermaid
erDiagram
    SESSION ||--o{ SESSION_EVENT : "native runtime history"

    SESSION_EVENT {
        string id PK "ULID, append-only (SES-1)"
        string session_id FK
        string parent_id FK "nullable; chain forms the session tree (SES-2)"
        string kind "user_message|assistant_message|tool_call|tool_result|permission_request|permission_decision|compaction|head_moved|session_meta"
        json payload "kind-specific; assistant_message carries step_event_id ref, usage, model, cost"
        string at "UTC ISO-8601"
        int schema_version
    }
```

Append-only, no UPDATE/DELETE (SES-1); reads order by `rowid`. The current head is derived from the latest `head_moved` event by rowid — there is no mutable head column (SES-3). Forks (Phase 10) are two events sharing a `parent_id`. `SESSION` carries a nullable `runner` column (`cc|native`, migration 0008, SES-5): `startSession` writers stamp their runner; pre-0008 rows read back null.

## 6. Domain: Eval

Implements PRD §6.2 (EVAL-*), §10 (EVT-*), §14.1 (SEC-1..3).

```mermaid
erDiagram
    EVAL_SUITE ||--o{ BENCHMARK_TASK : contains
    EVAL_RUN ||--o{ EVAL_TASK_RESULT : produces
    EVAL_RUN ||--|| VERDICT : yields
    BENCHMARK_TASK ||--o{ EVAL_TASK_RESULT : "measured by"
    REPLAY_RECORD }o--|| EVAL_RUN : "scored in"

    EVAL_SUITE {
        string id PK
        string version PK
        string role "gating|staging (LOOP-6)"
    }
    BENCHMARK_TASK {
        string id PK
        string suite_id FK
        string snapshot_ref "content-addressed repo snapshot"
        string statement
        json checks
        int budget_ceiling
        boolean quarantined "EVAL-3"
        string origin "seed|loop|human"
    }
    EVAL_RUN {
        string id PK
        string kind "ablate|compare|replay"
        string suite_version FK
        string config_a "lockfile hash"
        string config_b "lockfile hash, null for replay"
        int seed
        string executor "claude|command|api (EVP-7/EVP-9); migration 0009 rebuilt the table via transient eval_run_new to widen the CHECK"
        json model_versions
        json sandbox_profile "SEC-3"
        string manifest_hash "reproduction key (EVAL-4)"
        string started_at
        string finished_at
    }
    EVAL_TASK_RESULT {
        string id PK "append-only"
        string run_id FK
        string bench_task_id FK
        string side "A|B"
        int repeat_index "window ordering key (EVP-5)"
        boolean fpar_pass
        int cost_micro_usd
        json check_results
        string raw_ref "transcript artifact"
    }
    VERDICT {
        string id PK
        string run_id FK
        string decision "helps|hurts|no_effect|underpowered (EVT-1)"
        json deltas "fpar/tpac effect sizes + CIs"
        int n
        real alpha
    }
    REPLAY_RECORD {
        string id PK
        string source_session_id FK
        string snapshot_ref
        string config "candidate lockfile hash (EVAL-5)"
        string run_id FK
        string outcome
    }
```

The public **eval ledger** (EVT-3) is a git-tracked file per pack version: `{pack, version, manifest_hash, verdict summary, date}` — reproducible via `EVAL_RUN.manifest_hash`.

### Cross-agent bench (EVP-11)

Bench runs compare agents, not packs, and live in their own tables so a single-config two-agent run can never pollute flakiness windows (keyed per `(task, config)`, EVP-5) and can never reach the ledger (EVP-6/7 read only `eval_run`). Migration 0010 adds both; `bench_task_result` carries the append-only BEFORE UPDATE/DELETE triggers (§2), `bench_run` mirrors `eval_run`'s insert-then-set-`finished_at` shape and carries the verdict inline (no `verdict`-table FK — that table pairs with `eval_run`).

```mermaid
erDiagram
    BENCH_RUN ||--o{ BENCH_TASK_RESULT : produces

    BENCH_RUN {
        string id PK
        string suite_id "suite id + version measured"
        string suite_version
        string executor_candidate "side A agent (EVP-11)"
        string executor_baseline "side B agent"
        string config "single lockfile hash (both agents)"
        int seed
        int repeats
        json model_versions "per-agent model ids + auth_kind marks"
        json sandbox_profile "SEC-3"
        string manifest_hash "reproduction key"
        json verdict "decision + deltas/CIs + n + alpha (EVT-1), set at finish"
        string started_at
        string finished_at
    }
    BENCH_TASK_RESULT {
        string id PK "append-only (triggers)"
        string run_id FK
        string bench_task_id "task id in the measured suite"
        string agent "candidate|baseline"
        int repeat_index
        boolean fpar_pass
        int cost_micro_usd
        json check_results
        string raw_ref "transcript artifact"
    }
```

## 7. Domain: Routing & Signals

Implements PRD §6.3 (RTR-*), §11, §8.1 (PIPE-1).

```mermaid
erDiagram
    AGENT_REGISTRY_ENTRY ||--o{ ROUTING_DECISION : "target of"
    ROUTING_POLICY ||--o{ ROUTING_WEIGHT : "tuned by"
    SIGNAL }o--o{ IDEA : informs

    AGENT_REGISTRY_ENTRY {
        string id PK
        string kind "base_model|subagent|custom_agent"
        json capabilities "domain, language, task_type (RTR-4)"
        string cost_class
        json constraints
    }
    ROUTING_POLICY {
        string pack_version PK "structure lives in the pack file"
        json entries "feature_match -> target, budget, escalation ladder"
    }
    ROUTING_WEIGHT {
        string policy_version PK,FK
        string arm PK
        real weight "ONLY field the online bandit may write (RTR-5; SQL trigger pins keys immutable)"
        string updated_at
    }
    ROUTING_OUTCOME {
        string id PK "append-only bookkeeping for the RPOL-4 promotion trigger"
        string policy_version FK
        string arm
        int outcome "verify-pass 0|1 (EMA input)"
        string at
        int schema_version
    }
    DIVERGENCE_REPORT {
        string id PK "SPEC-4/DSL-7; open reports block build (SPEC-5)"
        string spec_hash
        json clause_ids "suspect clauses"
        json entries "probe input, differing path, both records, redactions"
        boolean resolved
        string at
        int schema_version
    }
    SIGNAL {
        string id PK
        string source
        int contract_schema_version "PIPE-10"
        string kind "deploy_outcome|incident|slo_breach|error_cluster|user_feedback|custom (SIG-1)"
        string severity
        string summary "triage line, max 500 chars"
        json evidence_links
        json affected_artifact_ids
        string dedupe_key "nullable; 24h collapse window"
        int occurrence_count "increments on dedupe collapse"
        json payload "full original document, unknown fields preserved (SIG-1)"
        string triage "backlog|dismissed|linked"
        string received_at
    }
    IDEA {
        string id PK
        string title
        string priority "now|next|later|dismissed (PIPE-1)"
        string priority_rationale "agent-drafted, human-editable (PIPE-1)"
        json signal_ids
        string state "backlog|active|done|dropped"
    }
```

The RTR-5 write-surface rule is structural here: the bandit's entire write access is the `ROUTING_WEIGHT.weight` column; policy *structure* is a pack file changed only via proposals.

## 8. OTel Projection (TEL-6)

| Kelson entity | OTel mapping |
|---|---|
| `SESSION` | Trace (`trace_id` stored on the row) |
| `STEP_EVENT` | Span — attributes: `kelson.sdlc_step`, `kelson.model`, `kelson.effort`, `kelson.agent`, token counts, `kelson.cost_micro_usd`, `kelson.budget.overrun` |
| `INTERVENTION_EVENT`, `DRIFT_EVENT`, routing escalations | Span events on the enclosing step span |
| Metrics | `kelson.fpar`, `kelson.tpac`, `kelson.overhead_ratio`, `kelson.routing.regret`, counters: `kelson.drift.count`, `kelson.interventions.count`, `kelson.eval.gate.{pass,reject}` |

Exporter is OTLP, disabled unless an endpoint is configured; all attributes pass the TEL-3 content-stripping rules (numeric/categorical only — no prompts, paths, or code).

## 9. TypeScript Stack & Package Layout

- **Runtime:** Bun ≥ 1.3, ESM, TypeScript strict (typecheck via `tsc --noEmit`; ADR-0003). Kernel/schemas code stays runtime-agnostic — `Bun.*` APIs only behind a thin sqlite adapter.
- **Monorepo (Bun workspaces):**
  - `packages/schemas` — Zod schemas for every entity above + generated JSON Schema (signal contract, OTel conventions). No dependencies on other packages; everything depends on it.
  - `packages/kernel` — telemetry, eval harness, router, artifact store as internal modules behind one public API; owns SQLite (`bun:sqlite`) and migrations. Never imports `agent` — the api executor is injected via `runEval`'s `extraExecutors` (ADR-0004).
  - `packages/agent` — the native runtime (Phase 6+): AI SDK provider layer (auth, model registry, cost), step loop, core tools, permission engine, session-event store. Depends on kernel + schemas.
  - `packages/cli` — `kelson` command: eval runner, replay engine, index rebuild, agents/loop/route subcommands, chat/run surfaces. Sandboxing lives here (worktree + container drivers). Composition root: wires `apiExecutor` into `runEval`.
  - `packages/cc-plugin` — the Claude Code plugin (skills, hooks, subagents) — the only Claude Code-coupled package (PRD §5.4 migration criteria depend on this boundary).
- **Testing:** `bun test`; fast-check for Kelson's own PBT obligations (the PRD's *Obligation* lines compile into this suite); TLA+ models under `specs/tla/` checked in CI (TLC via container).
- **No ORM:** `bun:sqlite` with hand-written SQL and Zod validation at the boundary; migrations are numbered SQL files applied forward-only (OSS-6).

## 10. Open Questions

1. ~~Repo snapshot mechanism for `snapshot_ref`~~ — resolved: git bundles stored content-addressed under `~/.kelson/snapshots/` ([Eval procedure spec](./2026-07-02-eval-procedure.md) §4).
2. Whether `ROUTING_WEIGHT` needs per-repo partitioning (same policy, different repos) — defer until telemetry shows repo-level divergence.
