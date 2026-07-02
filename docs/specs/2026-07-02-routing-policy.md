# Spec: Routing Policy & Agent Registry

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Upstream:** [PRD §6.3, §11, §12.4](./2026-07-02-agent-harness-prd.md) (RTR-1..5, CTX-4), [ERD §7](./2026-07-02-agent-harness-erd.md)
- **Clause family:** `RPOL-*`

## 1. Policy File (`routing/policy.yaml` inside a routing pack)

```yaml
schema_version: 1
rules:                        # first match wins, top to bottom
  - match: { step: build, tier: T0, task_type: mechanical }
    target: small             # agent-registry id (cost_class 1)
    effort: low
    loadout: [efficiency-core]        # pack names to load for this step
    budget_tokens: 8000
    escalation: [mid-tier, frontier]  # ordered ladder for RTR-2
  - match: { step: build, tier: T0 }
    target: mid-tier
    effort: medium
    loadout: [efficiency-core]
    budget_tokens: 20000
    escalation: [frontier]
  - match: { step: spec }             # unmatched fields = wildcard
    target: frontier
    effort: high
    loadout: [spec-tooling]
    budget_tokens: 40000
    escalation: []
default:                      # required — total function over feature space
  target: mid-tier
  effort: medium
  loadout: []
  budget_tokens: 20000
  escalation: [frontier]
```

- **RPOL-1.** The router shall resolve every feature vector by first-match over `rules` falling through to `default`, so routing is total and deterministic given (policy version, feature vector, weights snapshot).
  *Obligation:* PBT — for any generated feature vector, resolution returns exactly one rule; identical inputs give identical decisions.

## 2. Feature Vector (normative definitions)

| Feature | Values | Definition |
|---|---|---|
| `step` | the six SDLC steps | the explicitly-entered stage (UX interaction model) |
| `tier` | T0/T1/T2 | max criticality tier among spec clauses the task touches (PRD §7.4); touching no clause-governed logic → T0 (no criticality floor exists to inherit) |
| `size` | S/M/L | files the task's plan expects to touch: S ≤ 2, M ≤ 10, L > 10; unknown → M |
| `lang` | primary language id | dominant language of touched files by count; ties → repo primary |
| `novelty` | 0..1, bucketed low (<0.3) / mid / high (>0.7) | 1 − max Jaccard similarity between the task's **planned** touched-file set (same set `size` uses, fixed at routing time) and each of the last 200 tasks' **actual** touched sets recorded at task close in this repo; no history → 1 |
| `task_type` | `standard` \| `mechanical` | `mechanical` = the step's plan touches no clause-governed logic: renames, formatting, lockfile/changelog writes, comment/doc-only edits; anything else → `standard` |
| `repo` | repo id | identity, for policy partitioning |

- **RPOL-2.** The feature extractor shall compute every feature per this table, record the vector on the RoutingDecision (RTR-1), and use the declared fallbacks (`unknown → M`, `no history → 1`, `task_type` unknown → `standard`) rather than failing.
  *Obligation:* unit matrix per feature including fallback cases; Jaccard novelty verified against hand-computed fixtures.

## 3. Escalation (normative for RTR-2, CTX-4)

One verification failure at the routed target → retry once at the next ladder entry (regret event recorded). **Cap: 2 escalations per step**; a step failing at the top of its ladder pauses for triage using the CTX-4 panel (continue / escalate manually / re-spec). Budgets travel with the rule; an escalated retry gets the escalated rule's budget, not the original's. Ladder entries are *targets*, so the escalated budget derives as: the first policy rule whose target equals the escalated target **and** whose match accepts the step's feature vector; else the first rule owning that target regardless of match; else the default when it owns the target; else the previous attempt's budget.

- **RPOL-3.** The router shall cap automatic escalations at 2 per step and shall route a third failure to the CTX-4 triage pause rather than a further retry.
  *Obligation:* integration test — three injected failures produce exactly two escalations, two regret events, one pause.

### 3.1 Triage semantics (pins the CTX-4 divergence-test split)

Budget thresholds are checked at each accounting point (a model call completing): the `1×` overrun fires when usage strictly exceeds the budget (`used > budget`, matching CTX-4's "exceeds"); the `2×` pause fires inclusively (`used >= 2×budget`); overshoot past a threshold is recorded honestly, never clamped. `1×` is record-and-continue, latched once per attempt; a burst crossing both thresholds emits the `1×` then the `2×` overrun event in one append, then the pause. The pause is durable state (`paused_triage`), not a blocked thread. `continue` grants exactly one further budget of headroom (next pause at `used_at_resolution + budget`). Headless runs resolve the pause immediately by policy: `escalate` while under the RPOL-3 cap, else transition to durable state `blocked` (resumable by an operator, recorded with `actor: "auto"`); a headless step never hangs and never silently burns on. Overrun attribution minimally carries `{task_id, step_id, attempt, rule_id, policy_hash, model_id, escalation_depth, budget_tokens, used_tokens, ratio}`. Escalation resets the usage counter and threshold latches (attempt-scoped); the escalation count is step-scoped and never resets.

- **RPOL-6.** The budget monitor shall implement §3.1 exactly: latched per-attempt threshold events, durable pause, one-budget `continue` headroom, the headless escalate-then-block default under the RPOL-3 cap, and the minimal attribution set on every overrun event.
  *Obligation:* integration matrix — burst crossing both thresholds yields exactly two overrun events + one pause; `continue` re-pauses at one further budget; headless resolution escalates under cap and blocks at cap with `actor: "auto"` recorded; attribution fields present on every overrun event.

## 4. Online Learning (normative for RTR-5; bounded by RTR-3)

- **Algorithm: ε-greedy, ε = 0.05**, applied only where **all** hold: tier is T0, an exploration candidate exists, and the candidate is **cheaper** than the exploit arm. An **exploration candidate** is a registry entry eligible for the rule's step whose cost_class is exactly one below the exploit target's — the escalation ladder is *not* the exploration set (ladders order upward; exploration only probes downward). Exploration randomness derives from the step-event ULID (reproducible from telemetry; no wall-clock RNG).
- **Weight update:** per (rule, arm), exponential moving average of verify-pass with **α = 0.1**: `w ← (1−α)·w + α·outcome`; weights initialize to **w₀ = 0.5** for every arm, and the promotion trigger below requires ≥ 50 recorded outcomes on *both* arms (cold-start weights never trigger proposals). Weights live in SQLite (`ROUTING_WEIGHT`, the bandit's only write surface); an arm whose weight exceeds the incumbent's by > 0.1 for 50 consecutive tasks (both arms having ≥ 50 outcomes) becomes a loop *proposal* to change the rule's target — the structural change still passes the gate (RTR-5).
- ε-greedy over Thompson sampling: two tunables and an if-statement, auditable in telemetry, and the safety constraints (downward-only, T0-only) do the real risk work — posterior sophistication buys little here.

- **RPOL-4.** The online updater shall explore only under the three conditions above, derive exploration decisions from the step-event ULID, and write nothing but `ROUTING_WEIGHT.weight`.
  *Obligation:* PBT (extends RTR-3's) — generated decision streams never explore on T1+/non-cheaper/single-candidate cases; replaying ULIDs reproduces decisions; schema test pins the write surface.

## 5. Agent Registry Entry (`agents/<id>.yaml` in an agent_registry pack)

```yaml
schema_version: 1
id: payments-migrator
kind: custom_agent            # base_model|subagent|custom_agent
capabilities:
  - { domain: payments, lang: typescript }
cost_class: 3                 # ordinal, 1 = cheapest; ladders sort by this
constraints: { max_context_tokens: 200000 }
endpoint: { type: claude_subagent, ref: agents/payments-migrator.md }
```

Capability matching (RTR-4): a task matches an agent when every declared capability field that the agent specifies equals the task's feature/domain value; among matches, most fields specified wins; ties → lower cost_class; no match → `default` rule target.

- **RPOL-5.** The registry loader shall validate entries against the schema, and capability matching shall implement exactly the most-specific-wins / cost-tiebreak / default-fallback order above.
  *Obligation:* unit matrix (extends RTR-4's): match, multi-match specificity, cost tie, no-match fallback.

## 6. Default Policy Shipped in V1 (PRD §11, made concrete)

| step | tier | target (effort) | budget_tokens |
|---|---|---|---|
| ideation, planning, spec | any | frontier (high) | 40,000 |
| build | T1+ | frontier (high) | 40,000 |
| build | T0 | mid-tier (medium) | 20,000 |
| verify | any | mid-tier (medium), escalate frontier | 20,000 |
| any step with `task_type: mechanical` | T0 | small (low) | 8,000 |

Concrete model IDs live in the default routing pack (data, not spec) so model generations rotate without spec edits. These budgets are the CTX-4 defaults; the loop tunes them through the gate.
