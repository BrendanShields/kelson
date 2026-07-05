import type { SessionEvent } from "@kelson/schemas";
import type { ModelMessage, SystemModelMessage } from "ai";

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export const toMessages = (chain: SessionEvent[]): ModelMessage[] => {
  const messages: ModelMessage[] = [];
  for (const e of chain) {
    if (e.kind === "user_message") {
      messages.push({ role: "user", content: String(e.payload.text) });
    } else if (e.kind === "assistant_message") {
      const calls = (e.payload.tool_calls ?? []) as ToolCall[];
      const content = [
        ...(e.payload.text
          ? [{ type: "text" as const, text: String(e.payload.text) }]
          : []),
        ...calls.map((c) => ({
          type: "tool-call" as const,
          toolCallId: c.id,
          toolName: c.name,
          input: c.input,
        })),
      ];
      // SES-4: a done turn can carry neither text nor tool calls; providers
      // reject an empty-content assistant message on --continue, so drop it —
      // it references no tool results and loses nothing from the chain.
      if (content.length > 0) messages.push({ role: "assistant", content });
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

export interface AssembledContext {
  // ai v7 requires system content via `instructions` (system-role entries in
  // `messages` are rejected); a SystemModelMessage carries providerOptions —
  // the documented caching path.
  instructions: SystemModelMessage;
  messages: ModelMessage[];
}

// PROV-8: the two prompt-cache breakpoints — the system block and the final
// message. Provider-namespaced: non-Anthropic providers ignore it, so the
// seam carries no provider branching. Shape read from the installed
// @ai-sdk/anthropic .d.ts (message-level providerOptions → cache_control on
// the message's last part), never from memory.
const CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
};

// The SOLE producer of model input: every byte the model sees for a step is
// assembled here from the reconstructed chain — the one seam where prompt
// caching (PROV-8) and auto-compaction attach. The chain's first event is
// the session_meta root carrying the system prompt (SES-1 shape); the
// append-only chain makes each step's prefix byte-stable, so everything
// before the tail breakpoint reads from cache on the next step.
export const assembleContext = (chain: SessionEvent[]): AssembledContext => {
  const meta = chain[0];
  if (!meta || meta.kind !== "session_meta")
    throw new Error("session has no session_meta root");
  const messages = toMessages(chain);
  if (messages.length > 0) {
    const last = messages[messages.length - 1] as ModelMessage;
    messages[messages.length - 1] = {
      ...last,
      providerOptions: { ...last.providerOptions, ...CACHE_BREAKPOINT },
    } as ModelMessage;
  }
  return {
    instructions: {
      role: "system",
      content: String(meta.payload.system),
      providerOptions: CACHE_BREAKPOINT,
    },
    messages,
  };
};
