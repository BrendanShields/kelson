import { z } from "zod";

// Tagged union of exactly nine variants, discriminated on `type`.
// Objects are strict: an unrecognized key fails parse (load-bearing decision).
// Shape-only validation: no cross-field checks (ragged table rows, dangling
// tree parents, duplicate node ids all parse).
// The panel->children recursion breaks Zod 4 type inference through
// z.discriminatedUnion, so ChatWidget's TS type is hand-written and the
// getter is explicitly annotated; z.infer<typeof ChatWidget> collapses to it.

export type ChatWidget =
  | { type: "panel"; title: string; children: ChatWidget[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "diff"; unified: string }
  | { type: "markdown"; content: string }
  | { type: "code"; language: string; content: string }
  | { type: "sparkline"; label: string; values: number[] }
  | {
      type: "tree";
      nodes: { id: string; label: string; parent: string | null }[];
    }
  | {
      type: "ticker";
      // `| undefined` is load-bearing under exactOptionalPropertyTypes: zod's
      // .optional() output type is `boolean | undefined`.
      segments: {
        label: string;
        value: string;
        emphasis?: boolean | undefined;
      }[];
    }
  | { type: "badge"; glyph_role: string; text: string };

const PanelWidget = z.strictObject({
  type: z.literal("panel"),
  title: z.string(),
  get children(): z.ZodType<ChatWidget[]> {
    return z.array(ChatWidget);
  },
});

const TableWidget = z.strictObject({
  type: z.literal("table"),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

const DiffWidget = z.strictObject({
  type: z.literal("diff"),
  unified: z.string(),
});

const MarkdownWidget = z.strictObject({
  type: z.literal("markdown"),
  content: z.string(),
});

const CodeWidget = z.strictObject({
  type: z.literal("code"),
  language: z.string(),
  content: z.string(),
});

const SparklineWidget = z.strictObject({
  type: z.literal("sparkline"),
  label: z.string(),
  values: z.array(z.number()),
});

const TreeNode = z.strictObject({
  id: z.string(),
  label: z.string(),
  parent: z.string().nullable(),
});

const TreeWidget = z.strictObject({
  type: z.literal("tree"),
  nodes: z.array(TreeNode),
});

const TickerSegment = z.strictObject({
  label: z.string(),
  value: z.string(),
  emphasis: z.boolean().optional(),
});

const TickerWidget = z.strictObject({
  type: z.literal("ticker"),
  segments: z.array(TickerSegment),
});

const BadgeWidget = z.strictObject({
  type: z.literal("badge"),
  glyph_role: z.string(),
  text: z.string(),
});

export const ChatWidget = z.discriminatedUnion("type", [
  PanelWidget,
  TableWidget,
  DiffWidget,
  MarkdownWidget,
  CodeWidget,
  SparklineWidget,
  TreeWidget,
  TickerWidget,
  BadgeWidget,
]);

export const WidgetTree = z.strictObject({
  schema_version: z.literal(1),
  root: ChatWidget,
});
export type WidgetTree = z.infer<typeof WidgetTree>;

export const WIDGET_DEGRADE: Record<
  ChatWidget["type"],
  { col80: string; plain: string }
> = {
  panel: {
    col80:
      "keep title as a full-width rule line; render children stacked vertically, each degraded by its own rule",
    plain: "title as a heading line followed by children rendered in sequence",
  },
  table: {
    col80:
      "truncate cell text with a trailing ellipsis to fit; drop columns rightmost-first when the header row exceeds 80 columns",
    plain: "header row then data rows, cells tab-separated, one row per line",
  },
  diff: {
    col80:
      "hard-wrap at 80 columns preserving the +/-/space gutter character on continuation lines",
    plain: "raw unified diff text verbatim",
  },
  markdown: {
    col80:
      "reflow prose to 80 columns; fenced code blocks hard-wrap with a continuation marker",
    plain: "raw markdown source verbatim",
  },
  code: {
    col80:
      "hard-wrap lines at 79 columns with a trailing backslash continuation marker; keep language header",
    plain: "content verbatim with the language tag dropped",
  },
  sparkline: {
    col80: "downsample values to at most 72 ASCII bar cells after the label",
    plain: "label followed by min/max/last numeric summary on one line",
  },
  tree: {
    col80:
      "indent two spaces per depth with ASCII branch guides; truncate labels to the remaining width",
    plain: "flat indented list, two spaces per depth, no branch guides",
  },
  ticker: {
    col80:
      "single line, segments joined by ' | ', truncated at 80 columns with a trailing ellipsis",
    plain: "one 'label: value' line per segment; emphasis ignored",
  },
  badge: {
    col80: "glyph_role mapped to a bracketed ASCII prefix followed by text",
    plain: "'glyph_role: text' on one line",
  },
};
