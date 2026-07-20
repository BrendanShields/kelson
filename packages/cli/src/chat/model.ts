import { loadRegistry } from "@obligato/agent";
import type { DispatchTable } from "../wizards.js";
import { CHAT_THEME } from "./theme.js";

// UX-17: the /model listing IS the exported registry function — identity
// asserted by the obligation test, not a reimplementation.
export const listModels = loadRegistry;

export type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      name: string;
      ok: boolean;
      output: string;
      expanded: boolean;
    }
  | { kind: "info"; text: string }
  | { kind: "error"; headline: string; hint: string | null; detail: string[] };

// UX-37: ordered classification table over the raw failure message — first
// matching row wins (the UX-35 rule-table pattern). Stack spew beyond the
// headline + 3 detail lines is dropped from the transcript (recorded).
const ERROR_ROWS: {
  match: RegExp;
  headline: (first: string) => string;
  hint: string | null;
}[] = [
  {
    match: /rate.?limit|429/i,
    headline: () => "rate-limited — the endpoint refused the request",
    hint: "retries exhausted; wait for the usage window to reset, then resend",
  },
  {
    match: /setup-token|401|authentication/i,
    headline: (first) => first,
    hint: "re-mint: claude setup-token, then obligato auth login anthropic --token <new>",
  },
];

export const classifyError = (
  message: string,
): { headline: string; hint: string | null; detail: string[] } => {
  const lines = message.split("\n");
  const first = lines[0] ?? "";
  const detail = lines
    .slice(1)
    .filter((l) => l.trim() !== "")
    .slice(0, 3);
  for (const row of ERROR_ROWS)
    if (row.match.test(message))
      return { headline: row.headline(first), hint: row.hint, detail };
  return {
    headline: first.length > 120 ? `${first.slice(0, 120)}…` : first,
    hint: null,
    detail,
  };
};

// UX-31: raw split length — a trailing newline's empty tail segment counts
// (divergence-pinned 2026-07-13).
export const lineCount = (output: string): number => output.split("\n").length;

export const isFoldable = (e: ChatEntry): boolean =>
  e.kind === "tool" && lineCount(e.output) > 4;

export const foldableIndices = (entries: ChatEntry[]): number[] =>
  entries.flatMap((e, i) => (isFoldable(e) ? [i] : []));

// UX-30: empty-state / header context, fixed at session start.
export interface ChatMetaInfo {
  authKind: string;
  contextWindow: number;
  repoName: string;
  branch: string | null;
}

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
  // UX-31: focus/selection/liveness — selection indexes the ordered foldable
  // subarray (divergence-pinned), tickCount is the only time state (F-126).
  focus: "input" | "transcript";
  selected: number;
  tickCount: number;
  // UX-32/33: rail tab state + per-step cost history (null = unpriced,
  // PROV-3 — never coerced to 0).
  rail: null | "budget" | "tree" | "viz";
  stepCosts: (number | null)[];
  // UX-38: dispatch targets seeded at session start (slashTargets keys) so
  // the unknown-command arm is reducer-owned and headlessly testable.
  knownDispatch: string[];
  // UX-36: the cockpit's data — tool activity (start/end in tick units) and
  // the AGT-19 advisory task list parsed from todo tool results.
  activity: ActivityItem[];
  todos: TodoItem[];
  meta: ChatMetaInfo;
}

export interface ActivityItem {
  name: string;
  arg: string;
  startTick: number;
  endTick: number | null;
  ok: boolean | null;
}

export interface TodoItem {
  text: string;
  state: "pending" | "active" | "done";
}

// UX-36: consumer of the AGT-19 canonical serialization — `[ ] / [>] / [x]`
// lines; "(no tasks)" (or empty) is the empty list; unrecognized lines are
// skipped (KERN-1 never-crash). Format changes are paired AGT-19/UX-36 edits.
export const parseTodos = (output: string): TodoItem[] => {
  const states: Record<string, TodoItem["state"]> = {
    "[ ]": "pending",
    "[>]": "active",
    "[x]": "done",
  };
  return output.split("\n").flatMap((line) => {
    const state = states[line.slice(0, 3)];
    return state !== undefined && line.length > 4
      ? [{ text: line.slice(4), state }]
      : [];
  });
};

export type ChatMsg =
  | { type: "submit"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_start"; name: string; arg: string }
  | { type: "tool_result"; name: string; ok: boolean; output: string }
  | { type: "toggle_fold"; index: number }
  | { type: "key"; key: "tab" | "j" | "k" | "enter" }
  | { type: "tick" }
  | { type: "step_cost"; costMicroUsd: number | null }
  | { type: "paused"; ask: PermissionAsk }
  | { type: "answer"; decision: "allow" | "deny"; always: boolean }
  | { type: "turn_done"; status: "done" | "paused"; reason?: string }
  | { type: "model_switched"; to: string }
  | { type: "info"; text: string }
  | { type: "error"; message: string };

export type ChatEffect =
  | { type: "menu" }
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

// UX-38: the single source of command help (F-085) — the menu renders these
// rows; any future help text derives from this table.
export const MENU_ITEMS: { command: string; description: string }[] = [
  { command: "/help", description: "this menu" },
  {
    command: "/model",
    description: "list registry models or switch the session model (UX-17)",
  },
  {
    command: "/route",
    description: "routing transparency (same as `obligato route explain`)",
  },
  { command: "/budget", description: "toggle the burn rail pane (UX-33)" },
  {
    command: "/tree",
    description: "toggle the session tree rail pane (UX-34)",
  },
  {
    command: "/viz",
    description: "toggle the agent visualizer rail pane (UX-36)",
  },
  { command: "/exit", description: "leave the chat" },
];

// UX-38 (audit W3): knownDispatch is REQUIRED — an optional-with-default on a
// meaning-changing parameter hides callers from the typechecker (F-076→F-085).
export const createChat = (
  modelId: string,
  meta: Partial<ChatMetaInfo>,
  knownDispatch: string[],
): ChatModel => ({
  entries: [],
  busy: false,
  ask: null,
  exited: false,
  costMicroUsd: 0,
  costUnknown: false,
  modelId,
  focus: "input",
  selected: 0,
  tickCount: 0,
  rail: null,
  stepCosts: [],
  knownDispatch,
  activity: [],
  todos: [],
  meta: {
    authKind: "none",
    contextWindow: 0,
    repoName: "",
    branch: null,
    ...meta,
  },
});

// UX-36: turn boundaries close every open activity item at the given tick
// with ok: false — a spinner must never survive turn_done/error (the tick
// reset would render negative elapsed).
const closeOpen = (activity: ActivityItem[], tick: number): ActivityItem[] =>
  activity.some((a) => a.endTick === null)
    ? activity.map((a) =>
        a.endTick === null ? { ...a, endTick: tick, ok: false } : a,
      )
    : activity;

// UX-31: flip one entry's expanded flag; untoggleable/out-of-range targets
// return the unchanged model (divergence-pinned no-op).
const toggleFold = (model: ChatModel, index: number): ChatModel => {
  const entry = model.entries[index];
  if (entry === undefined || entry.kind !== "tool" || !isFoldable(entry))
    return model;
  const entries = [...model.entries];
  entries[index] = { ...entry, expanded: !entry.expanded };
  return { ...model, entries };
};

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
      // UX-38: /help opens the ephemeral command menu — nothing appends, so
      // repeated invocations leave the transcript unchanged by construction.
      if (text === "/help") return { model, effects: [{ type: "menu" }] };
      // UX-32: /budget and /tree toggle the rail — same tab closes, other
      // tab switches. Chat-local view state (recorded: no CLI twin exists
      // for /budget; /tree's CLI twin shares the UX-34 builder).
      if (text === "/budget" || text === "/tree" || text === "/viz") {
        const tab = text.slice(1) as "budget" | "tree" | "viz";
        return {
          model: { ...model, rail: model.rail === tab ? null : tab },
          effects: [],
        };
      }
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
        // UX-38: an unknown slash appends the UX-37-classified error AND
        // opens the menu — the operator sees what exists instead of guessing.
        if (!model.knownDispatch.includes(`/${command}`))
          return {
            model: {
              ...model,
              entries: [
                ...model.entries,
                {
                  kind: "error",
                  ...classifyError(`unknown command /${command}`),
                },
              ],
            },
            effects: [{ type: "menu" }],
          };
        return {
          model,
          effects: [{ type: "dispatch", command, argv: args }],
        };
      }
      return {
        model: {
          ...model,
          busy: true,
          tickCount: 0,
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
    case "tool_start":
      // UX-36: requested-time entry — completed by the matching tool_result.
      return {
        model: {
          ...model,
          activity: [
            ...model.activity,
            {
              name: msg.name,
              arg: msg.arg,
              startTick: model.tickCount,
              endTick: null,
              ok: null,
            },
          ],
        },
        effects: [],
      };
    case "tool_result": {
      // UX-36: complete the open activity item (execution is sequential,
      // AGT-4 order); with none open, append an already-completed item —
      // never dropped (older loop callers lack onToolStart).
      const activity = [...model.activity];
      const openIdx = activity.findLastIndex((a) => a.endTick === null);
      if (openIdx >= 0) {
        const open = activity[openIdx] as ActivityItem;
        activity[openIdx] = { ...open, endTick: model.tickCount, ok: msg.ok };
      } else {
        activity.push({
          name: msg.name,
          arg: "",
          startTick: model.tickCount,
          endTick: model.tickCount,
          ok: msg.ok,
        });
      }
      return {
        model: {
          ...model,
          activity,
          // UX-36: a successful todo result replaces the advisory task list.
          todos:
            msg.name === "todo" && msg.ok
              ? parseTodos(msg.output)
              : model.todos,
          entries: [
            ...model.entries,
            {
              kind: "tool",
              name: msg.name,
              ok: msg.ok,
              output: msg.output,
              expanded: false,
            },
            { kind: "assistant", text: "" },
          ],
        },
        effects: [],
      };
    }
    case "toggle_fold":
      return { model: toggleFold(model, msg.index), effects: [] };
    case "key": {
      if (msg.key === "tab")
        return {
          model: {
            ...model,
            focus: model.focus === "input" ? "transcript" : "input",
          },
          effects: [],
        };
      // UX-31: j/k/enter act only while transcript-focused; other keys reach
      // the input via the shell (never dispatched here when input-focused).
      if (model.focus !== "transcript") return { model, effects: [] };
      const folds = foldableIndices(model.entries);
      if (folds.length === 0) return { model, effects: [] };
      const selected = Math.min(model.selected, folds.length - 1);
      if (msg.key === "j") {
        const next = Math.min(selected + 1, folds.length - 1);
        return next === model.selected
          ? { model, effects: [] }
          : { model: { ...model, selected: next }, effects: [] };
      }
      if (msg.key === "k") {
        const next = Math.max(selected - 1, 0);
        return next === model.selected
          ? { model, effects: [] }
          : { model: { ...model, selected: next }, effects: [] };
      }
      // enter: toggle the selection's entry (transcript index via subarray).
      const target = folds[selected];
      return target === undefined
        ? { model, effects: [] }
        : { model: toggleFold(model, target), effects: [] };
    }
    case "tick":
      // UX-31: idle ticks change nothing — same model reference (F-126
      // fixture determinism: time enters only as counted messages).
      return model.busy
        ? { model: { ...model, tickCount: model.tickCount + 1 }, effects: [] }
        : { model, effects: [] };
    case "step_cost":
      return {
        model: {
          ...model,
          costMicroUsd: model.costMicroUsd + (msg.costMicroUsd ?? 0),
          costUnknown: model.costUnknown || msg.costMicroUsd === null,
          // UX-33: per-step history for the burn sparkline, null preserved.
          stepCosts: [...model.stepCosts, msg.costMicroUsd],
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
          // UX-31: busy ending resets the tick count.
          tickCount: 0,
          // UX-36: a turn boundary never leaves a spinner running — close at
          // the pre-reset tick (audit 2026-07-20: reset made elapsed negative).
          activity: closeOpen(model.activity, model.tickCount),
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
          tickCount: 0,
          // UX-36: same turn-boundary close as turn_done.
          activity: closeOpen(model.activity, model.tickCount),
          entries: [
            ...model.entries,
            { kind: "error", ...classifyError(msg.message) },
          ],
        },
        effects: [],
      };
  }
};

const g = CHAT_THEME.glyphs;

// Plain-text projection (UX-31 shapes, no color roles) — the structured
// view lives in view.ts; this stays for headless assertions and debugging.
export const renderChat = (model: ChatModel): string => {
  const lines = model.entries.flatMap((e) => {
    if (e.kind === "user") return [`${g.user} ${e.text}`];
    if (e.kind === "tool") {
      const status = e.ok ? g.ok : g.err;
      if (!isFoldable(e))
        return [
          `  ${status} ${e.name}`,
          ...(e.output === "" ? [] : e.output.split("\n")),
        ];
      const n = lineCount(e.output);
      return e.expanded
        ? [
            `  ${g.unfold} ${e.name} ${status} ${n} lines`,
            ...e.output.split("\n"),
          ]
        : [`  ${g.fold} ${e.name} ${status} ${n} lines (enter expands)`];
    }
    if (e.kind === "info") return [e.text];
    if (e.kind === "error")
      return [
        `${g.err} ${e.headline}`,
        ...(e.hint !== null ? [`  ${e.hint}`] : []),
        ...e.detail.map((d) => `  ${d}`),
      ];
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
