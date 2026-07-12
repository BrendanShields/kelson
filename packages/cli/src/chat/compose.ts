// UX-35: the pure composer — deterministic, total, rule-table-driven. Same
// chain, same decisions (SES-2 extension). Rule 1 is the only content rule
// today; identity falls through to UX-31's transcriptLines (fold semantics
// live in ONE place, F-085).

import type { WidgetTree } from "@obligato/schemas";
import type { ChatEntry } from "./model.js";

export type ComposeDecision =
  | { kind: "widget"; tree: WidgetTree }
  | { kind: "identity" };

interface ComposeRule {
  match: (entry: ChatEntry) => boolean;
  widget: (entry: ChatEntry) => WidgetTree;
}

// Ordered data rule table — never branching scattered through renderers.
const RULES: ComposeRule[] = [
  {
    // Rule 1: non-empty assistant text renders as markdown.
    match: (e) => e.kind === "assistant" && e.text !== "",
    widget: (e) => ({
      schema_version: 1,
      root: {
        type: "markdown",
        content: e.kind === "assistant" ? e.text : "",
      },
    }),
  },
];

export const compose = (entry: ChatEntry): ComposeDecision => {
  for (const rule of RULES)
    if (rule.match(entry)) return { kind: "widget", tree: rule.widget(entry) };
  return { kind: "identity" };
};
