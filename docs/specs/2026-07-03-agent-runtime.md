# Agent Runtime — Native Loop, Sessions, Permissions, Provider Layer

Owns clause families `AGT-*` (loop), `SES-*` (sessions), `PERM-*` (permissions),
`PROV-*` (LLM/provider layer). Phase 6 (walking skeleton) clauses below; Phases 7–10
extend these families per `2026-07-03-standalone-harness-design.md` — new clauses
take the next free number, never reuse.

Terms: a **step** is one assistant turn (one model call plus the tool executions it
requests). A **session event** is one row in the append-only `session_event` table.
The **runtime** is `packages/agent`.

## 1. Provider layer (`PROV-*`)

- **PROV-1.** When the runtime resolves a model reference, it shall resolve through the model registry — the shipped `models.json` overlaid by `~/.kelson/models.json` (user entries win on id collision) — to a configured AI SDK provider instance; an unresolvable reference shall fail with an error naming the reference and listing known model ids.
  *Obligation:* unit — shipped id resolves; overlay id shadows shipped; unknown id throws with both the bad ref and ≥1 known id in the message.
- **PROV-2.** While storing credentials, the runtime shall keep them in `~/.kelson/auth.json` with file mode 0600, written atomically (temp file + rename); when no stored credential exists for a provider, the runtime shall fall back to that provider's conventional env var (`ANTHROPIC_API_KEY`), with stored credentials taking precedence over env.
  *Obligation:* integration — round-trip a credential under a temp HOME, assert mode 0600 and atomic write (no partial file on injected crash between write and rename); precedence test: stored key wins over env var.
- **PROV-3.** When a step completes, the runtime shall compute its cost as integer micro-USD from the registry's per-model prices and the provider-reported usage (all four token classes); when the model has no registry price, cost shall be recorded as unknown — never estimated.
  *Obligation:* unit — fixture usage × fixture prices equals exact expected ints (expected values computed by hand in the test, not by calling `costOf`); unknown-price model yields the unknown marker, not 0.
- **PROV-4.** When `kelson chat` or `kelson run` starts with no configured credential or default model, the runtime shall exit non-zero with instructions to run `kelson auth login` — it shall not probe endpoints or guess a provider. When `kelson auth login <provider>` completes, it shall persist the credential (PROV-2) and the chosen default model to `.kelson/config.json`.
  *Obligation:* CLI integration — unconfigured invocation exits non-zero mentioning `kelson auth login` and makes zero network calls; after a scripted login fixture, the same invocation proceeds past setup.

## 2. Agent loop (`AGT-*`)

- **AGT-1.** When the runtime executes a step, it shall make exactly one model call (`streamText`) per step and shall own all loop control — SDK multi-step/continuation features shall not be used; a step that returns tool calls executes them and the next step is a new model call.
  *Obligation:* unit with a mock provider — a two-step exchange (tool call, then final answer) observes exactly 2 provider invocations; grep-proxy — `packages/agent` sources contain no `stopWhen`/`maxSteps` usage (proxy: SDK loop-control surface, named here; narrow if the SDK renames it).
- **AGT-2.** When a step ends, the runtime shall return exactly one of `continue`, `done`, or `paused(reason)`; while a session is paused, its state shall be fully recoverable from the store — resuming in a fresh process continues from the pause point without re-executing completed work.
  *Obligation:* integration — drive a session to a permission pause, reopen the store in a new object (simulating process restart), resume, assert completion and that pre-pause tool executions ran exactly once.
- **AGT-3.** When a step finishes, the runtime shall ingest one telemetry step event via `safeIngest` carrying first-hand usage (all four token classes), the model id, and cost (PROV-3); if ingestion fails, the session shall continue with a degraded marker (KERN-1 discipline) — telemetry shall never break the loop.
  *Obligation:* integration — a fixture session of N steps yields exactly N step_event rows whose token counts match the mock provider's emitted usage (expected totals computed from the fixture, not re-derived via the ingest path); with ingestion forced to throw, the session still completes and carries the degraded marker.
- **AGT-4.** When the model requests a tool, the runtime shall execute it through the tool registry — exactly the seven core tools in Phase 6: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` — with filesystem/process access taken only from the caller-supplied `ToolContext` (`cwd`, `exec`); tool results shall append to the session as events in execution order.
  *Obligation:* integration — a session under a ToolContext rooted in a temp dir writes/reads only inside that dir (bash `pwd` and file ops observed under the temp root); tool_result events appear in execution order by rowid.

## 3. Sessions (`SES-*`)

- **SES-1.** While persisting session history, the runtime shall append rows to the `session_event` table (ULID id, nullable `parent_id`, kind, JSON payload, UTC timestamp) and shall never UPDATE or DELETE them; reads shall order by `rowid` (F-060/F-067 convention).
  *Obligation:* unit + grep-proxy — the session store module issues no UPDATE/DELETE against `session_event` (source scan, proxy named); a written event is immutable via the store's public API.
- **SES-2.** When the runtime reconstructs context for a step, it shall walk the `parent_id` chain from the session head to the root and reverse it; reconstruction shall be deterministic — identical chains yield identical contexts.
  *Obligation:* PBT — for any generated event chain (fast-check), reconstruction returns exactly the chain's events root-first; two walks of the same chain are deeply equal.
- **SES-3.** When an event is appended, the runtime shall record the new head as a `head_moved` event; the current head shall be derived as the most recent `head_moved` by `rowid` — no mutable head column.
  *Obligation:* unit — after a sequence of appends the derived head is the last appended event; the migration adds no head column to any table (schema introspection).
- **SES-4.** When `kelson chat --continue <session>` starts, the runtime shall load the session's head and continue the same event chain; when a new session starts, the runtime shall create a kernel session row (`startSession`) so TEL-5 markers and lockfile pinning apply to native sessions.
  *Obligation:* integration — continue a fixture session and assert the next event's parent is the prior head; a new session produces a kernel `session` row with runner metadata.

## 4. Permissions (`PERM-*`)

- **PERM-1.** When a tool call is requested, the runtime shall evaluate ordered rules `{tool glob, arg glob?, action: allow|ask|deny}` — most-specific match wins, ties resolve `deny > ask > allow`; when no rule matches, the default shall be `allow` for read-only tools (`read`, `grep`, `find`, `ls`) and `ask` for `write`, `edit`, `bash`.
  *Obligation:* table-driven unit — cases for specificity ordering, the tie rule, and each default; expected outcomes enumerated by hand in the table.
- **PERM-2.** When a rule resolves to `ask`, the runtime shall append a `permission_request` event and pause the step (AGT-2); the answer shall append a `permission_decision` event, and an "always allow" answer shall additionally append a session-scoped allow rule as an event — never a config-file write.
  *Obligation:* integration — an ask/answer/always flow leaves request, decision, and scoped-rule events in order; a subsequent identical tool call proceeds without a new request; config files unchanged (hash before/after).
- **PERM-3.** While running headless (`kelson run`), an `ask` resolution shall resolve to `deny` unless an explicit allow flag was passed; a denied tool call shall return an error result to the model (the step continues — denial is feedback, not a crash).
  *Obligation:* CLI integration — `kelson run -p` with a write-requesting fixture: without the flag the write is denied, the file does not exist, and the session still reaches a final message; with the flag the write occurs.

## 5. Cross-references

- Command surface (`kelson chat`, `kelson run`, `kelson auth login`): UX doc §3 (UX-14..16).
- `session_event` storage shape: ERD §5.
- AI SDK adoption and executor injection: ADR-0004.
- Executor `"api"`, OAuth, and eval integration: Phase 7 clauses (to be added here).
