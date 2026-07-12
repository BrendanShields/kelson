# Design: Chat Cockpit — panes, GenUI, living surface

Status: approved design (brainstorm 2026-07-12); clauses land per-slice via
feature-pipeline. Consolidates ui-uplift PRD items T2.2–T2.5 plus empty-state,
discoverability, and failure UX into one architecture for `obligato chat`.

## Vision

The chat surface is a pure projection of session state. Three stacked layers —
cockpit panes, generative composition, living surface — turn the current
one-status-line screen into a state-legible instrument: the session readable at
a glance, widgets that materialize when the state calls for them, and a
shader-driven visualizer that shows what the agent is doing from across the room.

## Decisions

- **Ambition A+B+C** (cockpit + GenUI + living surface), sliced; approved 2026-07-12.
- **Theme: Quiet Pro default** (single-line box, indigo accent, glyphs ❯ ● ▸ ▾ ✖ ✓ ◆).
  Themes are a token file; alternates (Cyberdeck, Phosphor, Mission Control,
  Playhouse — mocked 2026-07-12 playground) may land later as theme files only.
- **Real shader** via `@opentui/three` (WebGPU): one scene, two moments — ~1.5 s
  skippable boot animation, then docks into the rail as the persistent agent
  visualizer. Optional dependency with a hard degrade ladder (below).
- **anscribe** (`@anscribe/opentui`) wired in dev builds only for capture-driven
  design validation (ctrl+g → markdown snapshot). Env-guarded like every
  test-only seam (F-192 discipline); never in the production path.

## Architecture

```
session events (SES-1 chain, append-only)
      │
 reducer (UX-14; pure; packages/cli/src/chat/model.ts — no OpenTUI imports)
      │
 composer (NEW; pure)  compose(state): WidgetTree
      │                 ChatWidget Zod schema in packages/schemas
 renderer (NEW)         WidgetTree → OpenTUI renderables (yoga panes)
      └─ effects layer  cosmetics only; reads state deltas, writes cells;
                        never feeds state; killed by degrade ladder
```

Determinism invariant: same event chain → same reducer state → same WidgetTree
(SES-2 discipline extended to UI). Model-hinted composition (slice 7) preserves
it: hints are session events on the chain, validated against the same schema.

## A. Cockpit

```
┌ header: model · auth kind · branch ───────────────────────────┐
│ ┌ transcript (ScrollBox, flex) ────────┐ ┌ rail (30c, toggle)┐│
│ │  ❯ user text                         │ │ [tabs: tree│$│rt] ││
│ │  ● assistant → Markdown renderable   │ │ session tree /    ││
│ │  ▸ tool folds (T2.2 draft clause);   │ │ budget burn /     ││
│ │    diff→Diff code→Code tab→TextTable │ │ route evidence    ││
│ └──────────────────────────────────────┘ └───────────────────┘│
│ input (Textarea: multiline, history)                          │
└ ticker: ~$cost · ctx% · step · state ── /help · keymap hints ─┘
```

- Rail tabs are T2.3/T2.4 as living panes; `/route` `/budget` `/tree` focus the
  pane and dispatch through the same functions as the typed CLI (F-085, UX-14).
- Subscription cost ticker carries the `~` prefix (T2.5 honesty; PROV-6 yardstick).
- Keymap layers (`@opentui/keymap`): global (esc, dev ctrl+g) → pane focus (tab)
  → transcript (j/k nav, enter expand, y yank).
- Empty state: ASCIIFont wordmark, model/repo context lines, two `try` examples,
  command hints.
- Responsive: <100 cols rail collapses to ticker badges; 80 cols single column,
  all panes keyboard-reachable (UX-4).

## B. GenUI

- `ChatWidget` (packages/schemas): recursive union
  `panel | table | diff | markdown | code | sparkline | tree | ticker | badge`,
  each variant carrying its 80-col and plain-text degrade in the schema entry.
- **Slice: rule-driven.** Declarative rule table, event kinds → widgets:
  gates run → gates panel; eval events → live bench table; budget ≥ 60% → burn
  pane auto-surfaces; fork event → tree pane surfaces. Pure, golden-testable.
- **Slice (later, gated): model-hinted.** The model may emit a `ui_hint` session
  event validated against the same schema; hints open/arrange panes only — never
  new widget types, never execution. Zero hints ≡ rule-driven output. Cheap
  routed model permitted (RPOL). Replayable and auditable like any chain event.

## C. Living surface

- **Agent visualizer**: `@opentui/three` scene; uniforms are pure functions of
  state — idle drift, thinking turbulence scaled by token rate, per-tool pulse,
  error shockwave, paused freeze. Boot plays full-screen ~1.5 s, any key skips,
  never delays first input (TimeToFirstDraw guard), then docks to a 30×10 rail cell.
- **Degrade ladder (hard order):** WebGPU/native import failure → FrameBuffer 2D
  effect (same state vocabulary, cell-painted) → `OBLIGATO_NO_MOTION` or
  non-interactive → static glyph badge → NO_COLOR → structure only. 80 cols keeps
  the badge, drops the pane. Non-TTY never renders any of this (UX-14 exit).
- Ticker pulse on burn; Timeline micro-transitions on fold/expand; effects layer
  is write-only cosmetics — state hash identical with effects on/off (test contract).
- `@opentui/three` + `three` are optional deps of packages/cli; gates never
  depend on them.

## Slices (each = one feature-pipeline run; clause numbers assigned at landing)

1. **chat-tokens+widgets** — theme token file (Quiet Pro) + `ChatWidget` schema.
2. **chat-cockpit-shell** — panes, keymap layers, typed renderables, empty state
   (T2.2, T2.4 visuals, discoverability).
3. **chat-live-rail** — budget + tree panes (T2.3 partial, T2.4). The `/route`
   *overlay* is deferred (recorded 2026-07-13): chat sessions run a fixed
   model — no per-turn routing decision exists to display until AGT-10 feeds
   chat; `/route` keeps its transcript dispatch. Rail badges below 100 cols
   also trimmed (speculative); the rail simply hides.
4. **chat-genui-rules** — composer + rule table (UX-35). Landed 2026-07-13
   with rule 1 (assistant → markdown) only; the gates-panel/bench/budget-cap/
   fork-auto-surface rules recorded deferred — no in-chat signal exists for
   any of them yet (gates/evals/forks happen out-of-process, no session cap
   exists). T2.2(b) diff-typed edit/write results deferred again: tool
   outputs are one-line confirmations, so diff rendering needs tool-call-args
   plumbing — its own future slice. T2.2(c) reverse-search deferred (input
   feature). Slice 2's `@opentui/keymap` deferral stands.
5. **chat-visualizer** — shader + degrade ladder.
6. **chat-failure-ux** — error panels (429 retry countdown), permission/budget
   prompts as styled panels.
7. *(gated, later)* **chat-genui-hints** — `ui_hint` events.

## Verification

- Composer: golden WidgetTree JSON per fixture chain (new; cheap).
- Renderer: OpenTUI testing harness snapshots at 80 and 120 cols; NO_COLOR
  snapshots; UX-4 sweep.
- Reducer purity: lint gate — no `@opentui` import in `chat/model.ts` or composer.
- Effects contract: reducer/composer output hash identical with effects enabled
  vs disabled.
- anscribe dev-capture loop during build: captured renders validated against
  this document.
- Live-endpoint rules unchanged: all fixtures local; collateral-test sweep for
  any new network surface (F-191 discipline).

## Constraint compliance

UX-4 (80 col, NO_COLOR, non-TTY degrade), UX-9 (sink), UX-14 (pure reducer,
serialized turns, slash = same functions), PROV-3/PROV-6 (cost honesty),
ADR-0003 (OpenTUI 0.4.2, Bun). New deps: `@opentui/keymap`,
`@opentui/three` + `three` (optional), `@anscribe/opentui` (dev). Versions from
the registry at install time, never from memory.
