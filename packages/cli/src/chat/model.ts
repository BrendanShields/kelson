import { loadRegistry } from "@kelson/agent";
import type { DispatchTable } from "../wizards.js";

// UX-17: the /model listing IS the exported registry function — identity
// asserted by the obligation test, not a reimplementation.
export const listModels = loadRegistry;

export type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; ok: boolean }
  | { kind: "info"; text: string };

// PERM-4: rule is the matched-rule provenance recorded on the
// permission_request event, or the literal "default".
export type AskRule =
  | { tool: string; arg?: string; action: string }
  | "default";

export interface PermissionAsk {
  requestId: string;
  tool: string;
  arg: string;
  rule: AskRule;
}

// PERM-4: the event payload's provenance is an open-record field; anything
// not shaped like a rule reads as the default-ask marker.
export const askRuleOf = (v: unknown): AskRule => {
  if (v !== null && typeof v === "object" && "tool" in v && "action" in v) {
    const r = v as { tool: unknown; arg?: unknown; action: unknown };
    return {
      tool: String(r.tool),
      ...(r.arg !== undefined ? { arg: String(r.arg) } : {}),
      action: String(r.action),
    };
  }
  return "default";
};

export const askProvenanceLabel = (rule: AskRule): string =>
  rule === "default"
    ? "no rule matched — default ask"
    : `rule: ${rule.tool}${rule.arg !== undefined ? `(${rule.arg})` : ""} → ${rule.action}`;

export interface ChatModel {
  entries: ChatEntry[];
  busy: boolean;
  ask: PermissionAsk | null;
  exited: boolean;
  costMicroUsd: number;
  costUnknown: boolean;
  modelId: string;
}

export type ChatMsg =
  | { type: "submit"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "step_cost"; costMicroUsd: number | null }
  | { type: "paused"; ask: PermissionAsk }
  | { type: "answer"; decision: "allow" | "deny"; always: boolean }
  | { type: "turn_done"; status: "done" | "paused"; reason?: string }
  | { type: "model_switched"; to: string }
  | { type: "info"; text: string }
  | { type: "error"; message: string };

export type ChatEffect =
  | { type: "send_user"; text: string }
  | {
      type: "answer_permission";
      requestId: string;
      decision: "allow" | "deny";
      always: boolean;
    }
  | { type: "dispatch"; command: string; argv: string[] }
  | { type: "list_models" }
  | { type: "switch_model"; id: string }
  | { type: "exit" };

// UX-14: slash commands dispatch through the same functions as typed CLI
// commands (F-085) — this map IS the identity, checked by the obligation test.
export const slashTargets = (
  commands: DispatchTable,
): Record<string, DispatchTable[string]> => {
  const targets: Record<string, DispatchTable[string]> = {};
  if (commands.route) targets["/route"] = commands.route;
  return targets;
};

export const HELP_TEXT = [
  "/help — this help",
  "/model [id] — list registry models or switch the session model (UX-17)",
  "/route <flags> — routing transparency (same as `kelson route explain`)",
  "/exit — leave the chat",
].join("\n");

export const createChat = (modelId: string): ChatModel => ({
  entries: [],
  busy: false,
  ask: null,
  exited: false,
  costMicroUsd: 0,
  costUnknown: false,
  modelId,
});

export const update = (
  model: ChatModel,
  msg: ChatMsg,
): { model: ChatModel; effects: ChatEffect[] } => {
  switch (msg.type) {
    case "submit": {
      const text = msg.text.trim();
      if (text === "") return { model, effects: [] };
      // UX-17 (audit re-pin): the TUI serializes turns — a control command or
      // message submitted mid-generation is rejected with a message, never
      // applied mid-step (which would orphan a switch off the chain).
      if (model.busy)
        return {
          model: {
            ...model,
            entries: [
              ...model.entries,
              {
                kind: "info",
                text: "busy — wait for the current turn to finish",
              },
            ],
          },
          effects: [],
        };
      if (text === "/exit")
        return {
          model: { ...model, exited: true },
          effects: [{ type: "exit" }],
        };
      if (text === "/help")
        return {
          model: {
            ...model,
            entries: [...model.entries, { kind: "info", text: HELP_TEXT }],
          },
          effects: [],
        };
      if (text === "/model")
        return { model, effects: [{ type: "list_models" }] };
      if (text.startsWith("/model ")) {
        const id = text.slice("/model ".length).trim();
        // UX-17: selecting the already-active model appends nothing.
        if (id === model.modelId)
          return {
            model: {
              ...model,
              entries: [
                ...model.entries,
                { kind: "info", text: `${id} is already the active model` },
              ],
            },
            effects: [],
          };
        return { model, effects: [{ type: "switch_model", id }] };
      }
      if (text.startsWith("/")) {
        const [command = "", ...args] = text.slice(1).split(/\s+/);
        return {
          model,
          effects: [{ type: "dispatch", command, argv: args }],
        };
      }
      return {
        model: {
          ...model,
          busy: true,
          entries: [
            ...model.entries,
            { kind: "user", text },
            { kind: "assistant", text: "" },
          ],
        },
        effects: [{ type: "send_user", text }],
      };
    }
    case "delta": {
      const entries = [...model.entries];
      const last = entries[entries.length - 1];
      if (last?.kind === "assistant")
        entries[entries.length - 1] = { ...last, text: last.text + msg.text };
      else entries.push({ kind: "assistant", text: msg.text });
      return { model: { ...model, entries }, effects: [] };
    }
    case "tool_result":
      return {
        model: {
          ...model,
          entries: [
            ...model.entries,
            { kind: "tool", name: msg.name, ok: msg.ok },
            { kind: "assistant", text: "" },
          ],
        },
        effects: [],
      };
    case "step_cost":
      return {
        model: {
          ...model,
          costMicroUsd: model.costMicroUsd + (msg.costMicroUsd ?? 0),
          costUnknown: model.costUnknown || msg.costMicroUsd === null,
        },
        effects: [],
      };
    case "paused":
      return { model: { ...model, ask: msg.ask }, effects: [] };
    case "answer": {
      if (!model.ask) return { model, effects: [] };
      const { requestId } = model.ask;
      return {
        model: { ...model, ask: null },
        effects: [
          {
            type: "answer_permission",
            requestId,
            decision: msg.decision,
            always: msg.always,
          },
        ],
      };
    }
    case "turn_done":
      return {
        model: {
          ...model,
          busy: false,
          entries:
            msg.status === "paused" && msg.reason !== undefined
              ? [
                  ...model.entries,
                  { kind: "info", text: `paused: ${msg.reason}` },
                ]
              : model.entries,
        },
        effects: [],
      };
    case "model_switched":
      return {
        model: {
          ...model,
          modelId: msg.to,
          entries: [
            ...model.entries,
            { kind: "info", text: `model → ${msg.to}` },
          ],
        },
        effects: [],
      };
    case "info":
      return {
        model: {
          ...model,
          entries: [...model.entries, { kind: "info", text: msg.text }],
        },
        effects: [],
      };
    case "error":
      return {
        model: {
          ...model,
          busy: false,
          entries: [
            ...model.entries,
            { kind: "info", text: `error: ${msg.message}` },
          ],
        },
        effects: [],
      };
  }
};

const GLYPH = { ok: "✓", fail: "✗" };

export const renderChat = (model: ChatModel): string => {
  const lines = model.entries.flatMap((e) => {
    if (e.kind === "user") return [`> ${e.text}`];
    if (e.kind === "tool")
      return [`  ${e.ok ? GLYPH.ok : GLYPH.fail} ${e.name}`];
    if (e.kind === "info") return [e.text];
    return e.text === "" ? [] : [e.text];
  });
  const cost = model.costUnknown
    ? `≥$${(model.costMicroUsd / 1_000_000).toFixed(4)} (some steps unpriced)`
    : `$${(model.costMicroUsd / 1_000_000).toFixed(4)}`;
  const status = model.busy ? "thinking…" : "ready";
  // PERM-4: a pending ask names the tool, its primary arg, and provenance.
  const ask = model.ask
    ? `\npermission ask: ${model.ask.tool} ${model.ask.arg}\n  ${askProvenanceLabel(model.ask.rule)}`
    : "";
  return `${lines.join("\n")}${ask}\n\n[${model.modelId} · ${cost} · ${status}]`;
};
