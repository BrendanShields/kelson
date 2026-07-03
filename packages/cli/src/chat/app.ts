import {
  answerPermission,
  appendEvent,
  continueSession,
  createAgentSession,
  listEvents,
  reconstruct,
  runTurn,
} from "@kelson/agent";
import {
  type CliRenderer,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import { SYSTEM_PROMPT, setupAgent } from "../agent/common.js";
import type { DispatchTable } from "../wizards.js";
import {
  type ChatEffect,
  type ChatModel,
  type ChatMsg,
  createChat,
  renderChat,
  slashTargets,
  update,
} from "./model.js";

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
            system: SYSTEM_PROMPT,
          });
          return { sessionId: created.sessionId, head: created.rootEventId };
        })();
  let head: string | null = startHead;

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  let model = createChat(setup.entry.id);
  const slash = slashTargets(commands);

  const transcript = new TextRenderable(renderer, {
    id: "transcript",
    content: "",
    flexGrow: 1,
  });
  const input = new InputRenderable(renderer, {
    id: "chat-input",
    placeholder: "task or /help (esc to quit)",
    flexShrink: 0,
  });
  renderer.root.add(transcript);
  renderer.root.add(input);
  input.focus();

  let askMenu: SelectRenderable | null = null;
  const redraw = (): void => {
    transcript.content = renderChat(model);
  };

  const dispatch = (msg: ChatMsg): void => {
    const next = update(model, msg);
    model = next.model;
    redraw();
    for (const effect of next.effects) void runEffect(effect);
  };

  const showAsk = (): void => {
    if (!model.ask || askMenu) return;
    const ask = model.ask;
    askMenu = new SelectRenderable(renderer, {
      id: "ask-menu",
      options: [
        {
          name: `allow ${ask.tool} once`,
          description: ask.arg,
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
      onToolResult: (name, ok) => dispatch({ type: "tool_result", name, ok }),
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
    if (effect.type === "exit") {
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
    }
  };

  input.on(InputRenderableEvents.ENTER, () => {
    const text = input.value;
    input.value = "";
    dispatch({ type: "submit", text });
  });
  renderer.keyInput.on("keypress", (key: { name?: string; ctrl?: boolean }) => {
    if (key.name === "escape" || (key.ctrl === true && key.name === "c")) {
      renderer.destroy();
      process.exit(0);
    }
  });
  redraw();
};
