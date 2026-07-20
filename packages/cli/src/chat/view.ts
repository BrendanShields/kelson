// UX-30/UX-31: pure view-model for the chat cockpit — segment arrays with
// color ROLES (never hex; resolution happens at the render edge via
// resolveColor, UX-29). Headlessly testable; no OpenTUI imports.

import {
  type ChatModel,
  foldableIndices,
  isFoldable,
  lineCount,
} from "./model.js";
import { CHAT_THEME, type ColorRole } from "./theme.js";

export interface Seg {
  role: ColorRole | null;
  text: string;
}
export type ViewLine = Seg[];

export interface ChatMeta {
  modelId: string;
  authKind: string;
  contextWindow: number;
  repoName: string;
  branch: string | null;
}

export type EmptyStateElement =
  | { kind: "wordmark"; text: string }
  | { kind: "line"; segs: ViewLine };

const g = CHAT_THEME.glyphs;

const ctxLabel = (cw: number): string =>
  cw >= 1_000_000 ? `${cw / 1_000_000}M ctx` : `${Math.round(cw / 1000)}k ctx`;

// UX-30: seven elements, in order; the first entry replaces them.
export const emptyState = (meta: ChatMeta): EmptyStateElement[] => [
  { kind: "wordmark", text: "obligato" },
  { kind: "line", segs: [{ role: "dim", text: "spec-first agent harness" }] },
  {
    kind: "line",
    segs: [
      { role: "fg", text: "model  " },
      { role: "accent", text: meta.modelId },
      {
        role: "dim",
        text: ` ${g.sep} ${ctxLabel(meta.contextWindow)} ${g.sep} ${meta.authKind}`,
      },
    ],
  },
  {
    kind: "line",
    segs: [
      { role: "fg", text: "repo   " },
      { role: "fg", text: meta.repoName },
      ...(meta.branch !== null
        ? [{ role: "dim" as const, text: ` ${g.sep} ${meta.branch}` }]
        : []),
    ],
  },
  {
    kind: "line",
    segs: [
      { role: "dim", text: `${g.info} try  ` },
      { role: "fg", text: '"add a divergence test for PERM-5"' },
    ],
  },
  {
    kind: "line",
    segs: [
      { role: "dim", text: `${g.info} try  ` },
      { role: "fg", text: '"why did CI fail on the last push?"' },
    ],
  },
  {
    kind: "line",
    segs: [
      {
        role: "dim",
        text: `/model ${g.sep} /route ${g.sep} /help ${g.sep} /exit`,
      },
    ],
  },
];

// UX-30 cost formatting: ~ for subscription (PROV-6 yardstick, T2.5),
// unpriced suffix for unknown (PROV-3), both compose.
export const costText = (args: {
  authKind: string;
  costMicroUsd: number;
  costUnknown: boolean;
}): string => {
  const base = `$${(args.costMicroUsd / 1_000_000).toFixed(4)}`;
  const marked = args.authKind === "subscription" ? `~${base}` : base;
  return args.costUnknown ? `${marked} (some steps unpriced)` : marked;
};

// UX-31: transcript as role-tagged lines. The selection accents only while
// transcript-focused (divergence-pinned). Per-entry form exported for the
// UX-35 composer's identity path (one fold implementation, F-085).
export const transcriptEntryLines = (
  model: ChatModel,
  index: number,
): ViewLine[] => {
  const folds = foldableIndices(model.entries);
  const selectedEntry =
    model.focus === "transcript" && folds.length > 0
      ? folds[Math.min(model.selected, folds.length - 1)]
      : undefined;
  const e = model.entries[index];
  if (e === undefined) return [];
  return entryLines(e, index, selectedEntry);
};

export const transcriptLines = (model: ChatModel): ViewLine[] => {
  const folds = foldableIndices(model.entries);
  const selectedEntry =
    model.focus === "transcript" && folds.length > 0
      ? folds[Math.min(model.selected, folds.length - 1)]
      : undefined;
  return model.entries.flatMap((e, i): ViewLine[] =>
    entryLines(e, i, selectedEntry),
  );
};

const entryLines = (
  e: ChatModel["entries"][number],
  i: number,
  selectedEntry: number | undefined,
): ViewLine[] => {
  return ((): ViewLine[] => {
    if (e.kind === "user")
      return [
        [
          { role: "user", text: `${g.user} ` },
          { role: "fg", text: e.text },
        ],
      ];
    if (e.kind === "info")
      return e.text.split("\n").map(
        (line, li): ViewLine =>
          li === 0
            ? [
                { role: "dim", text: `${g.info} ` },
                { role: "fg", text: line },
              ]
            : [{ role: "fg", text: `  ${line}` }],
      );
    if (e.kind === "assistant")
      return e.text === ""
        ? []
        : e.text
            .split("\n")
            .map((line): ViewLine => [{ role: "fg", text: line }]);
    // UX-37: error panel — err glyph headline, dim hint/detail; not foldable.
    if (e.kind === "error")
      return [
        [
          { role: "err", text: `${g.err} ` },
          { role: "err", text: e.headline },
        ],
        ...(e.hint !== null
          ? [[{ role: "dim" as const, text: `  ${e.hint}` }]]
          : []),
        ...e.detail.map((d): ViewLine => [{ role: "dim", text: `  ${d}` }]),
      ];
    // tool
    const status: Seg = e.ok
      ? { role: "ok", text: g.ok }
      : { role: "err", text: g.err };
    if (!isFoldable(e))
      return [
        [{ role: "tool", text: `  ${status.text} ${e.name}` }],
        ...e.output
          .split("\n")
          .map((line): ViewLine => [{ role: "dim", text: `  ${line}` }]),
      ];
    const n = lineCount(e.output);
    const summaryText = e.expanded
      ? `  ${g.unfold} ${e.name} ${status.text} ${n} lines`
      : `  ${g.fold} ${e.name} ${status.text} ${n} lines (enter expands)`;
    const summary: ViewLine =
      i === selectedEntry
        ? [{ role: "accent", text: summaryText }]
        : [{ role: "tool", text: summaryText }];
    return e.expanded
      ? [
          summary,
          ...e.output
            .split("\n")
            .map((line): ViewLine => [{ role: "dim", text: `  ${line}` }]),
        ]
      : [summary];
  })();
};

// UX-30/31: ticker — spinner segment only while busy; state word otherwise.
export const tickerLine = (
  model: ChatModel,
): { left: string; right: string } => {
  const cost = costText({
    authKind: model.meta.authKind,
    costMicroUsd: model.costMicroUsd,
    costUnknown: model.costUnknown,
  });
  const spin = CHAT_THEME.glyphs.spin;
  const derived = chatState(model);
  const state =
    derived === "thinking"
      ? `${spin[model.tickCount % spin.length]} thinking ${g.sep} ${Math.floor(model.tickCount / 10)}s`
      : derived === "paused"
        ? "paused"
        : "ready";
  return { left: `${cost} ${g.sep} ${state}`, right: `/help ${g.sep} esc` };
};

// UX-33: linear min–max scaling over the window's priced values;
// max === min maps every priced step to index 0; null renders the sep glyph.
export const sparkline = (costs: (number | null)[]): string => {
  const bar = CHAT_THEME.glyphs.bar;
  const priced = costs.filter((c): c is number => c !== null);
  const min = Math.min(...priced);
  const max = Math.max(...priced);
  return costs
    .map((c) => {
      if (c === null) return g.sep;
      const idx =
        max === min
          ? 0
          : Math.round(((c - min) / (max - min)) * (bar.length - 1));
      return bar[idx] as string;
    })
    .join("");
};

// UX-33: the budget pane's data lines — spent via the SAME costText the
// ticker uses (F-085), burn over the last 14 steps, avg/max over priced only.
export const budgetPane = (model: ChatModel): ViewLine[] => {
  if (model.stepCosts.length === 0)
    return [[{ role: "dim", text: "no steps yet" }]];
  const window = model.stepCosts.slice(-14);
  const priced = model.stepCosts.filter((c): c is number => c !== null);
  const unpriced = model.stepCosts.length - priced.length;
  const usd = (v: number): string => `$${(v / 1_000_000).toFixed(4)}`;
  const stepStats =
    priced.length === 0
      ? "all unpriced"
      : `avg ${usd(priced.reduce((a, b) => a + b, 0) / priced.length)} ${g.sep} max ${usd(Math.max(...priced))}`;
  return [
    [
      { role: "fg", text: "spent  " },
      {
        role: "accent",
        text: costText({
          authKind: model.meta.authKind,
          costMicroUsd: model.costMicroUsd,
          costUnknown: model.costUnknown,
        }),
      },
    ],
    [
      { role: "fg", text: "burn   " },
      { role: "accent", text: sparkline(window) },
      { role: "dim", text: `  last ${window.length}` },
    ],
    [
      { role: "fg", text: "step   " },
      { role: "fg", text: stepStats },
      ...(unpriced > 0
        ? [{ role: "dim" as const, text: ` ${g.sep} ${unpriced} unpriced` }]
        : []),
    ],
  ];
};

// UX-34: one depth computation for pane and CLI (audit hoist 2026-07-13 —
// two inline walks were F-085-adjacent duplication).
export interface TreeNodeLike {
  id: string;
  label: string;
  parent: string | null;
}

export const treeDepth = (
  nodes: TreeNodeLike[],
  node: TreeNodeLike,
): number => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let depth = 0;
  let cursor = node.parent;
  while (cursor !== null) {
    depth++;
    cursor = byId.get(cursor)?.parent ?? null;
  }
  return depth;
};

// UX-34: rail tree pane — same builder output as the CLI (F-085); indent two
// spaces per depth; the head-suffixed node carries the accent role.
export const treePaneLines = (nodes: TreeNodeLike[]): ViewLine[] => {
  if (nodes.length === 0) return [[{ role: "dim", text: "no events yet" }]];
  return nodes.map((n) => [
    {
      role: n.label.endsWith("← head") ? ("accent" as const) : ("fg" as const),
      text: `${"  ".repeat(treeDepth(nodes, n))}${n.label}`,
    },
  ]);
};

export const headerLine = (
  model: ChatModel,
): { left: string; right: string } => ({
  left: "obligato chat",
  right: `${model.modelId} ${g.sep} ${model.meta.authKind}`,
});

// UX-36 (rewritten 2026-07-20): the agent cockpit — tasks / activity / tools
// sections derived purely from reducer state. Same model projection + tick →
// byte-identical lines (F-126).
export type VizState = "idle" | "thinking" | "paused";

// F-212 (audit pin): a production ask arrives with busy STILL TRUE (paused
// dispatch precedes turn_done), so paused must win over thinking — one shared
// derivation for the viz pane and the ticker state word.
export const chatState = (model: ChatModel): VizState =>
  model.ask !== null ? "paused" : model.busy ? "thinking" : "idle";

// UX-36: rail interior width — lines truncate with `…` as the 26th cell.
export const VIZ_WIDTH = 26;

const clipLine = (line: ViewLine): ViewLine => {
  const total = line.reduce((n, s) => n + s.text.length, 0);
  if (total <= VIZ_WIDTH) return line;
  // Truncating: every kept segment is measured against the width minus the
  // reserved … cell, so an exact-fit segment followed by more text can never
  // overflow (audit 2026-07-20 boundary).
  const out: ViewLine = [];
  let used = 0;
  for (const seg of line) {
    const room = VIZ_WIDTH - 1 - used;
    if (seg.text.length <= room) {
      out.push(seg);
      used += seg.text.length;
      continue;
    }
    out.push({ role: seg.role, text: `${seg.text.slice(0, room)}…` });
    return out;
  }
  return out;
};

export const vizPane = (
  model: ChatModel,
  env: Record<string, string | undefined> = process.env,
): ViewLine[] => {
  const lines: ViewLine[] = [];
  // Paused prepends one warn line above any sections (F-212 derivation).
  if (chatState(model) === "paused")
    lines.push([{ role: "warn", text: "paused" }]);

  if (model.todos.length > 0) {
    const done = model.todos.filter((t) => t.state === "done").length;
    lines.push([{ role: "dim", text: `tasks ${done}/${model.todos.length}` }]);
    for (const t of model.todos)
      lines.push(
        t.state === "done"
          ? [
              { role: "ok", text: `${g.ok} ` },
              { role: "dim", text: t.text },
            ]
          : t.state === "active"
            ? [{ role: "accent", text: `${g.fold} ${t.text}` }]
            : [{ role: "dim", text: `${g.sep} ${t.text}` }],
      );
  }

  if (model.activity.length > 0) {
    const spin = CHAT_THEME.glyphs.spin;
    lines.push([{ role: "dim", text: "activity" }]);
    for (const a of model.activity.slice(-8)) {
      if (a.endTick === null) {
        // Running: spinner frame from the live tick (frozen at 0 under
        // OBLIGATO_NO_MOTION — presence semantics, UX-29) + elapsed seconds.
        const tick = env.OBLIGATO_NO_MOTION !== undefined ? 0 : model.tickCount;
        const elapsed = Math.floor((model.tickCount - a.startTick) / 10);
        lines.push([
          {
            role: "accent",
            text: `${spin[tick % spin.length] as string} ${a.name} ${elapsed}s`,
          },
        ]);
      } else {
        lines.push([
          a.ok === false
            ? { role: "err", text: `${g.err} ` }
            : { role: "ok", text: `${g.ok} ` },
          { role: "tool", text: a.name },
          ...(a.arg === ""
            ? []
            : [{ role: "dim" as const, text: ` ${a.arg}` }]),
        ]);
      }
    }

    // Tools: top 3 by count, ties by first appearance; meter of bar-top cells.
    const counts = new Map<string, number>();
    for (const a of model.activity)
      counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
    const barTop = CHAT_THEME.glyphs.bar[
      CHAT_THEME.glyphs.bar.length - 1
    ] as string;
    lines.push([{ role: "dim", text: "tools" }]);
    for (const [name, count] of [...counts.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3))
      lines.push([
        { role: "dim", text: `${name} ` },
        { role: "accent", text: barTop.repeat(Math.min(count, 10)) },
        { role: "dim", text: ` ${count}` },
      ]);
  }

  if (model.todos.length === 0 && model.activity.length === 0)
    lines.push([{ role: "dim", text: "no activity yet" }]);
  return lines.map(clipLine);
};
