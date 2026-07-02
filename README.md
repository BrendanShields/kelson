# Kelson

**A self-improving, token-efficient engineering harness.** Kelson wraps the SDLC from feedback ingestion through build and verification, and gets measurably better at it every session — because every change to its own configuration must pass a built-in eval gate before it applies.

> A *keelson* is the member that binds a ship's frames to its keel — the piece that fastens everything to the spine.

**Status: Phases 0–5 implemented, pre-release.** Kernel, eval runner, router, self-improvement loop, and supply-chain machinery are built with every behavioral clause discharged by an obligation test (`packages/*/test/obligations/<CLAUSE-ID>.test.ts`). Nothing is published to npm or hosted anywhere yet; this repository is the source of truth.

## The idea

Engineers using coding agents lose value three ways: ambiguous prompts produce rework, tokens burn on the wrong models and bloated context, and every session starts from zero — nobody can answer *"does skill X actually help?"* Kelson attacks all three structurally:

- **Specs that can't be vague.** Work flows through [Kelspec](docs/specs/2026-07-02-kelspec-dsl.md), a constrained DSL where every behavioral claim must compile to an executable obligation (a property-based test or formal-model check). A claim that can't be compiled is rejected before build starts. Divergence testing — two isolated agents implementing the same spec — catches under-specification that compilation can't.
- **A learned router.** Each SDLC step gets the cheapest model, effort level, context loadout, and agent (including your fine-tuned ones) that meets the quality bar; a conservative bandit (T0-only, downward-only exploration) tunes the policy from verified outcomes.
- **Eval-gated self-improvement.** A postmortem compiler mines each session for friction and proposes configuration diffs with machine-checkable evidence links. Nothing applies without passing statistical gating (paired bootstrap over benchmark suites + counterfactual replay of your real sessions), and live regressions auto-revert. The loop can never modify the kernel, the gating suites, or its own safety thresholds — the evaluator does not grade its own homework. The state machine is specified in TLA+ and model-checked in CI.

## Quickstart (greenfield, < 30 minutes)

<!-- quickstart-ci: the docs CI executes exactly these commands -->

```bash
# 1. Install (from a checkout, until the npm release)
bun install

# 2. Initialize a project — creates .kelson/, a starter lockfile, and layers
#    Claude Code hooks non-destructively
bun packages/cli/src/index.ts init

# 3. See how a step would route (model, effort, budget, escalation ladder)
bun packages/cli/src/index.ts route explain --step build --tier T0 --task-type mechanical

# 4. Ask the improvement loop what it would change (proposals need evidence)
bun packages/cli/src/index.ts loop propose
bun packages/cli/src/index.ts loop status
```

From there: write a kelspec (`docs/kelspec/<component>.spec.md`) and the compiler turns every clause into an executable obligation, every domain into a property-based generator, and every T1+ invariant into a runtime probe plus a TLA+ CI obligation.

## The distinctive mechanic: evidence over taste

Every togglable piece of configuration — skills, rules, routing tables, agents — is a **pack**, pinned in `kelson.lock`. Packs earn their place with `kelson eval ablate <pack>`: a paired, sandboxed, statistically-gated A/B over a benchmark suite, producing a four-way verdict (`helps / hurts / no_effect / underpowered`) with effect sizes and confidence intervals — never a bare pass/fail. Community packs merge on reproducible eval evidence (OSS-4), not maintainer taste; results live in the in-repo [ledger](ledger/).

## Documentation

- [Privacy policy](docs/PRIVACY.md) — local-first; shared telemetry is structurally free-text-free
- [Pack author guide](docs/guides/pack-author.md)
- [Safety & self-improvement model](docs/guides/safety-model.md)
- [Brownfield adoption](docs/guides/brownfield.md)
- Spec suite: `docs/specs/` — the PRD/ERD/DSL documents are the system's contract

## Development

```bash
bun install
bun run gates   # doctor → spec-lint → kelspec-lint → typecheck → biome → test
```

CI runs exactly `bun run gates`, plus TLC model-checking of the loop state machine, the changelog append-only check, and the pack contribution gate.

## License

Apache-2.0
