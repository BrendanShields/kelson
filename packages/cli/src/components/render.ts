import type { Verdict } from "@kelson/schemas";
import { paint, type Tone } from "./theme.js";

// UX §7 static component set: pure string renderers. The only stdout writer
// in the CLI lives in sink.ts (UX-9); everything here returns strings.

const visibleWidth = (s: string): number =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: measuring rendered width requires stripping ANSI
  s.replace(/\x1b\[[0-9;]*m/g, "").length;

const pad = (s: string, w: number): string =>
  s + " ".repeat(Math.max(0, w - visibleWidth(s)));

const padLeft = (s: string, w: number): string =>
  " ".repeat(Math.max(0, w - visibleWidth(s))) + s;

export const panel = (title: string, body: string, width = 80): string => {
  const inner = width - 2;
  const head = `┌─ ${title} ${"─".repeat(Math.max(0, inner - title.length - 3))}┐`;
  const lines = body.split("\n").map((l) => `│ ${pad(l, inner - 2)} │`);
  return [head, ...lines, `└${"─".repeat(inner)}┘`].join("\n");
};

export const kvGrid = (rows: [string, string][]): string => {
  const w = Math.max(0, ...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${pad(k, w)}  ${v}`).join("\n");
};

export interface Column {
  header: string;
  align?: "left" | "right";
}

export const table = (columns: Column[], rows: string[][]): string => {
  const widths = columns.map((c, i) =>
    Math.max(
      visibleWidth(c.header),
      ...rows.map((r) => visibleWidth(r[i] ?? "")),
    ),
  );
  const fmt = (cells: string[]): string =>
    cells
      .map((cell, i) =>
        (columns[i]?.align === "right" ? padLeft : pad)(
          cell,
          widths[i] as number,
        ),
      )
      .join("  ")
      .trimEnd();
  return [
    fmt(columns.map((c) => c.header)),
    fmt(widths.map((w) => "─".repeat(w))),
    ...rows.map(fmt),
  ].join("\n");
};

const TICKS = "▁▂▃▄▅▆▇█";

export const sparkline = (values: number[]): string => {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  return values
    .map((v) => {
      const t = span === 0 ? 0 : Math.round(((v - min) / span) * 7);
      return TICKS[t] as string;
    })
    .join("");
};

export const sideBySideDiff = (
  left: string,
  right: string,
  width = 80,
): string => {
  const col = Math.floor((width - 3) / 2);
  const ls = left.split("\n");
  const rs = right.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(ls.length, rs.length); i++) {
    const l = ls[i] ?? "";
    const r = rs[i] ?? "";
    const marker = l === r ? " │ " : paint("yellow", " ┃ ");
    out.push(pad(l, col) + marker + r);
  }
  return out.join("\n");
};

export const toned = (tone: Tone, symbol: string, text: string): string =>
  paint(tone, `${symbol} ${text}`);

// UX J3/UX-18: verdict is never a bare pass/fail — decision + effect sizes +
// CIs, and underpowered states its deficit (UX-P5). Shared by eval and bench.
export const renderVerdict = (v: Verdict, minSample = 20): string => {
  const delta = (d: Verdict["fpar_delta"], unit: string) =>
    `${d.mean >= 0 ? "+" : ""}${d.mean.toFixed(3)}${unit} [${d.ci95[0].toFixed(3)}, ${d.ci95[1].toFixed(3)}]`;
  const lines = [
    `verdict: ${v.decision}`,
    `  fpar delta:  ${delta(v.fpar_delta, "")}`,
    `  cost delta:  ${delta(v.cost_delta_pct, "%")}`,
    `  n=${v.n} alpha=${v.alpha} B=${v.bootstrap_resamples}`,
  ];
  if (v.decision === "underpowered")
    lines.push(
      `  underpowered: ${Math.max(0, minSample - v.n)} more paired tasks needed for a powered verdict`,
    );
  if (v.quarantined_tasks.length)
    lines.push(`  quarantined: ${v.quarantined_tasks.join(", ")}`);
  return lines.join("\n");
};
