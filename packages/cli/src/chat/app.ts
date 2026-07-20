import { execSync } from "node:child_process";
import { basename } from "node:path";
import {
  answerPermission,
  appendEvent,
  appendModelSwitch,
  buildSessionTree,
  continueSession,
  createAgentSession,
  currentHead,
  listEvents,
  reconstruct,
  runTurn,
  sessionModelOf,
} from "@obligato/agent";
import {
  createCliRenderer,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
} from "@opentui/core";
import { setupAgent, systemPromptFor } from "../agent/common.js";
import type { DispatchTable } from "../wizards.js";
import { type CommandMenu, createCommandMenu, handleEscape } from "./menu.js";
import {
  askProvenanceLabel,
  askRuleOf,
  type ChatEffect,
  type ChatModel,
  type ChatMsg,
  classifyError,
  createChat,
  listModels,
  slashTargets,
  update,
} from "./model.js";
import { createSurface } from "./surface.js";
import { treePaneLines } from "./view.js";

// UX-39: fatal errors restore the terminal before exiting — an upstream crash
// mid-render (createOptimizedBuffer, 2026-07-20) left mouse-tracking escapes
// spewing into the shell. Once-latched; destroy failing never blocks the exit.
export const fatalGuard = (
  renderer: { destroy: () => void },
  write: (line: string) => void,
  exit: (code: number) => void,
): ((err: unknown) => void) => {
  let ran = false;
  return (err) => {
    if (!ran) {
      ran = true;
      try {
        renderer.destroy();
      } catch {
        // KERN-1 applied to the crash path: the exit below must still run.
      }
      try {
        const message = err instanceof Error ? err.message : String(err);
        write(`fatal: ${classifyError(message).headline}\n`);
      } catch {
        // Never crash the crash handler.
      }
    }
    exit(1);
  };
};

// UX-14: thin OpenTUI shell over the pure reducer in model.ts. The shell
// only feeds ChatMsg events and executes ChatEffects; every state
// transition is reducer-owned and headlessly testable.
export const chatCommand = async (
  argv: string[],
  commands: DispatchTable,
): Promise<void> => {
  const setup = setupAgent();
  const continueId = argv[argv.indexOf("--continue") + 1];
  // SES-4: --continue loads the existing head; otherwise a fresh session.
  const { sessionId, head: startHead } =
    argv.includes("--continue") && continueId !== undefined
      ? continueSession(setup.deps.db, continueId)
      : (() => {
          const created = createAgentSession(setup.deps.db, {
            repo: setup.root,
            lockfile_hash: setup.lockfileHash,
            harness_version: "0.0.1",
            model: setup.entry.id,
            system: systemPromptFor(setup.root),
            auth_kind: setup.authKind,
          });
          return { sessionId: created.sessionId, head: created.rootEventId };
        })();
  let head: string | null = startHead;

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  // UX-39: recorded wiring-untested — the guard function carries all behavior.
  const onFatal = fatalGuard(
    renderer,
    (line) => void process.stderr.write(line),
    (code) => process.exit(code),
  );
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  // UX-17: a continued session's active model derives from the chain.
  const startingModel =
    sessionModelOf(reconstruct(listEvents(setup.deps.db, sessionId))) ??
    setup.entry.id;
  // UX-30: empty-state context — branch best-effort, never an error (AGT-15).
  let branch: string | null = null;
  try {
    const out = execSync("git branch --show-current 2>/dev/null", {
      cwd: setup.root,
      timeout: 5_000,
    })
      .toString()
      .trim();
    branch = out.length > 0 ? out : null;
  } catch {
    branch = null;
  }
  const slash = slashTargets(commands);
  let model = createChat(
    startingModel,
    {
      authKind: setup.authKind,
      contextWindow: setup.entry.context_window,
      repoName: basename(setup.root),
      branch,
    },
    Object.keys(slash),
  );

  // UX-34: the rail tree pane reads the live chain through the same builder
  // as `obligato session tree` (F-085).
  const surface = createSurface(renderer, process.env, () => {
    const events = listEvents(setup.deps.db, sessionId);
    return treePaneLines(buildSessionTree(events, currentHead(events)));
  });
  const { input } = surface;
  input.focus();

  let askMenu: SelectRenderable | null = null;
  let cmdMenu: CommandMenu | null = null;
  const redraw = (): void => {
    surface.update(model);
    // UX-31: focus follows the reducer — transcript focus blurs the input so
    // j/k/enter act on the transcript instead of typing.
    if (model.focus === "input" && !askMenu && !cmdMenu?.mounted())
      input.focus();
    else input.blur();
  };

  // UX-38: at most one command menu mounts at a time — a second open request
  // while mounted is a no-op.
  const openMenu = (): void => {
    if (cmdMenu?.mounted() || askMenu) return;
    input.blur();
    cmdMenu = createCommandMenu(
      renderer,
      process.env,
      (command) => {
        cmdMenu = null;
        input.focus();
        dispatch({ type: "submit", text: command });
      },
      () => {
        cmdMenu = null;
        input.focus();
      },
    );
  };

  const dispatch = (msg: ChatMsg): void => {
    const next = update(model, msg);
    model = next.model;
    redraw();
    for (const effect of next.effects) void runEffect(effect);
  };

  // UX-31: liveness ticks — 100 ms cadence, reducer counts them; idle ticks
  // are reducer no-ops so the timer stays trivially always-on while mounted.
  const tickTimer = setInterval(() => {
    if (model.busy) dispatch({ type: "tick" });
  }, 100);

  // UX-32: the rail's width gate must re-evaluate on terminal resize — OpenTUI
  // re-lays-out with zero dispatch, so without this an open rail survives a
  // shrink below 100 columns (F-205, the F-088 non-user-event class again).
  renderer.on("resize", redraw);

  const showAsk = (): void => {
    if (!model.ask || askMenu) return;
    const ask = model.ask;
    askMenu = new SelectRenderable(renderer, {
      id: "ask-menu",
      options: [
        {
          name: `allow ${ask.tool} once`,
          // PERM-4: the prompt carries the ask's provenance, not just the arg.
          description: `${ask.arg} · ${askProvenanceLabel(ask.rule)}`,
          value: "allow",
        },
        {
          name: `always allow ${ask.tool}`,
          description: "this session",
          value: "always",
        },
        {
          name: "deny",
          description: "the model sees the denial",
          value: "deny",
        },
      ],
      showDescription: true,
      flexShrink: 0,
      height: 5,
    });
    renderer.root.add(askMenu);
    input.blur();
    askMenu.focus();
    askMenu.on(
      SelectRenderableEvents.ITEM_SELECTED,
      (_i: number, opt: { value: string }) => {
        if (askMenu) {
          renderer.root.remove(askMenu.id);
          askMenu = null;
        }
        input.focus();
        dispatch({
          type: "answer",
          decision: opt.value === "deny" ? "deny" : "allow",
          always: opt.value === "always",
        });
      },
    );
  };

  const drive = async (): Promise<void> => {
    const result = await runTurn({
      ...setup.deps,
      sessionId,
      onDelta: (text) => dispatch({ type: "delta", text }),
      onToolStart: (name, arg) => dispatch({ type: "tool_start", name, arg }),
      onToolResult: (name, ok, output) =>
        dispatch({ type: "tool_result", name, ok, output: output ?? "" }),
      onStepCost: (costMicroUsd) =>
        dispatch({ type: "step_cost", costMicroUsd }),
    });
    const chain = reconstruct(listEvents(setup.deps.db, sessionId));
    head = chain[chain.length - 1]?.id ?? head;
    if (result.status === "paused" && result.reason.startsWith("permission:")) {
      const request = [...chain]
        .reverse()
        .find((e) => e.kind === "permission_request");
      if (request) {
        dispatch({
          type: "paused",
          ask: {
            requestId: request.id,
            tool: String(request.payload.tool),
            arg: String(request.payload.arg),
            rule: askRuleOf(request.payload.rule),
          },
        });
        showAsk();
        return;
      }
    }
    dispatch({
      type: "turn_done",
      status: result.status === "done" ? "done" : "paused",
      ...(result.status === "paused" ? { reason: result.reason } : {}),
    });
  };

  const runEffect = async (effect: ChatEffect): Promise<void> => {
    if (effect.type === "menu") {
      openMenu();
    } else if (effect.type === "exit") {
      clearInterval(tickTimer);
      renderer.destroy();
      process.exit(0);
    } else if (effect.type === "send_user") {
      appendEvent(setup.deps.db, {
        session_id: sessionId,
        parent_id: head,
        kind: "user_message",
        payload: { text: effect.text },
      });
      await drive().catch((err) =>
        dispatch({ type: "error", message: (err as Error).message }),
      );
    } else if (effect.type === "answer_permission") {
      answerPermission(
        setup.deps.db,
        sessionId,
        effect.requestId,
        effect.decision,
        effect.always,
      );
      await drive().catch((err) =>
        dispatch({ type: "error", message: (err as Error).message }),
      );
    } else if (effect.type === "dispatch") {
      const target = slash[`/${effect.command}`];
      if (!target) {
        // UX-38: unreachable — the reducer gates on knownDispatch (same key
        // set) and opens the menu itself; this stays as a defensive error.
        dispatch({
          type: "error",
          message: `unknown command /${effect.command}`,
        });
        return;
      }
      // Same function as the typed CLI command (UX-8/UX-14); its stdout is
      // captured into the transcript while the TUI owns the screen.
      const captured: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await target(effect.argv);
      } finally {
        process.stdout.write = original;
      }
      dispatch({ type: "info", text: captured.join("").trimEnd() });
    } else if (effect.type === "list_models") {
      // UX-17: the listing is the exported registry function's return value.
      const lines = listModels()
        .map(
          (m) =>
            `${m.id === model.modelId ? "→" : " "} ${m.id} (${m.provider})`,
        )
        .join("\n");
      dispatch({
        type: "info",
        text: `models:\n${lines}\n/model <id> to switch`,
      });
    } else if (effect.type === "switch_model") {
      // UX-17: unknown ids error without appending; a real switch appends
      // one session event and takes effect at the next model call.
      if (!listModels().some((m) => m.id === effect.id)) {
        dispatch({
          type: "error",
          message: `unknown model "${effect.id}" — /model lists available models`,
        });
        return;
      }
      // Pass the tracked head so a mid-turn race (should be impossible given
      // the reducer's busy-rejection) refuses loudly rather than orphaning.
      appendModelSwitch(
        setup.deps.db,
        sessionId,
        model.modelId,
        effect.id,
        head ?? undefined,
      );
      const chain = reconstruct(listEvents(setup.deps.db, sessionId));
      head = chain[chain.length - 1]?.id ?? head;
      dispatch({ type: "model_switched", to: effect.id });
    }
  };

  input.on(InputRenderableEvents.ENTER, () => {
    const text = input.value;
    input.value = "";
    dispatch({ type: "submit", text });
  });
  renderer.keyInput.on("keypress", (key: { name?: string; ctrl?: boolean }) => {
    if (key.ctrl === true && key.name === "c") {
      clearInterval(tickTimer);
      renderer.destroy();
      process.exit(0);
    }
    // UX-38: a mounted menu owns escape (closes it); a mounted ask-menu
    // suppresses esc-exit (answer explicitly); only bare esc exits the chat.
    if (key.name === "escape") {
      handleEscape(cmdMenu, askMenu !== null, () => {
        clearInterval(tickTimer);
        renderer.destroy();
        process.exit(0);
      });
      return;
    }
    if (askMenu || cmdMenu?.mounted() === true) return; // menus own the keys
    // UX-31: tab always toggles focus; j/k/enter go to the reducer only while
    // transcript-focused (otherwise they type into the input normally).
    if (key.name === "tab") dispatch({ type: "key", key: "tab" });
    else if (
      model.focus === "transcript" &&
      (key.name === "j" || key.name === "k" || key.name === "return")
    )
      dispatch({
        type: "key",
        key: key.name === "return" ? "enter" : key.name,
      });
  });
  redraw();
};
