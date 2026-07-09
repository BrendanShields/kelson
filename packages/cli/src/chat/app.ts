import {
  answerPermission,
  appendEvent,
  appendModelSwitch,
  continueSession,
  createAgentSession,
  listEvents,
  reconstruct,
  runTurn,
  sessionModelOf,
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
import { setupAgent, systemPromptFor } from "../agent/common.js";
import type { DispatchTable } from "../wizards.js";
import {
  askProvenanceLabel,
  askRuleOf,
  type ChatEffect,
  type ChatModel,
  type ChatMsg,
  createChat,
  listModels,
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
            system: systemPromptFor(setup.root),
            auth_kind: setup.authKind,
          });
          return { sessionId: created.sessionId, head: created.rootEventId };
        })();
  let head: string | null = startHead;

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  // UX-17: a continued session's active model derives from the chain.
  const startingModel =
    sessionModelOf(reconstruct(listEvents(setup.deps.db, sessionId))) ??
    setup.entry.id;
  let model = createChat(startingModel);
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
    if (key.name === "escape" || (key.ctrl === true && key.name === "c")) {
      renderer.destroy();
      process.exit(0);
    }
  });
  redraw();
};
