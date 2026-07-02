# Design: Kelson Interface — TUI Launcher + Local Web UI

Status: approved design (brainstorm output, 2026-07-03). Formal UX-* clauses land via
spec-sync when implementation starts; this document records the decisions and scope.

## Context

The kernel is feature-complete (Phases 0–5) but the operator surface is thin: five
plain-text CLI commands, no TUI (UX §7 was never built), and the local web UI is
parked post-v1 (UX §8). This project builds both interface layers:

- **TUI** — the operational cockpit: guided init, easier command running, structured
  output. Lives in `packages/cli` on OpenTUI (ADR-0003).
- **Web UI** — the visual surface: read-only, aesthetic, four data views. Promotes
  UX §8 out of post-v1. New `packages/ui`.

Decisions made during brainstorm: both surfaces; web UI strictly read-only;
launcher + wizards TUI shape (not full-screen app); terminal-heritage dark aesthetic;
SPA architecture (approach A).

## Architecture

```
SQLite + .kelson files
        │
   kernel query fns (existing)
        │
   Zod --json schemas (existing, UX-1)   ← single contract
   ┌────┴─────────┐
   ▼              ▼
packages/cli   GET /api/* (Bun.serve, in cli)
 TUI layer        │
 launcher         ▼
 wizards      packages/ui  (React SPA, prebuilt static assets)
```

One data spine: kernel query functions → the existing `--json` Zod schemas → consumed
by both the TUI components and the HTTP API. The SPA never reads the DB or files
directly; the API validates every response against the same schemas the CLI's
`--json` output uses (UX §8: "the TUI's `--json` schemas become its API for free").

## TUI (`packages/cli`, OpenTUI)

- **§7 component layer:** panel, key-value grid, aligned table, sparkline,
  side-by-side diff, select-list. All command output routes through it; no ad-hoc
  `console.log` outside the component layer.
- **Launcher:** bare `kelson` in a TTY opens an interactive menu (init wizard, eval,
  loop review, drift, pack, ui). Non-TTY invocation prints plain help and exits 0 —
  CI and scripts never hang.
- **Wizards are argument collectors only.** A wizard's terminal action executes the
  exact same code path as the typed CLI command (F-085 operator-surface lesson).
  Ctrl-C exits cleanly having executed nothing.
- **Accessibility:** `NO_COLOR`/plain fallback; color is never the only signal
  (symbols `✓ ✗ ~ ?` accompany), per §7.

## Web UI (`packages/ui` + `kelson ui`)

Vite + React + Tailwind. Assets built at publish time, shipped in the package.
`kelson ui` starts `Bun.serve` on `127.0.0.1` (default port, `--port` flag):
static assets + read-only `GET /api/*` endpoints. The server implements GET only —
read-only enforced structurally. Freshness by polling refetch.
<!-- ponytail: polling; websockets if someone watches a live eval run -->

**Shell:** terminal-heritage dark — near-black background, monospace for
identifiers/numbers, §7 semantic colors (green passing/helps, red failing/hurts,
yellow attention, cyan identifiers), symbols always accompanying color. Left nav;
every entity cross-links (eval run ↔ ledger entry, proposal ↔ evidence run,
clause ↔ obligation test).

**Views (all four in v1):**

1. **Telemetry dashboard** (home) — stat tiles (sessions, tokens, cost with units,
   model mix); time-series of tokens/cost per day; recent-sessions table with
   per-session drill-down (steps, tool calls, task lifecycle). Event queries ordered
   by `rowid`, per convention.
2. **Eval explorer** — run list → run detail: effect size **with CI** as
   dot-and-whisker, pass-rate deltas per task, verdict badge matching the
   eval-procedure gate math, drill-down to check results, browsable ledger entries.
3. **Improvement loop board** — kanban columns mirroring the LOOP state machine
   (proposed → gated → approved → applied → monitored/reverted); cards show proposal
   diff, linked evidence run, gate verdict with metric. Changelog timeline below.
   Every state names its CLI verb (UX-P5) as a copyable command.
4. **Traceability graph** — interactive DAG: clauses → obligation tests → artifacts,
   edges colored by drift status; node click opens a side panel (clause text,
   obligation, file path, last-verified hash); filter by clause family.

**Visualization deps:** exactly two — one lightweight React charting lib for
time-series/CI plots and React Flow (or similar) for the DAG. Versions from the
registry at implementation time, never from memory.

## Error handling

- **Degraded, never blocking (KERN-1 / UX-P1):** missing or empty SQLite → designed
  empty states naming the CLI verb that produces data ("no eval runs yet →
  `kelson eval suite`"). Never an error wall.
- **Server:** localhost-only bind; non-GET → 405; port taken → clear message with
  `--port` hint. An API response failing its Zod schema returns 500 loudly —
  never render wrong data quietly.
- **No version skew:** SPA assets and API ship in the same package version.

## Testing

Each new UX clause gets an obligation test (repo convention):

- Launcher: spawned without a TTY → no interactive prompt, plain help, exit 0.
- Wizards: dispatch through the identical entry point as the typed command —
  asserted, not assumed.
- API: non-GET → 405; every endpoint response round-trips its paired Zod schema;
  non-localhost bind refused.
- Component layer: rendered-string assertions on panels/tables/sparklines, including
  plain fallback and symbols-accompany-color.
- SPA: lightly tested (a few empty-state render tests); the contract is tested hard
  at the API layer instead. Playwright e2e deferred.
- `packages/ui` joins `bun run gates`; the Vite build runs in CI so publish cannot
  ship stale assets.

## Out of scope

- Any write action from the browser (approve/reject stays CLI/TUI).
- Full-screen persistent TUI app.
- Auth, remote access, websockets, dashboards-over-time beyond the local store
  (OTel → external dashboards remains the answer for that, per ADR-0001).
