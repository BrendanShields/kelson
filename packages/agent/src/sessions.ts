import type { Database } from "bun:sqlite";
import { openTask, startSession, ulid } from "@kelson/kernel";
import { SessionEvent, type SessionEventKind } from "@kelson/schemas";

export class SessionNotPausedError extends Error {
  constructor(actual: string) {
    super(`resume requires a paused session; state is "${actual}" (AGT-5)`);
  }
}

const insertEvent = (db: Database, e: SessionEvent): void => {
  db.query(
    `INSERT INTO session_event (id, session_id, parent_id, kind, payload, at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.session_id,
    e.parent_id,
    e.kind,
    JSON.stringify(e.payload),
    e.at,
    e.schema_version,
  );
};

// SES-3: appending moves the head via a head_moved event (parent_id null —
// head pointers live off-chain); the current head is derived by rowid.
export const appendEvent = (
  db: Database,
  args: {
    session_id: string;
    parent_id: string | null;
    kind: SessionEventKind;
    payload: Record<string, unknown>;
  },
): SessionEvent => {
  const event = SessionEvent.parse({
    id: ulid(),
    session_id: args.session_id,
    parent_id: args.parent_id,
    kind: args.kind,
    payload: args.payload,
    at: new Date().toISOString(),
    schema_version: 1,
  });
  const head = SessionEvent.parse({
    id: ulid(),
    session_id: args.session_id,
    parent_id: null,
    kind: "head_moved",
    payload: { head_event_id: event.id, reason: "append" },
    at: new Date().toISOString(),
    schema_version: 1,
  });
  db.transaction(() => {
    insertEvent(db, event);
    insertEvent(db, head);
  })();
  return event;
};

const rowToEvent = (row: Record<string, unknown>): SessionEvent =>
  SessionEvent.parse({
    ...row,
    payload: JSON.parse(row.payload as string),
  });

export const listEvents = (db: Database, sessionId: string): SessionEvent[] =>
  (
    db
      .query("SELECT * FROM session_event WHERE session_id = ? ORDER BY rowid")
      .all(sessionId) as Record<string, unknown>[]
  ).map(rowToEvent);

export const currentHead = (events: SessionEvent[]): string | null => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === "head_moved")
      return (e.payload.head_event_id as string) ?? null;
  }
  return null;
};

// SES-2: walk the parent chain head -> root, reversed. head_moved events are
// off-chain by construction (their ids are never a parent_id).
export const reconstruct = (events: SessionEvent[]): SessionEvent[] => {
  const headId = currentHead(events);
  if (headId === null) return [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const chain: SessionEvent[] = [];
  let cursor = byId.get(headId);
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id);
  }
  return chain.reverse();
};

export type Lifecycle = "active" | "paused" | "done";

interface ChainToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Tool calls on the last assistant message with no tool_result yet — the
// suspended remainder of an interrupted step.
export const pendingToolCalls = (chain: SessionEvent[]): ChainToolCall[] => {
  const lastAssistant = [...chain]
    .reverse()
    .find((e) => e.kind === "assistant_message");
  if (!lastAssistant) return [];
  const calls = (lastAssistant.payload.tool_calls ?? []) as ChainToolCall[];
  const resolved = new Set(
    chain
      .filter((e) => e.kind === "tool_result")
      .map((e) => String(e.payload.tool_call_id)),
  );
  return calls.filter((c) => !resolved.has(c.id));
};

// AGT-6 (amended with the audit): paused = the turn is suspended mid-flight —
// the last assistant message requested tools, whether results are pending
// (permission ask) or all landed (step_limit / crash between steps). done =
// it requested none. active = no assistant message yet. No pause event kind.
export const lifecycle = (chain: SessionEvent[]): Lifecycle => {
  const lastAssistant = [...chain]
    .reverse()
    .find((e) => e.kind === "assistant_message");
  if (!lastAssistant) return "active";
  const toolCalls = (lastAssistant.payload.tool_calls ?? []) as unknown[];
  return toolCalls.length === 0 ? "done" : "paused";
};

export const assertResumable = (chain: SessionEvent[]): void => {
  const state = lifecycle(chain);
  if (state !== "paused") throw new SessionNotPausedError(state);
};

export interface AgentSession {
  sessionId: string;
  taskId: string;
  rootEventId: string;
}

// SES-4: --continue loads an existing session's head and extends the chain.
export const continueSession = (
  db: Database,
  sessionId: string,
): { sessionId: string; head: string } => {
  const events = listEvents(db, sessionId);
  const head = currentHead(events);
  if (head === null)
    throw new Error(`no session ${sessionId} in the store (SES-4)`);
  return { sessionId, head };
};

// SES-4: native sessions get a kernel session row (TEL-5 markers, LOOP-7
// lockfile pinning) plus a task row for step-event attribution.
export const createAgentSession = (
  db: Database,
  args: {
    repo: string;
    lockfile_hash: string;
    harness_version: string;
    model: string;
    system: string;
  },
): AgentSession => {
  const sessionId = startSession(db, {
    repo: args.repo,
    lockfile_hash: args.lockfile_hash,
    harness_version: args.harness_version,
  });
  const taskId = openTask(db, { repo: args.repo });
  const root = appendEvent(db, {
    session_id: sessionId,
    parent_id: null,
    kind: "session_meta",
    payload: {
      task_id: taskId,
      model: args.model,
      system: args.system,
      runner: "native",
    },
  });
  return { sessionId, taskId, rootEventId: root.id };
};
