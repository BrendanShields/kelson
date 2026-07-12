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
  | "fg";

export type GlyphRole =
  | "user"
  | "asst"
  | "fold"
  | "unfold"
  | "err"
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
  },
  glyphs: {
    user: "❯",
    asst: "●",
    fold: "▸",
    unfold: "▾",
    err: "✖",
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
