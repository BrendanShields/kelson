import {
  appendEvent,
  continueSession,
  createAgentSession,
  runTurn,
} from "@kelson/agent";
import { RunResult } from "@kelson/schemas";
import { emitJson } from "../output/json.js";
import { streamOut } from "../output/stream.js";
import { fail, SYSTEM_PROMPT, setupAgent } from "./common.js";

// UX-15: same runTurn driver as chat, plain text to stdout, --json validated
// against RunResult; exit 0 only when the session reached done.
export const runCommand = async (argv: string[]): Promise<void> => {
  let prompt: string | undefined;
  const named: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-p" || a === "--prompt") {
      prompt = argv[i + 1];
      i++;
    } else if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        named[a.slice(2)] = next;
        i++;
      } else named[a.slice(2)] = true;
    }
  }
  if (!prompt)
    return fail('usage: kelson run -p "<task>" [--json] [--allow-asks]');

  const setup =
    typeof named.db === "string"
      ? setupAgent(process.cwd(), named.db)
      : setupAgent();
  const json = named.json === true;
  // SES-4: --continue extends an existing session's chain from its head.
  const { sessionId, head } =
    typeof named.continue === "string"
      ? continueSession(setup.deps.db, named.continue)
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
  appendEvent(setup.deps.db, {
    session_id: sessionId,
    parent_id: head,
    kind: "user_message",
    payload: { text: prompt },
  });

  const result = await runTurn({
    ...setup.deps,
    sessionId,
    // PERM-3: headless ask → deny; --allow-asks resolves asks to allow.
    headlessAsk: named["allow-asks"] === true ? "allow" : "deny",
    ...(json ? {} : { onDelta: streamOut }),
  });

  const rows = setup.deps.db
    .query(
      "SELECT COUNT(*) AS steps, SUM(cost_micro_usd) AS cost, COUNT(*) - COUNT(cost_micro_usd) AS unknowns FROM step_event WHERE session_id = ?",
    )
    .get(sessionId) as { steps: number; cost: number | null; unknowns: number };

  if (json) {
    emitJson(
      RunResult.parse({
        session_id: sessionId,
        status: result.status === "done" ? "done" : "paused",
        text: result.status === "done" ? result.text : "",
        steps: rows.steps,
        cost_micro_usd: rows.unknowns > 0 ? null : (rows.cost ?? 0),
        schema_version: 1,
      }),
    );
  } else {
    streamOut("\n");
    if (result.status === "paused")
      console.error(`kelson: session paused (${result.reason})`);
  }
  if (result.status !== "done") process.exitCode = 1;
};
