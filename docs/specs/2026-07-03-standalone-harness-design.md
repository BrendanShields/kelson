# Design: Kelson Standalone Harness — Native Agent Runtime

Status: approved design (brainstorm output, 2026-07-03). Formal AGT-*/PERM-*/SES-*/PROV-*
clauses land via feature-pipeline/spec-sync per phase; this document records the
decisions, architecture, and phase plan.

## Context

All six PRD phases are complete, but nothing in the repo calls an LLM API directly —
every session is mediated through spawning `claude -p` (the `claude` executor in
`kernel/src/evaltask.ts`) or the cc-plugin hooks. This project makes Kelson a full
standalone harness: its own agent loop calling LLM APIs directly, with Claude Code
remaining a supported executor/integration among peers.

Reference points researched during brainstorm: **Pi** (badlogic/pi-mono — minimal
loop, tree-structured branching sessions, subscription OAuth) and **OpenCode**
(sst/opencode — server-first, AI SDK + Models.dev provider layer, allow/ask/deny
permissions).

Decisions made during brainstorm:

- Own agent loop; Claude Code stays as one executor among peers.
- Identity: spec-first SDLC harness — the coding agent is the substrate, not the pitch.
- LLM layer: **Vercel AI SDK** (OpenCode's approach) — no hand-rolled provider client.
  Providers v1: Anthropic (API key + Claude Pro/Max subscription OAuth via custom
  fetch), Ollama and any OpenAI-compatible endpoint via `@ai-sdk/openai-compatible`.
- Primary surface v1: interactive TUI chat (OpenTUI) plus `kelson run -p` headless
  print mode.
- Permissions: allow/ask/deny wildcard rules, per-agent overrides, composing with
  existing sandbox profiles.
- Structure: one new package — `packages/agent`.
- Four differentiators in scope: spec-native loop, live routing + budgets,
  every-session-is-an-eval, tree sessions + counterfactual replay.

## Architecture

### Dependency graph

```
schemas (unchanged, no deps)
  ▲            ▲
kernel      cc-plugin, ui (unchanged)
  ▲
agent  (→ kernel + AI SDK packages)
  ▲
 cli  (composition root)
```

**Executor inversion solved by injection:** kernel keeps `ExecutorFn`/`EXECUTORS`
(`evaltask.ts`); `Executor` enum gains `"api"`; `runEval` gains an optional
`extraExecutors` param; `packages/agent` exports `apiExecutor`; cli wires
`{ api: apiExecutor }`. No kernel→agent edge, no registry singleton. Ripple:
`ExecutorFn` return becomes `SessionOutcome | Promise<SessionOutcome>`, `runEval`
goes async (mechanical, typechecker-enumerated).

### LLM layer — AI SDK, plus the three things it doesn't give us

AI SDK provides: streaming (`streamText().fullStream` typed parts), provider adapters
(`@ai-sdk/anthropic`; `@ai-sdk/openai-compatible` covers Ollama/OpenRouter/etc.),
tool definitions with Zod schemas, usage reporting (incl. cache token classes), abort
signals, retries. Versions come from the registry at implementation time, never from
memory (repo rule).

Hand-built only (`packages/agent/src/llm/`):

- `auth.ts` — `~/.kelson/auth.json` (0600); `api_key | oauth{access, refresh,
  expires}`; PKCE flow for Claude Pro/Max; single-flight refresh; injected into the
  Anthropic provider via custom `fetch`/headers; env-var fallback. `kelson auth login
  <provider>`. Highest external risk (unofficial flow) — isolated entirely here; API
  key always the fallback.
- `registry.ts` — shipped `models.json` + user overlay `~/.kelson/models.json`:
  context window, capabilities, prices in micro-USD ints; `costOf(usage, model)`.
  Subscription sessions compute counterfactual cost, marked `priced_as: "list"`.
  Routing's `AgentRegistryEntry.endpoint.ref` resolves against this.
- `resolve.ts` — model string → configured AI SDK provider instance.

**Loop control stays ours:** one `streamText` call per step (no AI SDK
multi-step/`stopWhen`) — per-step routing, budget pauses, and permission asks need
the loop to be Kelson's, not the SDK's.

### packages/agent

- **Session store:** new append-only `session_event` table (ULID id, `parent_id`
  chain → tree; forks = shared parent). Head pointer is itself an event
  (`head_moved`) — no UPDATE, head derived by rowid (repo convention). Reuses kernel
  `startSession`/`endSession`. Persisted shapes (session events, permission rules,
  model registry entries) get Zod schemas in `packages/schemas`.
- **Loop:** `step()` = exactly one assistant turn (reconstruct context → route →
  `streamText` → execute tool calls through permissions), returning
  `continue | done | paused` — budget/permission pauses are return values, durable
  and resumable. Thin `runTurn` driver shared by TUI, `run -p`, and `apiExecutor`.
  Each step = TEL-1 step boundary, so native telemetry matches transcript-parsed
  telemetry by construction.
- **Tools:** the Pi seven (read/write/edit/bash/grep/find/ls) as AI SDK tool
  definitions with Zod params, execution routed through the permission engine, not
  the SDK's auto-execute. `ToolContext` receives `cwd`/`exec` from the caller, so
  eval runs execute inside `sandbox.ts` workspaces with zero new isolation code.
- **Permissions:** ordered `{tool glob, arg glob, allow|ask|deny}` rules in
  `.kelson/permissions.json` (JSON, not YAML — no YAML dependency for a rules list); most-specific wins; per-agent overrides; "always allow"
  answers append session-scoped rules as events. Headless: ask→deny unless flagged.
- **Compaction:** summarize-turn on a cheap routed model, appended as a `compaction`
  event; forks before it retain full history.

### The four differentiators (hook points in `step()`)

1. **Spec-native loop** (`agent/src/spec.ts`): SpecContext loaded via kernel
   `compileSpec`; runtime blocks T1+ writes with no governing clause (ART-4,
   human-overridable); touched clauses' obligation tests run post-step (cached by
   file hash, trace-link scoped); `done` refused while obligations fail; built-in
   clause-auditor agent emits a `VerificationReport` as the final gate.
2. **Live routing + budgets:** per-step `extractFeatures` → `route()` picks the model
   for *this step*; `BudgetMonitor` records each finish, pausing at 2× for triage
   (continue/escalate/re-spec); obligation failure triggers `escalate()`; bandit
   exploration on T0 steps. Kernel modules reused unchanged.
3. **Every session is an eval:** session start writes a git-bundle snapshot;
   `kelson promote <session>` compiles a BenchmarkTask (statement = first user
   message, checks = touched obligations, budget = actual×1.5) into the **staging**
   suite; replay = existing `runEval` with `executor: "api"`.
4. **Tree sessions + replay:** `/tree` and `/fork [event-id]` over the parent_id DAG;
   `kelson session compare <headA> <headB>` diffs branch cost/outcomes; headless
   branch replay (`resumeFrom: eventId`) lands last.

### TUI chat (packages/cli)

Launcher's proven pattern: pure reducer (`chat/model.ts`, obligation-testable
headlessly) + thin OpenTUI shell (`chat/app.ts`). Header (model · branch · cost
ticker), streaming transcript, permission/triage/model-picker overlays reusing
`SelectRenderable`. Slash commands dispatch through the same functions as CLI
commands (F-085 operator-surface lesson): `/model /tree /fork /compact /promote
/spec /route /budget /sessions /help`. New `COMMANDS`: `chat`, `run`. Fallback
hedge: the pure model makes a plain stdout REPL a one-file swap if OpenTUI fights
streaming reflow.

### Coexistence with Claude Code

cc-plugin and the `claude` executor stay untouched. Telemetry unifies on
`StepEvent`: the CC path stays post-hoc transcript parsing; the native path calls
`safeIngest` live at each step finish with first-hand usage/cost. One additive
column: `session.runner: "cc" | "native"`. The EVP ledger admits `api` runs only
after a spec change + a verification-independence cross-check of native cost math
against provider-reported usage (F-031 lesson).

## Phases (continuing PRD §16; each independently shippable, spec-first)

| Phase | Content | Exit criteria | Spec work |
|---|---|---|---|
| **6 Walking skeleton** | agent package (AI SDK wiring for Anthropic key + Ollama, step loop, 7 tools, minimal permissions, linear sessions on tree schema, cost registry), `kelson chat` + `kelson run -p` | Chat edits a real file; StepEvents land first-hand with correct micro-USD; `run -p --json` scripts | New spec doc: `agent-runtime.md` (AGT-*, PERM-*, SES-*, PROV-*); UX amendment |
| **7 Executor + auth breadth** | Async ExecutorFn + injection, `"api"` executor, Claude sub OAuth + refresh, model registry overlay + `/model`, `session.runner` | `eval ablate --executor api` completes seed suite sandboxed; OAuth refresh survives expiry fixture | EVP amendments (api validity, ledger), PROV OAuth clauses |
| **8 Spec-native loop** | SpecContext, in-loop obligation runs, done-condition, clause-auditor gate, ART-4 runtime block | Planted violation blocks `done`; spec-less T1 build blocked; auditor emits VerificationReport | AGT spec-loop clauses; discharge PIPE-7/ART-4 against native runtime |
| **9 Live routing + budget** | Per-step route/escalate, in-loop BudgetMonitor, triage UI, T0 bandit | Mechanical steps visibly route cheap; runaway fixture pauses at 2× with triage | New obligations on existing RTR-*/RPOL-*/CTX-4; routing-policy live-features amendment |
| **10 Tree + session→eval** | /tree /fork, compaction, /promote, branch compare, resumeFrom replay | Fork mid-session, compare branches; promote a session and replay under toggled lockfile to a verdict | SES tree/fork clauses; EVP promotion clauses |

## Hardest decisions (settled)

1. Provider layer → AI SDK, not hand-rolled: the SDK covers
   streaming/adapters/tools/usage; Kelson owns only auth (OAuth), pricing registry,
   and loop control (one `streamText` per step, never SDK multi-step).
2. Executor inversion → injection param on `runEval` (not kernel→agent edge, not a
   global registry).
3. Sync→async `ExecutorFn` → make `runEval` async; ripple is mechanical.
4. Tree representation → `head_moved` events, head derived by rowid (append-only
   convention, F-060/F-067).
5. Claude subscription OAuth → highest external risk; isolated in `auth.ts` + custom
   fetch; API key always the fallback; ledger evidence never depends on subscription
   runs.
6. In-loop obligation cost → touched-clauses-only + hash-keyed cache; EVAL-7
   overhead cap is the backstop.
7. OpenTUI maturity → pure-model/thin-shell from day one; `run -p` is the
   guaranteed-working surface every phase.

## Verification

- Each phase's exit criteria are end-to-end checks run through the operator-facing
  surface (`kelson chat`, `kelson run -p`, `kelson eval ablate --executor api`).
- Walking-skeleton smoke test: one real session against Ollama (free) end-to-end
  before any Anthropic-quota run.
- Native cost accounting cross-checked against provider-reported usage before ledger
  admission (verification-independence rule).
- AI SDK versions and package names verified against the npm registry at
  implementation time, never written from memory.
