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
  - kind: obligations        # compiled kelspec obligations must pass
  - kind: command            # arbitrary check command, exit 0 = pass
    run: bun test
  - kind: artifact_exists
    path: docs/kelspec/rate-limiter.spec.md
budget_ceiling_musd: 500000  # micro-USD; exceeding = task fail (cost discipline is part of correctness)
timeout_minutes: 30
declared_nondeterminism: []  # observable fields excluded from cross-run comparison
```

- **EVP-1.** The eval runner shall execute each task from its snapshot inside a SEC-1 sandbox, evaluate every check, and record `fpar_pass` (all checks passed within budget and timeout) and `cost_micro_usd` per run.
  *Obligation:* fixture tasks exercising each check kind, each failure class, budget breach, and timeout.

## 2. Run Kinds

- **`ablate <pack> --suite S`** — config A = current lockfile, config B = A with the pack toggled. Paired by task.
- **`compare <lockA> <lockB> --suite S`** — arbitrary paired comparison.
- **`replay --sessions <sel> --config <lock>`** — re-execute real past tasks under a candidate config (§4); scored with the same checks recorded at session time plus obligation results.

Each task runs `repeats` times per side (default 3) with seed derivation `seed_i = H(run_seed, task_id, side, i)` — deterministic from the run manifest, so EVAL-4 reproduction is exact.

## 3. Sandbox Profiles (SEC-1..3)

| Profile | Isolation | Network | Used for |
|---|---|---|---|
| `worktree` | git worktree + temp HOME | inherit | operator's own suites/replays (minimum, SEC-1) |
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

Given paired per-task results (A = with candidate, B = without):

1. **Metrics:** task-level FPAR (0/1, majority over repeats) and cost (mean micro-USD over repeats).
2. **Test:** paired bootstrap, **B = 10,000 resamples**, two-sided **α = 0.05**, on mean difference for each metric.
3. **Non-inferiority margins:** FPAR: candidate mean not worse than −2 percentage points at the 95% CI lower bound. TPAC/cost: not worse than +5% at the 95% CI upper bound.
4. **Minimum sample:** **n ≥ 20 paired tasks** (after quarantine exclusions). Below n: verdict = `underpowered`, always rejected for gating, with the deficit reported (UX J3).
5. **Decision table:**

| FPAR | Cost | Verdict |
|---|---|---|
| non-inferior + improved | non-inferior | `helps` |
| non-inferior | non-inferior + improved | `helps` |
| non-inferior | non-inferior (neither improved) | `no_effect` (rejected — a change must earn its place) |
| inferior on either | — | `hurts` |
| n < 20 | — | `underpowered` |

"Improved" = 95% CI for the difference excludes zero in the good direction.

- **EVP-4.** The gate implementation shall reproduce this decision table exactly; verdicts shall include both deltas with their CIs, n, α, and B.
  *Obligation:* statistical unit tests with synthetic distributions per table row (extends EVAL-2's ±2% error-rate obligation); property test — verdict is a pure function of the paired-results multiset (order-invariant).

## 6. Flakiness Quarantine (normative for EVAL-3)

A task is **flaky** when, across K = 5 runs under one identical config, pass results are mixed with minority count ≥ 2 (i.e., pass rate in [0.4, 0.6] band) — outcome variance that can't be attributed to the config. Quarantine is automatic, logged, and sticky until `kelson eval suite promote` (human) re-admits it.

- **EVP-5.** The flakiness detector shall evaluate the K-run rule on every suite run and shall move matching tasks to quarantine before gate math executes.
  *Obligation:* deterministic-flaky fixture (seeded 50% pass) quarantined within one suite run; stable fixtures never quarantined across 100 runs.

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
