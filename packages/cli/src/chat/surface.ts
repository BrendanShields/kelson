// UX-30: the four-region cockpit surface — maps the pure view-model
// (view.ts) onto OpenTUI renderables. No reducer logic lives here; app.ts
// wires messages/effects, tests drive this with createTestRenderer.

import {
  ASCIIFontRenderable,
  BoxRenderable,
  type CliRenderer,
  fg,
  InputRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  type StyledText,
  SyntaxStyle,
  TextRenderable,
  t,
} from "@opentui/core";
import { compose } from "./compose.js";
import { type ChatModel } from "./model.js";
import { CHAT_THEME, resolveColor } from "./theme.js";
import {
  budgetPane,
  emptyState,
  headerLine,
  tickerLine,
  transcriptEntryLines,
  type ViewLine,
  vizPane,
} from "./view.js";

// UX-34: the tree pane's lines are injected by app.ts (the builder lives in
// packages/agent and reads the session chain — the surface stays data-blind).
export type RailPaneSource = () => ViewLine[];

type Env = Record<string, string | undefined>;

// One t-template invocation built programmatically: each segment becomes a
// colored chunk via fg(), or a plain string when the role resolves to the
// no-op style (NO_COLOR, UX-29).
const styledFrom = (line: ViewLine, env: Env): string | StyledText => {
  const values = line.map((s) => {
    const color = s.role === null ? null : resolveColor(s.role, env);
    return color === null ? s.text : fg(color)(s.text);
  });
  if (values.every((v) => typeof v === "string")) return values.join("");
  const strings = Object.assign(Array(values.length + 1).fill(""), {
    raw: Array(values.length + 1).fill(""),
  }) as unknown as TemplateStringsArray;
  return t(strings, ...values);
};

const sided = (left: string, right: string, width: number): string => {
  const gap = Math.max(1, width - left.length - right.length - 2);
  return ` ${left}${" ".repeat(gap)}${right} `;
};

export interface ChatSurface {
  input: InputRenderable;
  update: (model: ChatModel) => void;
}

export const createSurface = (
  renderer: CliRenderer,
  env: Env = process.env,
  treeSource: RailPaneSource = () => [],
): ChatSurface => {
  const header = new TextRenderable(renderer, {
    id: "chat-header",
    content: "",
    flexShrink: 0,
  });
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "chat-scroll",
    flexGrow: 1,
    // UX-30 tail-follow is owned by setBody below, not OpenTUI's options:
    // stickyScroll tie-breaks TOP at scrollTop 0 (can't follow from an empty
    // start) and stickyStart:"bottom" blanks content shorter than the
    // viewport — both empirically pinned 2026-07-13.
  });
  const inputRow = new BoxRenderable(renderer, {
    id: "chat-input-row",
    flexDirection: "row",
    flexShrink: 0,
  });
  const prompt = new TextRenderable(renderer, {
    id: "chat-prompt",
    content: "",
    flexShrink: 0,
  });
  const input = new InputRenderable(renderer, {
    id: "chat-input",
    placeholder: "task or /help (esc to quit)",
    flexGrow: 1,
  });
  const ticker = new TextRenderable(renderer, {
    id: "chat-ticker",
    content: "",
    flexShrink: 0,
  });
  // UX-32: middle row hosts transcript + the 30-column rail.
  const middle = new BoxRenderable(renderer, {
    id: "chat-middle",
    flexGrow: 1,
    flexDirection: "row",
  });
  const rail = new BoxRenderable(renderer, {
    id: "chat-rail",
    width: 30,
    flexShrink: 0,
    border: true,
    title: "",
  });
  inputRow.add(prompt);
  inputRow.add(input);
  middle.add(scroll);
  middle.add(rail);
  renderer.root.add(header);
  renderer.root.add(middle);
  renderer.root.add(inputRow);
  renderer.root.add(ticker);

  let railIds: string[] = [];
  const setRail = (model: ChatModel): void => {
    const open = model.rail !== null && renderer.width >= 100;
    rail.visible = open;
    if (!open) return;
    rail.title = ` ${model.rail} `;
    const lines =
      model.rail === "budget"
        ? budgetPane(model)
        : model.rail === "viz"
          ? vizPane(model, env)
          : treeSource();
    for (const id of railIds) rail.remove(id);
    railIds = lines.map((_, i) => `rail-${i}`);
    lines.forEach((line, i) =>
      rail.add(
        new TextRenderable(renderer, {
          id: `rail-${i}`,
          content: styledFrom(line, env),
          marginLeft: 1,
        }),
      ),
    );
  };

  // Children live on scroll.content — adding to the ScrollBox itself lands
  // them beside the scrollbar in the wrapper (caught by the UX-30 snapshot).
  // Keyed update-in-place, never full rebuild: a rebuild resets the scroll
  // measurement every frame and stickyScroll never observes an append, so
  // tail-follow silently dies (empirically pinned 2026-07-13).
  const bodyNodes = new Map<
    string,
    {
      node: TextRenderable | ASCIIFontRenderable | MarkdownRenderable;
      kind: "text" | "markdown" | "made";
    }
  >();
  let following = true;
  let lastFollowClamp = 0;
  // One SyntaxStyle per surface, lazily created (native handle).
  let syntax: SyntaxStyle | null = null;
  const markdownSyntax = (): SyntaxStyle => {
    syntax ??= SyntaxStyle.create();
    return syntax;
  };
  const setBody = (
    parts: {
      id: string;
      text?: string | StyledText;
      // UX-35: markdown widgets render via MarkdownRenderable, streaming —
      // content updates in place through the same keyed path.
      markdown?: string;
      make?: () => TextRenderable | ASCIIFontRenderable;
    }[],
  ): void => {
    // UX-30 tail-follow: OpenTUI's sticky tie-breaks TOP at scrollTop 0, so a
    // transcript growing from empty pins to the top; we follow explicitly.
    // `following` releases when the user scrolls above our last clamp and
    // re-engages when they return to the tail. A plain at-tail check can't
    // work: each clamp lands one layout behind the appended rows.
    const maxScrollTop = Math.max(
      0,
      scroll.scrollHeight - scroll.viewport.height,
    );
    // Release only when scrollTop drops below BOTH the last clamp and the
    // current max: a content shrink (collapsing a fold) or resize re-clamps
    // scrollTop with zero user input, and a plain lastFollowClamp comparison
    // latches following=false forever (F-203, the F-088 non-user-event class).
    if (!following && scroll.scrollTop >= maxScrollTop) following = true;
    else if (
      following &&
      scroll.scrollTop < Math.min(lastFollowClamp, maxScrollTop)
    )
      following = false;
    let appended = false;
    const want = new Set(parts.map((p) => p.id));
    for (const [id] of bodyNodes)
      if (!want.has(id)) {
        scroll.content.remove(id);
        bodyNodes.delete(id);
      }
    for (const p of parts) {
      const existing = bodyNodes.get(p.id);
      if (existing !== undefined) {
        if (existing.kind === "text" && p.text !== undefined)
          (existing.node as TextRenderable).content = p.text;
        else if (existing.kind === "markdown" && p.markdown !== undefined)
          (existing.node as MarkdownRenderable).content = p.markdown;
        continue;
      }
      const node = p.make
        ? p.make()
        : p.markdown !== undefined
          ? new MarkdownRenderable(renderer, {
              id: p.id,
              content: p.markdown,
              streaming: true,
              syntaxStyle: markdownSyntax(),
              marginLeft: 1,
            })
          : new TextRenderable(renderer, {
              id: p.id,
              content: p.text ?? "",
              marginLeft: 1,
            });
      scroll.content.add(node);
      bodyNodes.set(p.id, {
        node,
        kind: p.make ? "made" : p.markdown !== undefined ? "markdown" : "text",
      });
      appended = true;
    }
    // Catch-up included: each clamp lands one layout behind, so a follow-up
    // update() with no appends still pulls the viewport to the real tail.
    if (following && (appended || scroll.scrollTop < maxScrollTop)) {
      scroll.scrollTop = Number.MAX_SAFE_INTEGER;
      lastFollowClamp = scroll.scrollTop;
    }
  };

  const update = (model: ChatModel): void => {
    const width = renderer.width;
    const h = headerLine(model);
    header.content = styledFrom(
      [{ role: "dim", text: sided(h.left, h.right, width) }],
      env,
    );
    const tick = tickerLine(model);
    ticker.content = styledFrom(
      [{ role: "dim", text: sided(tick.left, tick.right, width) }],
      env,
    );
    prompt.content = styledFrom(
      [{ role: "accent", text: ` ${CHAT_THEME.glyphs.user} ` }],
      env,
    );
    setRail(model);

    if (model.entries.length === 0) {
      const meta = { modelId: model.modelId, ...model.meta };
      setBody(
        emptyState(meta).map((el, i) => ({
          id: `empty-${i}`,
          make: () =>
            el.kind === "wordmark"
              ? new ASCIIFontRenderable(renderer, {
                  id: `empty-${i}`,
                  text: el.text,
                  ...(resolveColor("accent", env) !== null
                    ? { color: resolveColor("accent", env) as string }
                    : {}),
                  marginLeft: 2,
                  marginTop: 1,
                })
              : new TextRenderable(renderer, {
                  id: `empty-${i}`,
                  content: styledFrom(el.segs, env),
                  marginLeft: 2,
                }),
        })),
      );
      return;
    }
    // UX-35: per-entry composition — markdown widgets for assistant entries,
    // identity (UX-31 lines) for everything else. Ids are entry-namespaced so
    // streaming deltas hit the same keyed node.
    setBody(
      model.entries.flatMap(
        (
          entry,
          i,
        ): { id: string; text?: string | StyledText; markdown?: string }[] => {
          const decision = compose(entry);
          if (
            decision.kind === "widget" &&
            decision.tree.root.type === "markdown"
          )
            return [{ id: `e${i}-md`, markdown: decision.tree.root.content }];
          return transcriptEntryLines(model, i).map((line, j) => ({
            id: `e${i}-l${j}`,
            text: styledFrom(line, env),
          }));
        },
      ),
    );
  };

  return { input, update };
};
