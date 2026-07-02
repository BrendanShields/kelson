# The Safety & Self-Improvement Model

Kelson changes its own configuration. This page is the operator's contract for how that stays safe (PRD §9).

## One mechanism for all self-change

Everything the system can change about itself is a versioned, evaluable, revertible **pack**, and one pipeline governs every change:

```
propose (evidence-linked) → gate (statistics) → apply (revertible) → monitor → stable | auto-revert → quarantine
```

The proposal state machine is specified in TLA+ (`specs/tla/KelsonLoop.tla`) and model-checked in CI for: gate soundness (nothing applies without approval, I1), bounded monitoring concurrency (I2, so regressions stay attributable), and revert liveness (I3). The implementation's transition table is conformance-tested against the model (LOOP-5).

## What the loop can never touch (LOOP-4)

The loop has **no write path** to: kernel code/config, gating eval suites, its own state-machine spec, or the safety thresholds. This is a write ACL at the kernel boundary with audited rejections — not a prompt instruction. The loop may *propose new benchmark tasks*, but they enter a non-gating staging suite and join a gate only by human promotion (LOOP-6).

## The gate is statistics, not vibes (EVAL-2, EVP §5)

Paired bootstrap over a benchmark suite; non-inferiority on both north-star metrics plus improvement on at least one; below the configured minimum sample, the verdict is `underpowered` and **always rejected** — never "probably fine". The gate evaluates the candidate configuration as side A (verdict labels are never reinterpreted directionally), and counterfactual replay of real sessions (EVAL-5) can veto auto-application even when benchmarks pass.

## After apply: monitoring and auto-revert (LOOP-3/LOOP-9)

Every applied diff opens a monitoring window (14 days or 30 sessions, whichever is later) against a frozen pre-apply baseline. A statistically significant regression beyond the thresholds auto-reverts and quarantines the diff. With multiple monitored diffs, attribution isolates the culprit via the inter-apply session stratum; when indistinguishable, the last-applied reverts first — one revert per window, never all at once. Quarantine blocks re-proposal by id *and content hash*; the only exit is explicit human release back to the start of the pipeline.

## The audit trail is monotone (I5, PACK-5)

Every apply and revert appends to `.kelson/changelog.jsonl` — the writer refuses anything but `seq = last + 1`, and CI fails any history rewrite against the merge base. Every state transition, evidence check, and monitor decision is an append-only event row. Sessions pin their lockfile hash at start (LOOP-7), so every telemetry event attributes to exactly one configuration.

## The human's two jobs

Author/approve specs, and govern the gates. Everything between a confirmed spec and a verified change is agent work — but a loop-originated proposal approves only on a passing gate basis or a recorded human override that names what it overrides (LOOP-2).
