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
// transcript-focused (divergence-pinned).
export const transcriptLines = (model: ChatModel): ViewLine[] => {
  const folds = foldableIndices(model.entries);
  const selectedEntry =
    model.focus === "transcript" && folds.length > 0
      ? folds[Math.min(model.selected, folds.length - 1)]
      : undefined;
  return model.entries.flatMap((e, i): ViewLine[] => {
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
  });
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
  const state = model.busy
    ? `${spin[model.tickCount % spin.length]} thinking ${g.sep} ${Math.floor(model.tickCount / 10)}s`
    : model.ask !== null
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
