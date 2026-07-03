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
  *Obligation:* integration — round-trip a credential under a temp HOME, assert mode 0600 and the atomic-write observables (the write goes through temp-file + rename; no temp residue after a save — a crash-injection seam is deliberately out of scope, audit 2026-07-03); precedence test: stored key wins over env var.
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
- **AGT-5.** When resume is invoked on a session whose last lifecycle state is not `paused`, the runtime shall refuse with a distinct error naming the actual state and shall append no events. Divergence ruling 2026-07-03: reader B's "the session's last lifecycle state must be `paused`; anything else throws `SessionNotPausedError` and appends nothing" is adopted over reader A's "resume on a done session is an idempotent no-op that reports `done`" — continuing a completed session is SES-4's `--continue` path (a new user message on the chain), never resume.
  *Obligation:* integration — resume on a `done` fixture session raises the distinct error and the `session_event` row count is unchanged (counted before/after); resume on a `paused` fixture proceeds normally.
- **AGT-6.** When a pause is recorded, the runtime shall require a non-empty reason string at record time — divergence ruling 2026-07-03: reader B's "pause reasons are validated at request time (non-empty string)" is adopted over reader A's "an empty-string reason is stored and returned as `paused("")`, not rejected". Paused state shall be derived from the chain, introducing no new event kind — a session is `paused` while its last assistant message requested tool calls (the turn is suspended: an ask unanswered or answered-but-unexecuted, or all results landed awaiting the next model call), `done` when it requested none, and `active` when no assistant message exists yet (audit amendment 2026-07-03: the earlier permission-request-only derivation left step-limit and answered-ask suspensions unresumable, contradicting AGT-2).
  *Obligation:* unit — an empty-string reason is rejected with a validation error and appends nothing; the derivation is discriminating across all three states: unanswered ask → paused, answered-but-unexecuted ask → paused (the AGT-2 resume case), all-results-landed suspension → paused, final answer → done, no assistant yet → active; the kind inventory of a paused fixture introduces no pause-specific kind.

## 3. Sessions (`SES-*`)

- **SES-1.** While persisting session history, the runtime shall append rows to the `session_event` table (ULID id, nullable `parent_id`, kind, JSON payload, UTC timestamp) and shall never UPDATE or DELETE them; reads shall order by `rowid` (F-060/F-067 convention).
  *Obligation:* unit + grep-proxy — the session store module issues no UPDATE/DELETE against `session_event` (source scan, proxy named); a written event is immutable via the store's public API.
- **SES-2.** When the runtime reconstructs context for a step, it shall walk the `parent_id` chain from the session head to the root and reverse it; reconstruction shall be deterministic — identical chains yield identical contexts.
  *Obligation:* PBT — for any generated event chain (fast-check), reconstruction returns exactly the chain's events root-first; two walks of the same chain are deeply equal.
- **SES-3.** When an event is appended, the runtime shall record the new head as a `head_moved` event; the current head shall be derived as the most recent `head_moved` by `rowid` — no mutable head column.
  *Obligation:* unit — after a sequence of appends the derived head is the last appended event; the migration adds no head column to any table (schema introspection).
- **SES-4.** When `kelson chat --continue <session>` or `kelson run --continue <session>` starts, the runtime shall load the session's head and continue the same event chain; when a new session starts, the runtime shall create a kernel session row (`startSession`) so TEL-5 markers and lockfile pinning apply to native sessions.
  *Obligation:* integration — `kelson run --continue` (the operator surface, F-085) extends the same session: the follow-up user_message's parent is the prior head and no second kernel session row appears; a new session produces a kernel `session` row with runner metadata.

## 4. Permissions (`PERM-*`)

- **PERM-1.** When a tool call is requested, the runtime shall evaluate rules `{tool glob, arg glob?, action: allow|ask|deny}`: any matching `deny` rule shall win regardless of specificity (divergence ruling 2026-07-03 — both blind readers noted that under specificity-first, "a blanket `{tool:"*", arg:"/etc/*", deny}` guard is defeated by any tool-literal `allow` rule"; deny is a guardrail, so it trumps). Among the remaining matching rules the most specific shall win, scored by the lexicographic tuple `(literalChars(toolGlob), literalChars(argGlob))` — literal characters are those that are not `*` or `?`, an absent arg glob contributes 0, and the tool component strictly dominates; exact-tuple ties resolve `ask > allow`; rule-list order shall never decide between different actions. Globs are flat: `*` matches any run of characters **including `/`**. When no rule matches, the default shall be `allow` for read-only tools (`read`, `grep`, `find`, `ls`) and `ask` for every other tool — `write`, `edit`, `bash`, and any tool outside the core set.
  *Obligation:* table-driven unit — deny-trump case (`{tool:"*", arg:"/etc/*", deny}` beats `{tool:"read", allow}` on `read("/etc/passwd")`); specificity ordering among allow/ask rules incl. tool-dominance (`(4,0)` beats `(0,5)`) and arg discrimination at equal tool specificity; the `ask > allow` exact-tie rule; flat-glob `/`-crossing; each default including an unknown tool; expected outcomes enumerated by hand in the table.
- **PERM-2.** When a rule resolves to `ask`, the runtime shall append a `permission_request` event and pause the step (AGT-2); the answer shall append a `permission_decision` event, and an "always allow" answer shall additionally append a session-scoped allow rule as an event — never a config-file write. The scoped rule is tool-granular (it matches the surface's "always allow <tool>" wording; deny rules still trump it, PERM-1).
  *Obligation:* integration — an ask/answer/always flow leaves request, decision, and scoped-rule events in order; a subsequent identical tool call proceeds without a new request; config files unchanged (hash before/after).
- **PERM-3.** While running headless (`kelson run`), an `ask` resolution shall resolve to `deny` unless an explicit allow flag was passed; a denied tool call shall return an error result to the model (the step continues — denial is feedback, not a crash).
  *Obligation:* CLI integration — `kelson run -p` with a write-requesting fixture: without the flag the write is denied, the file does not exist, and the session still reaches a final message; with the flag the write occurs.

## 5. Cross-references

- Command surface (`kelson chat`, `kelson run`, `kelson auth login`): UX doc §3 (UX-14..16).
- `session_event` storage shape: ERD §5.
- AI SDK adoption and executor injection: ADR-0004.
- Executor `"api"`, OAuth, and eval integration: Phase 7 clauses (to be added here).
