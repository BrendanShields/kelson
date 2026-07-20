// UX-38: the shell-owned command menu — bordered panel + SelectRenderable
// over MENU_ITEMS (the PERM-4 ask-menu precedent). Enter runs the selected
// command through the same submit path as typing it; esc closes without
// exiting the chat.

import {
  BoxRenderable,
  type CliRenderer,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import { MENU_ITEMS } from "./model.js";
import { styledFrom } from "./surface.js";
import { CHAT_THEME, resolveColor } from "./theme.js";

type Env = Record<string, string | undefined>;

export interface CommandMenu {
  mounted: () => boolean;
  close: () => void;
}

export const createCommandMenu = (
  renderer: CliRenderer,
  env: Env,
  onRun: (command: string) => void,
  onClose: () => void,
): CommandMenu => {
  const panel = new BoxRenderable(renderer, {
    id: "cmd-menu",
    border: true,
    title: " commands ",
    flexDirection: "column",
    flexShrink: 0,
  });
  const dim = resolveColor("dim", env);
  const surface = resolveColor("surface", env);
  const select = new SelectRenderable(renderer, {
    id: "cmd-menu-select",
    options: MENU_ITEMS.map((m) => ({
      name: m.command,
      description: m.description,
      value: m.command,
    })),
    showDescription: true,
    ...(dim !== null ? { descriptionColor: dim } : {}),
    ...(surface !== null ? { focusedBackgroundColor: surface } : {}),
    height: MENU_ITEMS.length * 2,
  });
  const hintText = `↑↓ move ${CHAT_THEME.glyphs.sep} enter run ${CHAT_THEME.glyphs.sep} esc close`;
  const hint = new TextRenderable(renderer, {
    id: "cmd-menu-hint",
    content: styledFrom([{ role: "dim", text: hintText }], env),
    marginLeft: 1,
  });
  panel.add(select);
  panel.add(hint);
  renderer.root.add(panel);
  select.focus();

  let isMounted = true;
  const dismount = (): void => {
    if (!isMounted) return;
    isMounted = false;
    renderer.root.remove(panel.id);
  };
  select.on(
    SelectRenderableEvents.ITEM_SELECTED,
    (_i: number, opt: { value: string }) => {
      dismount();
      onRun(opt.value);
    },
  );
  return {
    mounted: () => isMounted,
    close: () => {
      dismount();
      onClose();
    },
  };
};

// UX-38: the esc keypress guard — a mounted menu owns escape (closes the
// menu); a mounted ask-menu suppresses esc entirely (answer explicitly,
// PERM-4); only bare esc reaches the exit branch. askMounted is required so
// the typechecker enumerates every caller of the whole decision (F-085).
export const handleEscape = (
  menu: CommandMenu | null,
  askMounted: boolean,
  exit: () => void,
): void => {
  if (menu !== null && menu.mounted()) menu.close();
  else if (!askMounted) exit();
};
