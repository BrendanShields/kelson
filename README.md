# Kelson

**A self-improving, token-efficient engineering harness.** Kelson wraps the SDLC from feedback ingestion through build and verification, and gets measurably better at it every session — because every change to its own configuration must pass a built-in eval gate before it applies.

> A *keelson* is the member that binds a ship's frames to its keel — the piece that fastens everything to the spine.

**Status: spec-complete, pre-code.** The full specification suite is written and internally cross-checked; implementation (Phase 0) starts next. The specs are the product right now — read them, poke holes in them.

## The idea

Engineers using coding agents lose value three ways: ambiguous prompts produce rework, tokens burn on the wrong models and bloated context, and every session starts from zero — nobody can answer *"does skill X actually help?"* Kelson attacks all three structurally:

- **Specs that can't be vague.** Work flows through [Kelspec](docs/specs/2026-07-02-kelspec-dsl.md), a constrained DSL where every behavioral claim must compile to an executable obligation (a property-based test or formal-model check). A claim that can't be compiled is rejected before build starts. Divergence testing — two isolated agents implementing the same spec — catches under-specification that compilation can't.
- **A learned router.** Each SDLC step gets the cheapest model, effort level, context loadout, and agent (including your fine-tuned ones) that meets the quality bar; a conservative bandit tunes the policy from verified outcomes.
- **Eval-gated self-improvement.** A postmortem compiler mines each session for friction and proposes configuration diffs. Nothing applies without passing statistical gating (paired bootstrap over benchmark suites + counterfactual replay of your real sessions), and live regressions auto-revert. The loop can never modify the kernel, the eval suites, or its own safety thresholds — the evaluator does not grade its own homework.

Everything the system can change about itself is a versioned, evaluable, revertible **pack**. That makes ablation free: `kelson eval ablate <pack>` answers "is this skill/MCP/agent/rule worth it?" with effect sizes and confidence intervals, not vibes.

**North stars:** First-Pass Acceptance Rate (FPAR ↑) and cost-normalized Tokens per Accepted Change (TPAC ↓).

## Documentation

| Document | Owns |
|---|---|
| [PRD](docs/specs/2026-07-02-agent-harness-prd.md) | Requirements (EARS clauses with executable obligations), metrics, end state, security model, phases |
| [ERD](docs/specs/2026-07-02-agent-harness-erd.md) | Data model, storage tiers, OTel projection |
| [UX & journeys](docs/specs/2026-07-02-agent-harness-ux.md) | Command surface, user journeys, TUI legibility rules |
| [Kelspec DSL](docs/specs/2026-07-02-kelspec-dsl.md) | The spec grammar and compile-to-obligation rules |
| [Pack format](docs/specs/2026-07-02-pack-format.md) | Pack layout, capabilities, signing, lockfile, registry |
| [Eval procedure](docs/specs/2026-07-02-eval-procedure.md) | Benchmark format, replay validity, the gate math |
| [Routing policy](docs/specs/2026-07-02-routing-policy.md) | Policy grammar, feature vector, escalation, bandit rules |
| [Signal contract](docs/specs/2026-07-02-signal-contract.md) | The JSON schema external systems implement to feed the loop |
| [ADRs](docs/adr/) | 0001 language/storage · 0002 no graph DB, no vector RAG · 0003 Bun/OpenTUI tooling |
| [Phase 0 plan](docs/plans/2026-07-02-phase-0-rails.md) | First implementation milestone |

The PRD practices what it preaches: every requirement is an EARS clause carrying an `*Obligation:*` line naming its executable test, enforced by a lint hook in this repo. When the spec compiler exists (Phase 1), the PRD becomes its own first compilation target.

## Stack

TypeScript on **Bun** · [OpenTUI](https://github.com/sst/opentui) terminal UI · `bun:sqlite` + git-tracked files (local-first; SQLite index rebuildable from files) · Zod schemas as single source of truth · fast-check for property-based obligations · TLA+ (TLC in CI) for the self-improvement state machine · OpenTelemetry projection for observability. V1 ships as a Claude Code plugin plus a standalone `kelson` CLI (compiled binary — end users install no runtime). Full rationale in [ADR-0003](docs/adr/0003-runtime-and-tooling.md).

## Roadmap

Walking skeleton first, then deepen — each phase releasable ([PRD §16](docs/specs/2026-07-02-agent-harness-prd.md)):

**0 · Rails** telemetry + traceable artifacts → **1 · Specs that bite** Kelspec compiler, drift detection → **2 · Eval tool** sandboxed runner, statistical gating → **3 · Routing** learned policy, context compiler, budgets → **4 · The loop** postmortem compiler, TLA+-checked self-improvement → **5 · Open source** packaging, pack registry, contribution gate.

## Contributing

Not yet accepting code (pre-Phase-0), but spec review is contribution: file an issue against any clause you can read two ways — ambiguity reports are exactly what this project exists to eliminate. Once the registry opens, community packs merge on evidence: a reproducible eval run showing the pack helps, not maintainer taste.

## License

[MIT](LICENSE)
