import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  type BudgetMonitor,
  budgetEvents,
  endSession,
  safeIngest,
  ulid,
} from "@obligato/kernel";
import type {
  ModelRegistryEntry,
  PermissionRule,
  SessionEvent,
} from "@obligato/schemas";
import { type LanguageModel, streamText, type ToolSet, tool } from "ai";
import { assembleContext } from "./context.ts";
import { costOf, type Usage } from "./llm/registry.ts";
import { evaluate } from "./permissions.ts";
import {
  escalateStep,
  newSessionBudget,
  type RoutingContext,
  recordStepOutcome,
  routeStep,
  sessionPausedForBudget,
} from "./routing.ts";
import {
  appendEvent,
  assertResumable,
  autoCompactDue,
  compactSession,
  deterministicDigest,
  listEvents,
  pendingToolCalls,
  reconstruct,
  sessionModelOf,
} from "./sessions.ts";
import {
  cachedStatus,
  emitVerificationReport,
  failingClauses,
  gateWrite,
  governedFilesHash,
  obligationChecks,
  type SpecContext,
  touchedClauses,
} from "./spec.ts";
import type { AgentTool, ToolContext } from "./tools.ts";

export interface StepDeps {
  db: Database;
  sessionId: string;
  entry: ModelRegistryEntry;
  model: LanguageModel;
  tools: AgentTool[];
  rules: PermissionRule[];
  ctx: ToolContext;
  // PERM-3: headless runs resolve "ask" without pausing — to deny (denial is
  // feedback to the model, not a crash), or to allow when the caller passed
  // the explicit allow flag. Undefined = interactive (pause on ask).
  headlessAsk?: "deny" | "allow";
  // PERM-5: granular headless allows (--allow tool[:argGlob]) — consulted
  // when resolution is `ask`, before the blanket headlessAsk. Entries always
  // carry action "allow"; PERM-1 defaults never grant (real matches only).
  headlessAllows?: PermissionRule[];
  // PROV-6/7: how the session authenticates — drives the 401 re-mint hint.
  authKind?: "subscription" | "api_key" | "none";
  // UX-17: lets a step honor a chain-recorded model switch at the next model
  // call. Without it the deps' model is fixed (fixtures, the api executor).
  resolveModel?: (ref: string) => {
    entry: ModelRegistryEntry;
    model: LanguageModel;
  };
  // PROV-9: transport-retry knobs; injectable for fixture determinism (the
  // F-126 discipline — stochastic loop behavior needs a test switch).
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  };
  // AGT-7/8/9: the spec-native loop. Absent or empty => inert (Phase 6/7).
  spec?: SpecContext;
  // AGT-8: a recorded human override unblocks the ART-4 write gate.
  override?: { by: string; reason: string };
  // AGT-10..12: live routing + budget. Absent => fixed model, no budget.
  routing?: RoutingContext;
  // AGT-11: session-level BudgetMonitor holder (runTurn-owned, seeded once).
  budgetHolder?: { monitor: BudgetMonitor | null };
  // AGT-16: auto-compaction seams. The summarizer replaces the built-in
  // deterministic digest without changing the trigger; the override replaces
  // the trigger's decision inputs ONLY (fixture determinism, F-126) —
  // telemetry/cost still record real usage.
  autoCompactSummarizer?: (chain: SessionEvent[]) => string;
  autoCompactOverride?: {
    usage: {
      tokens_in: number;
      tokens_cache_read: number;
      tokens_cache_write: number;
    };
    contextWindow: number;
  };
  onDelta?: (text: string) => void;
  // UX-36: fires when a call resolves to execution-or-denial (never on an
  // ask-pause — the answered re-request fires exactly once); arg is the
  // tool's primaryArg (the PERM-2 prompt string). Additive.
  onToolStart?: (name: string, arg: string) => void;
  // UX-31: output is additive — the chat transcript folds long tool results.
  onToolResult?: (name: string, ok: boolean, output?: string) => void;
  onStepCost?: (costMicroUsd: number | null) => void;
  abort?: AbortSignal;
}

export type StepResult =
  | { status: "continue" }
  | { status: "done"; text: string }
  | { status: "paused"; reason: string };

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// AGT-11: how many headless budget extensions (each = +1 budget of headroom)
// before a headless run blocks. Bounds unattended spend at (2 + CAP)× budget.
const BUDGET_HEADLESS_CAP = 2;

// PROV-9: transport classification — the adapter's own isRetryable plus the
// canonical transient statuses; a numeric retry-after is honored, capped.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 529]);
const RETRY_AFTER_CAP_MS = 30_000;
const retryDecision = (
  err: unknown,
): { retryable: boolean; retryAfterMs: number | null } => {
  const e = err as {
    isRetryable?: boolean;
    statusCode?: number;
    responseHeaders?: Record<string, string>;
  };
  const retryable =
    e.isRetryable === true ||
    (typeof e.statusCode === "number" && RETRYABLE_STATUS.has(e.statusCode));
  const ra = e.responseHeaders?.["retry-after"];
  const sec = ra !== undefined && /^\d+$/.test(ra) ? Number(ra) : null;
  return {
    retryable,
    retryAfterMs:
      sec === null ? null : Math.min(sec * 1000, RETRY_AFTER_CAP_MS),
  };
};

// AGT-6: pause reasons are validated non-empty at record time.
export const validatePauseReason = (reason: string): string => {
  if (reason.length === 0)
    throw new Error("pause reason must be a non-empty string (AGT-6)");
  return reason;
};

// PERM-2: "always allow" answers append a session-scoped rule as an event
// (session_meta with a scoped_rule payload) — never a config-file write.
const sessionRules = (chain: SessionEvent[]): PermissionRule[] =>
  chain
    .filter((e) => e.kind === "session_meta" && e.payload.scoped_rule)
    .map((e) => ({
      tool: String((e.payload.scoped_rule as { tool: string }).tool),
      action: "allow" as const,
    }));

// PERM-2: the answer to a permission_request, appended to the chain. The
// "always" form additionally appends the session-scoped allow rule event.
export const answerPermission = (
  db: Database,
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
  always = false,
): void => {
  const events = listEvents(db, sessionId);
  const chain = reconstruct(events);
  const request = chain.find(
    (e) => e.kind === "permission_request" && e.id === requestId,
  );
  if (!request) throw new Error(`no permission_request ${requestId} on chain`);
  let head = appendEvent(db, {
    session_id: sessionId,
    parent_id: headOf(chain),
    kind: "permission_decision",
    payload: { request_id: requestId, decision, tool: request.payload.tool },
  }).id;
  if (always && decision === "allow") {
    head = appendEvent(db, {
      session_id: sessionId,
      parent_id: head,
      kind: "session_meta",
      payload: {
        scoped_rule: { tool: String(request.payload.tool), action: "allow" },
      },
    }).id;
  }
};

// toMessages/assembleContext live in context.ts — the sole producer of model
// input (the seam prompt caching and compaction attach to).

const headOf = (chain: SessionEvent[]): string => {
  const last = chain[chain.length - 1];
  if (!last) throw new Error("session has no events");
  return last.id;
};

// Executes pending tool calls in order through the permission engine.
// Returns "paused" at the first unanswered ask (AGT-2: the pause is a return
// value, durable in the store via the permission_request event).
const resolveTools = (deps: StepDeps, chain: SessionEvent[]): StepResult => {
  let head = headOf(chain);
  const modifiedPaths: string[] = [];
  let sawBash = false;
  const rules = [...deps.rules, ...sessionRules(chain)];
  const requests = chain.filter((e) => e.kind === "permission_request");
  const decisions = new Map(
    chain
      .filter((e) => e.kind === "permission_decision")
      .map((e) => [String(e.payload.request_id), e]),
  );

  for (const call of pendingToolCalls(chain)) {
    const toolImpl = deps.tools.find((t) => t.name === call.name);
    const arg = toolImpl ? toolImpl.primaryArg(call.input) : "";
    const verdict = evaluate(rules, call.name, arg);
    let action = verdict.action;

    if (action === "ask" && deps.headlessAsk !== undefined) {
      // PERM-5: a REAL granular match (rule !== null — evaluate's defaults
      // must never grant) resolves the ask to allow; else the PERM-3 blanket.
      const granular = deps.headlessAllows?.length
        ? evaluate(deps.headlessAllows, call.name, arg)
        : null;
      const granted =
        granular !== null &&
        granular.rule !== null &&
        granular.action === "allow";
      action = granted ? "allow" : deps.headlessAsk;
    }
    if (action === "ask") {
      const request = requests.find(
        (e) => String(e.payload.tool_call_id) === call.id,
      );
      const decision = request ? decisions.get(request.id) : undefined;
      if (!decision) {
        if (!request) {
          head = appendEvent(deps.db, {
            session_id: deps.sessionId,
            parent_id: head,
            kind: "permission_request",
            payload: {
              tool_call_id: call.id,
              tool: call.name,
              arg,
              // PERM-4: provenance — the matched rule, or the literal
              // "default" when the PERM-1 default decided the ask.
              rule: verdict.rule
                ? {
                    tool: verdict.rule.tool,
                    ...(verdict.rule.arg !== undefined
                      ? { arg: verdict.rule.arg }
                      : {}),
                    action: verdict.rule.action,
                  }
                : "default",
              reason: validatePauseReason(`permission:${call.name}`),
            },
          }).id;
        }
        return {
          status: "paused",
          reason: validatePauseReason(`permission:${call.name}`),
        };
      }
      action = decision.payload.decision === "allow" ? "allow" : "deny";
    }

    // UX-36: fires once the call resolves to execution-or-denial — an
    // ask-pause fires nothing (the answered re-request fires exactly once),
    // so every fired start is completed by exactly one tool_result in this
    // pass (audit 2026-07-20: firing pre-ask double-fired across resume and
    // orphaned a phantom running row).
    deps.onToolStart?.(call.name, arg);

    // AGT-8: gate a write/edit to a governed file before it runs (spec-first
    // ART-4). A block is a denied tool result (PERM-3 shape), never a crash.
    let gateBlock: string | null = null;
    if (
      action === "allow" &&
      deps.spec &&
      (call.name === "write" || call.name === "edit")
    ) {
      const abs = join(deps.ctx.cwd, String(call.input.path));
      const gate = gateWrite(deps.db, deps.spec, abs, deps.override);
      if (gate.action === "block") gateBlock = gate.reason;
    }

    let output: string;
    let isError = false;
    if (gateBlock !== null) {
      output = `blocked: ${gateBlock}`;
      isError = true;
    } else if (action === "deny") {
      output = `denied by permission rule: ${call.name}`;
      isError = true;
    } else if (!toolImpl) {
      output = `unknown tool: ${call.name}`;
      isError = true;
    } else {
      const parsed = toolImpl.params.safeParse(call.input);
      if (!parsed.success) {
        output = `invalid input: ${parsed.error.message}`;
        isError = true;
      } else {
        try {
          output = toolImpl.run(call.input, deps.ctx);
          if (!isError && (call.name === "write" || call.name === "edit"))
            modifiedPaths.push(join(deps.ctx.cwd, String(call.input.path)));
          // AGT-7 (audit F-123): bash can modify a governed file without a
          // declared path, which would otherwise escape the obligation runner
          // and miss the done-gate. A bash call re-checks all governed clauses;
          // the content-addressed cache re-runs only those whose files changed.
          if (!isError && call.name === "bash") sawBash = true;
        } catch (err) {
          output = err instanceof Error ? err.message : String(err);
          isError = true;
        }
      }
    }
    head = appendEvent(deps.db, {
      session_id: deps.sessionId,
      parent_id: head,
      kind: "tool_result",
      payload: {
        tool_call_id: call.id,
        name: call.name,
        output,
        is_error: isError,
      },
    }).id;
    deps.onToolResult?.(call.name, !isError, output);
  }

  // AGT-7: after the batch, run the touched clauses' obligations (cached by
  // governed-file hash) and record each executed result. A bash call in the
  // batch forces a re-check of every governed clause (the cache re-runs only
  // those whose files actually changed).
  if (deps.spec && !deps.spec.empty) {
    const toCheck = sawBash
      ? [...deps.spec.clausesByFile.keys()]
      : modifiedPaths;
    if (toCheck.length > 0)
      head = runObligations(deps, deps.spec, toCheck, head, chain);
  }
  return { status: "continue" };
};

// AGT-7: run each touched clause's obligation as a separate `bun test`, cache
// by (clause, governed-file hash), record an obligation_check payload per
// execution (cache hits run nothing and record nothing).
const runObligations = (
  deps: StepDeps,
  spec: SpecContext,
  modifiedPaths: string[],
  headId: string,
  // The caller's reconstructed chain — obligation_check events appended after
  // it are only this function's own, tracked in `checks` below (reconstruct-
  // once: no redundant O(n) walk per batch).
  chain: SessionEvent[],
): string => {
  let head = headId;
  const checks = obligationChecks(chain);
  for (const clause of touchedClauses(spec, modifiedPaths)) {
    const filesHash = governedFilesHash(spec, clause);
    if (cachedStatus(checks, clause, filesHash) !== null) continue; // cache hit
    const obligationPath = spec.obligationPath.get(clause) ?? null;
    let status: "pass" | "fail";
    if (obligationPath === null) {
      status = "fail"; // AGT-7: a clause that cannot be checked does not pass
    } else {
      const rel = obligationPath.startsWith(`${spec.repo}/`)
        ? obligationPath.slice(spec.repo.length + 1)
        : obligationPath;
      const res = deps.ctx.exec(`bun test ${JSON.stringify(rel)}`);
      status = res.exitCode === 0 && !res.timedOut ? "pass" : "fail";
    }
    head = appendEvent(deps.db, {
      session_id: deps.sessionId,
      parent_id: head,
      kind: "session_meta",
      payload: {
        obligation_check: {
          clause_id: clause,
          files_hash: filesHash,
          status,
          obligation_path: obligationPath,
        },
      },
    }).id;
    checks.push({
      clause_id: clause,
      files_hash: filesHash,
      status,
      obligation_path: obligationPath,
    });
  }
  return head;
};

// AGT-10 feature heuristics. A step is mechanical when its last assistant
// message only requested read-only tools (no write/edit/bash) — the routing
// emulation's `task_type: mechanical` signal.
const mechanicalStep = (chain: SessionEvent[]): boolean => {
  const lastAssistant = [...chain]
    .reverse()
    .find((e) => e.kind === "assistant_message");
  const calls = (lastAssistant?.payload.tool_calls ?? []) as ToolCall[];
  if (calls.length === 0) return false;
  const mutating = new Set(["write", "edit", "bash"]);
  return calls.every((c) => !mutating.has(c.name));
};

// Max tier of the session's touched clauses (SpecContext), else T0.
const touchedTier = (
  spec: SpecContext | undefined,
  chain: SessionEvent[],
): "T0" | "T1" | "T2" => {
  if (!spec || spec.empty) return "T0";
  const order = { T0: 0, T1: 1, T2: 2 } as const;
  let max: "T0" | "T1" | "T2" = "T0";
  for (const c of obligationChecks(chain)) {
    for (const abs of spec.filesByClause.get(c.clause_id) ?? []) {
      const t = spec.tierByFile.get(abs) as "T0" | "T1" | "T2" | undefined;
      if (t && order[t] > order[max]) max = t;
    }
  }
  return max;
};

// AGT-1: one step = exactly one model call plus the tool executions it
// requests; loop control is never delegated to the SDK.
export const step = async (deps: StepDeps): Promise<StepResult> => {
  const chain = reconstruct(listEvents(deps.db, deps.sessionId));
  const meta = chain[0];
  if (!meta || meta.kind !== "session_meta")
    throw new Error("session has no session_meta root");

  if (pendingToolCalls(chain).length > 0) return resolveTools(deps, chain);

  // AGT-10: with a RoutingContext, route this step and let the routed target
  // pick the model; else UX-17 — honor a chain-recorded model switch. "A
  // step's model id is fixed at the moment its model call is issued."
  let routed: ReturnType<typeof routeStep> | null = null;
  let entry: ModelRegistryEntry;
  let model: LanguageModel;
  // AGT-12: a one-shot obligation-fail escalation (the chain tail is a
  // routing_escalation) uses the escalated model for this step, then routing
  // resumes on the next step.
  const tail = chain[chain.length - 1];
  const escModelId =
    tail?.kind === "session_meta" && tail.payload.routing_escalation
      ? String((tail.payload.routing_escalation as { modelId: string }).modelId)
      : null;
  if (escModelId && deps.resolveModel) {
    ({ entry, model } = deps.resolveModel(escModelId));
  } else if (deps.routing && deps.resolveModel) {
    routed = routeStep(deps.db, deps.routing, {
      taskId: String(meta.payload.task_id),
      stepEventId: ulid(),
      repo: deps.spec?.repo ?? deps.ctx.cwd,
      mechanical: mechanicalStep(chain),
      tier: touchedTier(deps.spec, chain),
    });
    ({ entry, model } = deps.resolveModel(routed.modelId));
    // AGT-11: seed the session budget once, from the first routed budget.
    if (deps.budgetHolder && deps.budgetHolder.monitor === null)
      deps.budgetHolder.monitor = newSessionBudget(
        deps.db,
        deps.sessionId,
        deps.routing.policyVersion,
        routed.decision.budget_tokens,
      );
  } else {
    const activeRef = sessionModelOf(chain);
    ({ entry, model } =
      activeRef !== null && activeRef !== deps.entry.id && deps.resolveModel
        ? deps.resolveModel(activeRef)
        : { entry: deps.entry, model: deps.model });
  }

  // Cast: the SDK's ToolSet union is incompatible with
  // exactOptionalPropertyTypes at this call site; inputs are re-validated by
  // our own Zod schemas in resolveTools before execution.
  const aiTools = Object.fromEntries(
    deps.tools.map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: t.params }),
    ]),
  ) as ToolSet;
  // PROV-8: the system prompt rides as an instructions SystemModelMessage so
  // it can carry its cache breakpoint (ai v7's documented caching path).
  // The context is attempt-invariant: a PROV-9 retry re-issues it byte-
  // identically (the failed attempt appended nothing).
  const context = assembleContext(chain);
  const maxRetries = deps.retry?.maxRetries ?? 2;
  const baseDelayMs = deps.retry?.baseDelayMs ?? 500;
  const sleep =
    deps.retry?.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.retry?.random ?? Math.random;

  let text = "";
  let calls: ToolCall[] = [];
  let usage: Usage = {
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
  };
  for (let attempt = 0; ; attempt++) {
    text = "";
    calls = [];
    usage = {
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    };
    // PROV-9: only failures BEFORE the first streamed part retry — after
    // output began, splicing partial attempts is v1-out-of-scope.
    let streamed = false;
    try {
      const result = streamText({
        model,
        instructions: context.instructions,
        messages: context.messages,
        tools: aiTools,
        ...(deps.abort ? { abortSignal: deps.abort } : {}),
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          streamed = true;
          text += part.text;
          deps.onDelta?.(part.text);
        } else if (part.type === "tool-call") {
          streamed = true;
          calls.push({
            id: part.toolCallId,
            name: part.toolName,
            input: (part.input ?? {}) as Record<string, unknown>,
          });
        } else if (part.type === "finish") {
          const u = part.totalUsage;
          const cacheRead = u.inputTokenDetails.cacheReadTokens ?? 0;
          const cacheWrite = u.inputTokenDetails.cacheWriteTokens ?? 0;
          usage = {
            // tokens_in is the non-cached class, mirroring the CC transcript
            // convention so downstream math is runner-blind.
            tokens_in:
              u.inputTokenDetails.noCacheTokens ??
              Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite),
            tokens_out: u.outputTokens ?? 0,
            tokens_cache_read: cacheRead,
            tokens_cache_write: cacheWrite,
          };
        } else if (part.type === "error") {
          throw part.error instanceof Error
            ? part.error
            : Object.assign(new Error(String(part.error)), part.error);
        }
      }
      break;
    } catch (err) {
      // PROV-7: an auth failure on a subscription token names the re-mint
      // path; no silent retry, no credential fallback mid-session.
      if (
        deps.authKind === "subscription" &&
        (err as { statusCode?: number }).statusCode === 401
      )
        throw new Error(
          `anthropic rejected the subscription token (401) — re-mint it with \`claude setup-token\` and re-run \`obligato auth login anthropic --token <token>\` (PROV-7): ${(err as Error).message}`,
        );
      const { retryable, retryAfterMs } = retryDecision(err);
      if (!streamed && retryable && attempt < maxRetries) {
        // equal-jitter multiplier in [0.5, 1] on the exponential base;
        // an explicit retry-after wins.
        const backoff =
          retryAfterMs ??
          Math.round(baseDelayMs * 2 ** attempt * (0.5 + random() / 2));
        await sleep(backoff);
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  const cost = costOf(usage, entry);
  deps.onStepCost?.(cost);
  const assistant = appendEvent(deps.db, {
    session_id: deps.sessionId,
    parent_id: headOf(chain),
    kind: "assistant_message",
    payload: {
      text,
      tool_calls: calls,
      usage: { ...usage },
      model: entry.id,
      cost_micro_usd: cost,
    },
  });

  // AGT-3: first-hand telemetry at the step boundary; failure degrades the
  // session (KERN-1 via safeIngest) but never breaks the loop.
  safeIngest(deps.db, deps.sessionId, "step", {
    id: ulid(),
    task_id: String(meta.payload.task_id),
    session_id: deps.sessionId,
    sdlc_step: "build",
    model: entry.id,
    effort: routed?.decision.effort ?? "medium",
    agent_id: "native",
    ...usage,
    unit_prices: entry.prices ? { ...entry.prices } : {},
    cost_micro_usd: cost,
    budget_tokens: routed?.decision.budget_tokens ?? 1_000_000,
    overrun: "none",
    span_id: null,
    schema_version: 1,
  });

  // AGT-12: record the bandit outcome for a routed mechanical/T0 arm (the
  // scope AGT-10 draws exploration on). A step that completed without an
  // error is a success (1).
  if (
    deps.routing &&
    routed &&
    (mechanicalStep(chain) || touchedTier(deps.spec, chain) === "T0")
  )
    recordStepOutcome(
      deps.db,
      deps.routing,
      routed.explored?.id ?? routed.decision.target,
      true,
    );

  // AGT-11: record usage against the session budget at the model-call finish,
  // before this step's tool executions. On the 2× pause, interactive surfaces
  // triage (return paused("budget")); headless grants up to BUDGET_HEADLESS_CAP
  // budget extensions (kernel `continue` — the only resolve that clears the
  // pause and grants +1 budget of headroom), then blocks.
  const budget = deps.budgetHolder?.monitor;
  if (budget && !budget.paused) {
    const total =
      usage.tokens_in +
      usage.tokens_out +
      usage.tokens_cache_read +
      usage.tokens_cache_write;
    if (budget.record(total) === "paused") {
      if (deps.headlessAsk === undefined)
        return { status: "paused", reason: "budget" };
      const extensions = budgetEvents(deps.db, deps.sessionId).filter(
        (e) => e.kind === "triage_resolved" && e.action === "continue",
      ).length;
      if (extensions >= BUDGET_HEADLESS_CAP) {
        budget.resolve("block", "auto", "budget_cap");
        return { status: "paused", reason: "budget:blocked" };
      }
      budget.resolve("continue", "auto", "headless_extension");
    }
  }

  if (calls.length === 0) {
    // AGT-7 done-gate: refuse `done` while any accumulated touched clause's
    // obligation is failing at its current governed-file hash. Inject the
    // failures so the next step sees them, and demote done → continue.
    // One post-batch reconstruct serves both the gate and the report —
    // nothing is appended between the two reads.
    const fresh =
      deps.spec && !deps.spec.empty
        ? reconstruct(listEvents(deps.db, deps.sessionId))
        : null;
    if (deps.spec && !deps.spec.empty && fresh) {
      const failing = failingClauses(deps.spec, fresh);
      if (failing.length > 0) {
        // AGT-12: an obligation failure escalates the retry model via the
        // routing ladder rather than silently retrying on the same model.
        let escalationNote = "";
        let escModel: string | null = null;
        if (deps.routing && routed) {
          const esc = escalateStep(deps.db, deps.routing, routed.decision);
          if (esc) {
            escModel = esc.modelId;
            escalationNote = ` The retry is escalated to a stronger model (${esc.decision.target}).`;
          }
        }
        const injected = appendEvent(deps.db, {
          session_id: deps.sessionId,
          parent_id: assistant.id,
          kind: "user_message",
          payload: {
            text: `Cannot finish: obligation checks are still failing for clause(s) ${failing.join(", ")}. Fix the governed code so their tests pass before ending.${escalationNote}`,
          },
        });
        // The escalation is a one-shot session_meta appended LAST so the next
        // step's routing block sees it as the chain tail (then routing resumes).
        // AGT-16/F-178: the demotion tail is exempt from auto-compaction —
        // the injected instruction and the escalation marker (which the next
        // step reads at TAIL position) must reach the next call untouched.
        if (escModel !== null)
          appendEvent(deps.db, {
            session_id: deps.sessionId,
            parent_id: injected.id,
            kind: "session_meta",
            payload: { routing_escalation: { modelId: escModel } },
          });
        return { status: "continue" };
      }
    }
    // AGT-9: a spec-native session emits one VerificationReport at end.
    if (deps.spec && !deps.spec.empty && fresh)
      emitVerificationReport(
        deps.db,
        deps.spec,
        String(meta.payload.task_id),
        fresh,
      );
    endSession(deps.db, deps.sessionId);
    return { status: "done", text };
  }
  const chainWithAssistant = [...chain, assistant];
  return finishStep(await resolveTools(deps, chainWithAssistant));

  // AGT-16: the trigger runs once, at the step's tail after every event has
  // appended, and only for a `continue` step — a paused step's pending
  // assistant_message must stay reachable (compacting it bricks resume,
  // divergence pin 2026-07-11), and a done step has no next call. The entry
  // is the step-local UX-17-resolved one, so a mid-session switch compares
  // against the switched-to window. The AGT-7 demotion exit above is exempt
  // (F-178), and the resumed-pending-tools exit issues no model call so it
  // reports no footprint — neither routes through here.
  function finishStep(result: StepResult): StepResult {
    if (result.status !== "continue") return result;
    const u = deps.autoCompactOverride?.usage ?? usage;
    const w = deps.autoCompactOverride?.contextWindow ?? entry.context_window;
    if (autoCompactDue(u, w))
      compactSession(
        deps.db,
        deps.sessionId,
        deps.autoCompactSummarizer ?? deterministicDigest,
      );
    return result;
  }
};

// The shared driver for chat, run -p, and the api executor. stepLimit is a
// runaway safety valve; a RoutingContext adds a real per-session BudgetMonitor
// (AGT-11) that pauses at 2× the routed budget.
export const runTurn = async (
  deps: StepDeps,
  stepLimit = 50,
): Promise<StepResult> => {
  // AGT-11: a durable budget pause survives a fresh process — re-derive it
  // from the append-only budget-event stream before running any step.
  if (deps.routing && sessionPausedForBudget(deps.db, deps.sessionId))
    return { status: "paused", reason: validatePauseReason("budget") };
  // AGT-11: one session-scoped monitor holder, seeded on the first routed step.
  const runDeps: StepDeps = deps.routing
    ? { ...deps, budgetHolder: deps.budgetHolder ?? { monitor: null } }
    : deps;
  for (let i = 0; i < stepLimit; i++) {
    const result = await step(runDeps);
    if (result.status !== "continue") return result;
  }
  return { status: "paused", reason: validatePauseReason("step_limit") };
};

// AGT-5: resuming a session whose lifecycle state is not "paused" refuses
// with a distinct error and appends nothing.
export const resume = async (deps: StepDeps): Promise<StepResult> => {
  assertResumable(reconstruct(listEvents(deps.db, deps.sessionId)));
  return runTurn(deps);
};
