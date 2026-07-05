# Spec: Eval Procedure — Benchmarks, Replay & Statistical Gating

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Upstream:** [PRD §6.2, §10, §14.1](./2026-07-02-agent-harness-prd.md) (EVAL-*, EVT-*, SEC-1..3), [ERD §6](./2026-07-02-agent-harness-erd.md). Resolves PRD resolved-question 3 (replay fidelity).
- **Clause family:** `EVP-*`

## 1. Benchmark Task Format (`suites/<suite>/<task-id>/task.yaml`)

```yaml
schema_version: 1
id: greenfield-rate-limiter
statement: >                 # verbatim prompt given to the session under test
  Add per-caller rate limiting to the API per the attached kelspec.
snapshot: sha256:…           # content-addressed repo snapshot (§4)
checks:                      # all must pass for fpar_pass = true
  - kind: obligations        # every kelspec in the workspace compiles (SPEC-1); executing
                             # compiled properties against the impl needs a harness module —
                             # that depth arrives with Phase 3 context compilation. Until then
                             # behavioral verification rides `command` checks (bun test).
  - kind: command            # arbitrary check command, exit 0 = pass
    run: bun test
  - kind: artifact_exists
    path: docs/kelspec/rate-limiter.spec.md
budget_ceiling_musd: 500000  # micro-USD; exceeding = task fail (cost discipline is part of correctness)
timeout_minutes: 30
declared_nondeterminism: []  # observable fields excluded from cross-run comparison
session_command: null        # required only for the command executor (§2.1)
```

- **EVP-1.** The eval runner shall execute each task from its snapshot inside a SEC-1 sandbox, evaluate every check, and record `fpar_pass` (all checks passed within budget and timeout) and `cost_micro_usd` per run.
  *Obligation:* fixture tasks exercising each check kind, each failure class, budget breach, and timeout.

## 2. Run Kinds

- **`ablate <pack> --suite S`** — config A = current lockfile, config B = A with the pack toggled. Paired by task.
- **`compare <lockA> <lockB> --suite S`** — arbitrary paired comparison.
- **`replay --sessions <sel> --config <lock>`** — re-execute real past tasks under a candidate config (§4); scored with the same checks recorded at session time plus obligation results.

Each task runs `repeats` times per side (default 3) with seed derivation `seed_i = H(run_seed, task_id, side, i)` — deterministic from the run manifest, so EVAL-4 reproduction is exact.

### 2.1 Executors

The session under test is produced by a named **executor**, chosen per run and recorded in the run manifest (extends EVAL-4/SEC-3):

| Executor | Session | Cost source |
|---|---|---|
| `claude` | headless Claude Code session receives the task `statement` inside the sandboxed workspace | the session's self-reported total cost (`--output-format json` → `total_cost_usd`, rounded to micro-USD); a zero-exit session with unparseable output is a session failure, never a silent zero-cost pass |
| `command` | the task's `session_command` (task.yaml; required for this executor) runs inside the sandbox | integer micro-USD the command writes to `$KELSON_COST_FILE`, else 0 |
| `api` | the native runtime (`packages/agent`) runs the task `statement` headlessly with the sandbox workspace as its ToolContext (AGT-4) | the session's first-hand StepEvent costs (PROV-3): registry list prices × provider-reported usage; null when the model is unpriced |

`command` exists for fixtures, self-tests (EVAL-1), and CI; it can simulate a session's file mutations and spend deterministically. `cost_micro_usd` equals real spend only under API-key auth: subscription-authenticated sessions consume plan quota and report API-rate-priced tokens (a consistent TPAC yardstick, not dollars) — the same proxy semantics as EVP-8 overrides. Ledger entries (EVT-3) may only be published from `claude`-executor runs — a synthetic session is evidence about the runner, not about a pack.

- **EVP-7.** The eval runner shall execute every task through the run's named executor, record the executor in the run manifest, use the same executor on both sides of a paired run, and refuse ledger publication for runs whose executor is not `claude`.
  *Obligation:* manifest schema validation includes the executor field; a command-executor fixture writing a known micro-USD value to `$KELSON_COST_FILE` yields exactly that `cost_micro_usd` in its task result; ledger generation from a command-executor run is refused with a diagnostic.

**Session model override (cost-free iteration runs).** The `claude` executor may drive an alternate model endpoint (e.g. a local Ollama model via its Anthropic-compatible API) by setting `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL` for the session process. Paired comparisons stay internally valid (both sides run the same model), but two things change: the session's self-reported `total_cost_usd` prices tokens at API rates — a TPAC *proxy*, not spend — and the verdict is evidence about packs *under that model*, not under the operator's default models.

- **EVP-8.** Where a run specifies a session model override, the eval runner shall apply the same override to both sides, record the override in the run manifest (`model_versions.session_model`, and `model_versions.session_base_url` when an endpoint is set), shall withhold operator credentials from sessions pointed at an override endpoint (the API key replaced with a dummy, the OAuth token dropped — SEC-1's auth exception covers the operator's own account, never an arbitrary endpoint), and shall refuse ledger publication for overridden runs.
  *Obligation:* manifest validation — an overridden run's manifest carries `session_model` (and the base URL when given); env-construction test — with real credentials in the parent env and a base-URL override, the session env carries the dummy key and no OAuth token; ledger generation from an overridden run is refused with a diagnostic naming the override.

- **EVP-9.** The eval runner shall resolve a run's executor from its built-in table merged with caller-supplied executors (`extraExecutors` — how the CLI injects the native `api` executor without a kernel→agent dependency), refusing at pre-flight when the named executor is unresolved; the `api` executor shall run under the worktree profile, and under a container profile the runner shall refuse rather than degrade (EVP-2 discipline) until the native runtime's file tools route through the container boundary. EVP-7's ledger fence (non-`claude` runs are never published) covers `api` runs until native cost accounting carries a recorded verification-independence cross-check against provider-reported usage (F-031 rule).
  *Obligation:* e2e — `kelson eval ablate --executor api` on a one-task suite under the worktree profile completes to a verdict and its manifest records `executor: "api"`; the same invocation under a container profile refuses with a diagnostic naming the profile; an unknown executor name refuses at pre-flight; ledger generation from an api-executor run is refused (EVP-7 obligation extended).

### 2.2 Cross-agent bench runs (`kelson bench`)

A **bench run** compares *agents*, not packs: an ordered pair of executors `[candidate, baseline]` (default `[api, claude]`) runs the same suite under one config. It answers "does the native runtime outperform Claude Code on these tasks" — PRD S1 made runnable. Because both sides share one config hash, bench results must never enter the pack-eval tables: a flakiness window pools per `(task, config)` (§6), so two agents' results under one config would corrupt it, and the ledger fence (EVP-7) must stay structural.

- **EVP-11.** When a bench run executes, the runner shall run every non-quarantined suite task × `repeats` per agent from the task's snapshot under the run's single sandbox profile and single config, resolving each agent's executor per EVP-9; the seed for a given (task, repeat) shall be identical across both agents — the §2 derivation with the side component removed, `seed_i = H(run_seed, task_id, i)`, `run_seed` defaulting to 0 as in §2 — and surfaced as `KELSON_SEED`; each session's env also carries `KELSON_BENCH_AGENT` (the agent's executor name), `KELSON_BENCH_REPEAT` (the repeat index), and `KELSON_ENABLED_PACKS` (the run's single config, §2 semantics) — all four identical across sides except `KELSON_BENCH_AGENT`, which differs only when the executor names differ (A/A env stays byte-identical). Results shall persist to the dedicated `bench_run`/`bench_task_result` tables (the latter append-only, its rows mirroring `eval_task_result`'s shape — a failed session is a scored repeat per EVP-1's check semantics, never a distinct status column) — never to `eval_run`/`eval_task_result` — so bench results shall not enter flakiness windows, shall not evaluate new quarantine, and shall be structurally unpublishable to the ledger (EVP-6/7 read only `eval_run`). Tasks already quarantined at run start are excluded and their ids recorded in the manifest. Pairing feeds the §5 gate with the candidate as side A (task-level majority FPAR over repeats, mean cost), and the recorded verdict carries both deltas with CIs, n, α, and B. The bench manifest shall record both executors in order, the sandbox profile, seed, and repeats; when a session model is set (`--model`, applied identically to both agents' session env as `ANTHROPIC_MODEL` — the PRD-S1 same-base-model comparison), the manifest shall record it as `model_versions.session_model`, and a run without one records no model id — an agent whose session does not report its model is recorded as nothing, never guessed (PROV-3 discipline). Subscription-authenticated agents' costs are the §2.1 list-price TPAC yardstick (auth-kind provenance rides the native session telemetry, PROV-6 — the bench manifest does not restate it).
  Divergence-pinned (both blind readers converged, 2026-07-05): an **empty effective task set** (empty suite, or every task quarantined at start) and an **unresolved executor** both refuse at pre-flight writing nothing — no `bench_run` row, no sessions ("a run that measures nothing is a misconfiguration, not a result"; the alternative n=0 `underpowered` run was rejected by both readers). "Majority" is **strict**: `fpar = 1` iff passes `> repeats/2`; "an even split (1-of-2) is fail". A **session error mid-run is a scored result, not a run abort** — the row is appended with the actual partial cost and counts in the mean; "only pre-flight failures and infrastructure errors abort a bench run". **Identical candidate/baseline names are legal** (an A/A calibration run): `KELSON_BENCH_AGENT` carries the executor name on both sides, so A/A env is byte-identical by design and rows are distinguished only by the agent-side column. `bench_run` is inserted after pre-flight and finalized by exactly one terminal write (verdict + `finished_at`); the gate's verdict is relayed verbatim, never overridden. Two reader inventions were re-pinned to existing surfaces (buildability rule): seed derivation follows §2's `taskSeed` shape (readers proposed novel hash encodings), and omitted `run_seed` defaults to 0 (readers proposed random-minting) — §2's convention wins on both.
  *Obligation:* integration — a fixture suite whose `session_command` branches on `KELSON_BENCH_AGENT` to produce hand-known per-agent FPAR/cost yields exactly the hand-computed pairs and gate verdict; the seed env value is equal across agents for each (task, repeat) and differs across repeats; with `--model` set, both agents' session env carries `ANTHROPIC_MODEL` and the manifest records `model_versions.session_model`, and without it the manifest records no model id; a pre-quarantined task is excluded from pairs and named in the manifest; an all-quarantined suite and an unknown executor each refuse pre-flight with zero `bench_run`/`bench_task_result` rows; a 1-of-2 even split scores task FPAR 0 (strict majority); a mid-run session failure appends a scored row and the run still completes to a verdict; `eval_task_result` row count is unchanged by a bench run (flaky windows untouched); an UPDATE against a `bench_task_result` row is refused by trigger; ledger generation cannot name a bench run (its id resolves to no `eval_run` row and is refused).

## 3. Sandbox Profiles (SEC-1..3)

| Profile | Isolation | Network | Used for |
|---|---|---|---|
| `worktree` | detached clone + temp HOME (claude session process alone gets the SEC-1 auth set) | inherit | operator's own suites/replays (minimum, SEC-1) |
| `container` | docker/podman (ADR-0003), no mounts beyond workspace | deny + task allowlist | community suites/packs, CI, anything not operator-authored |

Profile is recorded in the run manifest (SEC-3). If `container` is required but unavailable, the run **refuses** (it does not degrade — degradation is only for the harness's own ambient behavior, KERN-1, never for the security boundary).

- **EVP-2.** If a run requires the `container` profile and no container runtime is available, then the eval runner shall refuse the run with a diagnostic, not fall back to `worktree`.
  *Obligation:* integration test with docker/podman absent from PATH.

## 4. Replay Fidelity (resolves PRD question 3)

**Snapshot:** at session start the cc-plugin records a git bundle of the repo (all refs + working-tree diff) stored content-addressed under `~/.kelson/snapshots/`, plus an **environment manifest**: kelson version, lockfile hash, model IDs + versions used, Bun version, OS, and declared tool versions (from `kelson doctor`).

**Validity rules — a replay may feed a gate (EVAL-5) only if:**
1. The snapshot bundle restores bit-identically (hash check), and
2. Model IDs in the candidate run match the original **or** the run is explicitly marked `cross-model` (cross-model replays inform, never gate), and
3. The original session was `complete` (not `incomplete`/`degraded`, TEL-5/KERN-1).

Replays that fail validity are labeled `advisory` in the verdict and excluded from gate math.

- **EVP-3.** The replay engine shall enforce the three validity rules and shall exclude `advisory` replays from any gating computation while still reporting them.
  *Obligation:* one fixture per rule violation — each lands in `advisory`, none reaches the gate aggregate.

## 5. Statistical Gate (the normative math for EVAL-2)

Given paired per-task results (A = with candidate, B = without). **The gate always evaluates the candidate configuration as side A**: when a stored run's sides are reversed relative to the candidate diff (a disable proposal gated by an enabled-vs-disabled ablate), the paired results are side-swapped before the decision table applies — verdict labels on the pack are never reinterpreted directionally, because `hurts` means inferior on *either* metric and carries no information about which.

1. **Metrics:** task-level FPAR (0/1, majority over repeats) and cost (mean micro-USD over repeats).
2. **Test:** paired bootstrap, **B = 10,000 resamples**, two-sided **α = 0.05**, on mean difference for each metric.
3. **Non-inferiority margins:** FPAR: candidate mean not worse than −2 percentage points at the 95% CI lower bound. TPAC/cost: not worse than +5% at the 95% CI upper bound.
4. **Minimum sample:** **n ≥ 20 paired tasks** by default (after quarantine exclusions). A suite may configure its own minimum (`suite.yaml` `min_sample`), **never below 6** — a hard schema floor; configuring below the default is the human gate-owner's recorded acceptance of reduced detection power at the §5 margins and must carry a findings/decision row. Below the configured minimum: verdict = `underpowered`, always rejected for gating, with the deficit reported (UX J3).
5. **Decision table:**

| FPAR | Cost | Verdict |
|---|---|---|
| non-inferior + improved | non-inferior | `helps` |
| non-inferior | non-inferior + improved | `helps` |
| non-inferior | non-inferior (neither improved) | `no_effect` (rejected — a change must earn its place) |
| inferior on either | — | `hurts` |
| n < 20 | — | `underpowered` |

"Improved" = 95% CI for the difference excludes zero in the good direction.

### 5.1 Replay Decision Rule (normative for EVAL-5 — distinct from the benchmark gate)

Replays pair each replayed task against **its own original recorded outcome** (not an A/B side): same checks, same budget ceiling. Apply the §5 non-inferiority margins to the paired differences with a replay-specific minimum **n ≥ 10 valid replays** (matching EVAL-5's default sample; benchmark n ≥ 20 does not apply here). Verdict `underpowered` (fewer than 10 valid, post-§4-validity) or `hurts` → the diff is not eligible for auto-apply; replay is a veto stage, so `no_effect` **passes** (the benchmark stage already established improvement — replay only has to prove no real-work regression).

- **EVP-4.** The gate implementation shall reproduce this decision table exactly, and the §5.1 replay rule with its distinct minimum and veto semantics; verdicts shall include both deltas with their CIs, n, α, and B.
  *Obligation:* statistical unit tests with synthetic distributions per table row (extends EVAL-2's ±2% error-rate obligation); property test — verdict is a pure function of the paired-results multiset (order-invariant).

## 6. Flakiness Quarantine (normative for EVAL-3)

A task's flakiness window is its most recent **K = 5 results per (task, config lockfile hash)**, pooled across suite runs — sides are evaluated independently (never mixed), and a single run contributes `repeats` results (default 3) to the window. A task is **flaky** when a full window holds mixed results with minority count ≥ 2. Config keys: `eval.flaky.k` (5), `eval.flaky.min_minority` (2). Quarantine is automatic, logged, and sticky until `kelson eval suite promote` (human) re-admits it.

- **EVP-5.** The flakiness detector shall evaluate the window rule on every suite run, pooling per (task, config) across runs, and shall move matching tasks to quarantine before gate math executes.
  *Obligation:* deterministic-flaky fixture (seeded 50% pass) quarantined as soon as its window fills (the second suite run at default repeats); stable fixtures never quarantined across 100 runs; sides never pool together; two suite runs sharing a wall-clock `started_at` compose the window by insertion order (`rowid`), never by timestamp — window membership is deterministic under a millisecond tie.

## 7. Ledger Entry Format (`ledger/<pack>/<version>.json` in the registry)

```json
{
  "schema_version": 1, "pack": "ponytail", "version": "1.2.0",
  "run_manifest_hash": "sha256:…", "suite": "seed@3",
  "verdict": "helps",
  "fpar_delta": { "mean": 0.07, "ci95": [0.02, 0.12] },
  "cost_delta_pct": { "mean": -11.0, "ci95": [-17.0, -5.0] },
  "n": 24, "date": "2026-07-02"
}
```

- **EVP-6.** Ledger entries shall be generated only by the eval runner from a completed run (never hand-authored), and registry CI shall verify the entry's fields against the run manifest it names.
  *Obligation:* CI fixture — a hand-edited delta fails verification against its manifest.
