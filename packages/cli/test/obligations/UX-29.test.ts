import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_THEME,
  type ColorRole,
  resolveColor,
} from "../../src/chat/theme.js";

const PINNED_COLORS: Record<ColorRole, string> = {
  accent: "#8b9af7",
  user: "#e8ebf5",
  tool: "#6fc3d8",
  warn: "#e0b060",
  err: "#e07a7a",
  ok: "#7fc98a",
  dim: "#5c6480",
  fg: "#c3c9dd",
  surface: "#1a2233",
};

describe("UX-29: chat theme tokens — single module, pinned Quiet Pro, NO_COLOR no-op", () => {
  it("color-role key set and values equal the pinned Quiet Pro palette", () => {
    // revert-check: change any hex in theme.ts (or add/drop a role) → the
    // toEqual on the full record fails naming the drifted role.
    expect(CHAT_THEME.colors).toEqual(PINNED_COLORS);
  });

  it("glyph-role key set is exactly the enumerated eleven; spin/bar non-empty", () => {
    expect(Object.keys(CHAT_THEME.glyphs).sort()).toEqual(
      [
        "asst",
        "bar",
        "cur",
        "err",
        "fold",
        "info",
        "ok",
        "sep",
        "spin",
        "unfold",
        "user",
      ].sort(),
    );
    expect(CHAT_THEME.glyphs.spin.length).toBeGreaterThan(0);
    expect(CHAT_THEME.glyphs.bar.length).toBeGreaterThan(0);
  });

  it("NO_COLOR resolves EVERY color role to the no-op style — presence, not truthiness", () => {
    // Loop over all roles, not one representative (clause wording).
    // revert-check: restore the truthiness check (env.NO_COLOR ?) → the
    // NO_COLOR:"" arm fails on every role (F-198 boundary).
    for (const role of Object.keys(PINNED_COLORS) as ColorRole[]) {
      expect(resolveColor(role, { NO_COLOR: "1" })).toBeNull();
      expect(resolveColor(role, { NO_COLOR: "" })).toBeNull();
      expect(resolveColor(role, {})).toBe(PINNED_COLORS[role]);
    }
  });

  it("no chat source file (recursive) other than theme.ts carries a hex literal or marker glyph", () => {
    const dir = join(import.meta.dir, "../../src/chat");
    // Marker set derived from the theme, never a hardcoded copy; sep/spin/bar
    // are the recorded prose-safe exclusions (clause wording).
    const { sep: _s, spin: _sp, bar: _b, ...markers } = CHAT_THEME.glyphs;
    const glyphs = Object.values(markers);
    expect(glyphs.length).toBe(8);
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter(
      (f) => f.endsWith(".ts") && !f.endsWith("theme.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      // revert-check: hardcode "#8b9af7" or "❯" in app.ts → this names the file.
      expect(src).not.toMatch(/#[0-9a-fA-F]{6}/);
      for (const g of glyphs) expect(src.includes(g)).toBe(false);
    }
  });
});
