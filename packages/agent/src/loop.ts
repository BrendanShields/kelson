import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { endSession, safeIngest, ulid } from "@kelson/kernel";
import type {
  ModelRegistryEntry,
  PermissionRule,
  SessionEvent,
} from "@kelson/schemas";
import {
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolSet,
  tool,
} from "ai";
import { costOf, type Usage } from "./llm/registry.ts";
import { decide } from "./permissions.ts";
import {
  appendEvent,
  assertResumable,
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
  // PROV-6/7: how the session authenticates — drives the 401 re-mint hint.
  authKind?: "subscription" | "api_key" | "none";
  // UX-17: lets a step honor a chain-recorded model switch at the next model
  // call. Without it the deps' model is fixed (fixtures, the api executor).
  resolveModel?: (ref: string) => {
    entry: ModelRegistryEntry;
    model: LanguageModel;
  };
  // AGT-7/8/9: the spec-native loop. Absent or empty => inert (Phase 6/7).
  spec?: SpecContext;
  // AGT-8: a recorded human override unblocks the ART-4 write gate.
  override?: { by: string; reason: string };
  onDelta?: (text: string) => void;
  onToolResult?: (name: string, ok: boolean) => void;
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

const toMessages = (chain: SessionEvent[]): ModelMessage[] => {
  const messages: ModelMessage[] = [];
  for (const e of chain) {
    if (e.kind === "user_message") {
      messages.push({ role: "user", content: String(e.payload.text) });
    } else if (e.kind === "assistant_message") {
      const calls = (e.payload.tool_calls ?? []) as ToolCall[];
      messages.push({
        role: "assistant",
        content: [
          ...(e.payload.text
            ? [{ type: "text" as const, text: String(e.payload.text) }]
            : []),
          ...calls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.id,
            toolName: c.name,
            input: c.input,
          })),
        ],
      });
    } else if (e.kind === "tool_result") {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result" as const,
            toolCallId: String(e.payload.tool_call_id),
            toolName: String(e.payload.name),
            output: { type: "text" as const, value: String(e.payload.output) },
          },
        ],
      });
    }
  }
  return messages;
};

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
    let action = decide(rules, call.name, arg);

    if (action === "ask" && deps.headlessAsk !== undefined)
      action = deps.headlessAsk;
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
    deps.onToolResult?.(call.name, !isError);
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
      head = runObligations(deps, deps.spec, toCheck, head);
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
): string => {
  let head = headId;
  const checks = obligationChecks(
    reconstruct(listEvents(deps.db, deps.sessionId)),
  );
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

// AGT-1: one step = exactly one model call plus the tool executions it
// requests; loop control is never delegated to the SDK.
export const step = async (deps: StepDeps): Promise<StepResult> => {
  const chain = reconstruct(listEvents(deps.db, deps.sessionId));
  const meta = chain[0];
  if (!meta || meta.kind !== "session_meta")
    throw new Error("session has no session_meta root");

  if (pendingToolCalls(chain).length > 0) return resolveTools(deps, chain);

  // UX-17: honor a chain-recorded model switch at the next model call —
  // "a step's model id is fixed at the moment its model call is issued".
  const activeRef = sessionModelOf(chain);
  const { entry, model } =
    activeRef !== null && activeRef !== deps.entry.id && deps.resolveModel
      ? deps.resolveModel(activeRef)
      : { entry: deps.entry, model: deps.model };

  // Cast: the SDK's ToolSet union is incompatible with
  // exactOptionalPropertyTypes at this call site; inputs are re-validated by
  // our own Zod schemas in resolveTools before execution.
  const aiTools = Object.fromEntries(
    deps.tools.map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: t.params }),
    ]),
  ) as ToolSet;
  const result = streamText({
    model,
    system: String(meta.payload.system),
    messages: toMessages(chain),
    tools: aiTools,
    ...(deps.abort ? { abortSignal: deps.abort } : {}),
  });

  let text = "";
  const calls: ToolCall[] = [];
  let usage: Usage = {
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
  };
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      text += part.text;
      deps.onDelta?.(part.text);
    } else if (part.type === "tool-call") {
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
      const err =
        part.error instanceof Error
          ? part.error
          : new Error(String(part.error));
      // PROV-7: an auth failure on a subscription token names the re-mint
      // path; no silent retry, no credential fallback mid-session.
      if (
        deps.authKind === "subscription" &&
        (err as { statusCode?: number }).statusCode === 401
      )
        throw new Error(
          `anthropic rejected the subscription token (401) — re-mint it with \`claude setup-token\` and re-run \`kelson auth login anthropic --token <token>\` (PROV-7): ${err.message}`,
        );
      throw err;
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
    effort: "medium",
    agent_id: "native",
    ...usage,
    unit_prices: entry.prices ? { ...entry.prices } : {},
    cost_micro_usd: cost,
    budget_tokens: 1_000_000,
    overrun: "none",
    span_id: null,
    schema_version: 1,
  });

  if (calls.length === 0) {
    // AGT-7 done-gate: refuse `done` while any accumulated touched clause's
    // obligation is failing at its current governed-file hash. Inject the
    // failures so the next step sees them, and demote done → continue.
    if (deps.spec && !deps.spec.empty) {
      const failing = failingClauses(
        deps.spec,
        reconstruct(listEvents(deps.db, deps.sessionId)),
      );
      if (failing.length > 0) {
        appendEvent(deps.db, {
          session_id: deps.sessionId,
          parent_id: assistant.id,
          kind: "user_message",
          payload: {
            text: `Cannot finish: obligation checks are still failing for clause(s) ${failing.join(", ")}. Fix the governed code so their tests pass before ending.`,
          },
        });
        return { status: "continue" };
      }
    }
    // AGT-9: a spec-native session emits one VerificationReport at end.
    if (deps.spec && !deps.spec.empty)
      emitVerificationReport(
        deps.db,
        deps.spec,
        String(meta.payload.task_id),
        reconstruct(listEvents(deps.db, deps.sessionId)),
      );
    endSession(deps.db, deps.sessionId);
    return { status: "done", text };
  }
  const chainWithAssistant = [...chain, assistant];
  return resolveTools(deps, chainWithAssistant);
};

// The shared driver for chat, run -p, and (Phase 7) the api executor.
// stepLimit is a runaway safety valve, not loop control — budgets land in
// Phase 9. ponytail: raise or route through BudgetMonitor then.
export const runTurn = async (
  deps: StepDeps,
  stepLimit = 50,
): Promise<StepResult> => {
  for (let i = 0; i < stepLimit; i++) {
    const result = await step(deps);
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
