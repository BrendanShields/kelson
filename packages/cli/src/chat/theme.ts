// UX-29: the single token module for the chat surface — every color and glyph
// resolves through here. Alternates ship as sibling token files (a swap, never
// renderer conditionals). Quiet Pro defaults approved 2026-07-12.

export type ColorRole =
  | "accent"
  | "user"
  | "tool"
  | "warn"
  | "err"
  | "ok"
  | "dim"
  | "fg"
  | "surface";

export type GlyphRole =
  | "user"
  | "asst"
  | "fold"
  | "unfold"
  | "err"
  | "ok"
  | "info"
  | "cur"
  | "sep";

export interface ChatTheme {
  colors: Record<ColorRole, string>;
  glyphs: Record<GlyphRole, string> & { spin: string[]; bar: string[] };
}

export const CHAT_THEME: ChatTheme = {
  colors: {
    accent: "#8b9af7",
    user: "#e8ebf5",
    tool: "#6fc3d8",
    warn: "#e0b060",
    err: "#e07a7a",
    ok: "#7fc98a",
    dim: "#5c6480",
    fg: "#c3c9dd",
    surface: "#1a2233",
  },
  glyphs: {
    user: "❯",
    asst: "●",
    fold: "▸",
    unfold: "▾",
    err: "✖",
    ok: "✓",
    info: "◆",
    cur: "▌",
    sep: "·",
    spin: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    bar: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  },
};

// UX-4/UX-29: under NO_COLOR every color role resolves to the no-op style
// (null — the renderer applies nothing); glyphs and structure are unchanged.
// Presence semantics, not truthiness: NO_COLOR="" strips color, matching
// components/theme.ts and sink.ts (audit pin 2026-07-13, F-198).
export const resolveColor = (
  role: ColorRole,
  env: Record<string, string | undefined> = process.env,
): string | null =>
  env.NO_COLOR !== undefined ? null : CHAT_THEME.colors[role];

// UX-35 (themed 2026-07-20): the markdown token style map, colors resolved at
// build time through resolveColor so NO_COLOR yields the same map minus
// fg/bg — attributes (bold/italic/underline) are structure, never stripped.
export interface MarkdownTokenStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export const markdownStyles = (
  env: Record<string, string | undefined> = process.env,
): Record<string, MarkdownTokenStyle> => {
  const c = (role: ColorRole): { fg?: string } => {
    const v = resolveColor(role, env);
    return v === null ? {} : { fg: v };
  };
  const b = (role: ColorRole): { bg?: string } => {
    const v = resolveColor(role, env);
    return v === null ? {} : { bg: v };
  };
  return {
    "markup.heading": { bold: true, underline: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { ...c("tool"), ...b("surface") },
    "markup.raw.block": { ...c("tool"), ...b("surface") },
    "markup.link.url": { ...c("accent"), underline: true },
  };
};
