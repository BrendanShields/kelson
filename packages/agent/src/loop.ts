import type { Database } from "bun:sqlite";
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
} from "./sessions.ts";
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

    let output: string;
    let isError = false;
    if (action === "deny") {
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
  return { status: "continue" };
};

// AGT-1: one step = exactly one model call plus the tool executions it
// requests; loop control is never delegated to the SDK.
export const step = async (deps: StepDeps): Promise<StepResult> => {
  const chain = reconstruct(listEvents(deps.db, deps.sessionId));
  const meta = chain[0];
  if (!meta || meta.kind !== "session_meta")
    throw new Error("session has no session_meta root");

  if (pendingToolCalls(chain).length > 0) return resolveTools(deps, chain);

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
    model: deps.model,
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
      throw part.error instanceof Error
        ? part.error
        : new Error(String(part.error));
    }
  }

  const cost = costOf(usage, deps.entry);
  deps.onStepCost?.(cost);
  const assistant = appendEvent(deps.db, {
    session_id: deps.sessionId,
    parent_id: headOf(chain),
    kind: "assistant_message",
    payload: {
      text,
      tool_calls: calls,
      usage: { ...usage },
      model: deps.entry.id,
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
    model: deps.entry.id,
    effort: "medium",
    agent_id: "native",
    ...usage,
    unit_prices: deps.entry.prices ? { ...deps.entry.prices } : {},
    cost_micro_usd: cost,
    budget_tokens: 1_000_000,
    overrun: "none",
    span_id: null,
    schema_version: 1,
  });

  if (calls.length === 0) {
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
