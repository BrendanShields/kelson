import type { Database } from "bun:sqlite";
import { openTask, startSession, storeSnapshot, ulid } from "@obligato/kernel";
import {
  SessionEvent,
  type SessionEventKind,
  type SessionTreeNode,
} from "@obligato/schemas";

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

// UX-34: session tree — flat nodes in input order, retained set = root +
// fork points (≥2 children) + childless leaves; head_moved bookkeeping rows
// excluded before derivation. Divergence-pinned 2026-07-13: input order (not
// a DFS re-sort — F-060 rowid discipline); the head never forces retention.
export const buildSessionTree = (
  events: SessionEvent[],
  headId: string | null,
): SessionTreeNode[] => {
  const chainEvents = events.filter((e) => e.kind !== "head_moved");
  const childCount = new Map<string, number>();
  for (const e of chainEvents)
    if (e.parent_id !== null)
      childCount.set(e.parent_id, (childCount.get(e.parent_id) ?? 0) + 1);
  const retained = new Set(
    chainEvents
      .filter(
        (e) =>
          e.parent_id === null ||
          (childCount.get(e.id) ?? 0) >= 2 ||
          (childCount.get(e.id) ?? 0) === 0,
      )
      .map((e) => e.id),
  );
  const byId = new Map(chainEvents.map((e) => [e.id, e]));
  const nearestRetained = (parentId: string | null): string | null => {
    let cursor = parentId;
    while (cursor !== null) {
      if (retained.has(cursor)) return cursor;
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
    return null;
  };
  return chainEvents
    .filter((e) => retained.has(e.id))
    .map((e) => ({
      id: e.id,
      label: `${e.kind} ${e.id.slice(0, 8)}${e.id === headId ? " ← head" : ""}`,
      parent: e.parent_id === null ? null : nearestRetained(e.parent_id),
    }));
};

// SES-2/6: walk the parent chain from a GIVEN head -> root, reversed. Used for
// arbitrary branch heads (SES-7 compare) as well as the current head. head_moved
// events are off-chain by construction (their ids are never a parent_id).
// SES-8: if the walked chain carries a compaction marker, the covered
// message-bearing events are replaced by one synthetic summary user_message —
// the root survives in front (F-177) and covered session_meta bookkeeping
// events (obligation_check, markers) survive in order (F-178: they produce no
// model messages, and chain-derived state must outlive compaction). The
// covered originals stay in the store; only reconstruction substitutes.
export const reconstructFrom = (
  events: SessionEvent[],
  headId: string | null,
): SessionEvent[] => {
  if (headId === null) return [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const chain: SessionEvent[] = [];
  let cursor = byId.get(headId);
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id);
  }
  chain.reverse();
  const comp = [...chain]
    .reverse()
    .find((e) => e.kind === "session_meta" && e.payload.compaction);
  if (!comp) return chain;
  const { summary, to_event } = comp.payload.compaction as {
    summary: string;
    to_event: string;
  };
  const toIdx = chain.findIndex((e) => e.id === to_event);
  if (toIdx < 0) return chain;
  const summaryEvent = SessionEvent.parse({
    // Deterministic (SES-2) synthetic id: flip the first Crockford char of the
    // compaction event's ULID so it is a valid, stable, distinct id.
    id: (comp.id[0] === "0" ? "1" : "0") + comp.id.slice(1),
    session_id: comp.session_id,
    parent_id: null,
    kind: "user_message",
    payload: { text: summary, compacted: true },
    at: comp.at,
    schema_version: 1,
  });
  // SES-8/F-177: the session_meta root survives every substitution — dropping
  // it made assembleContext throw on any post-compaction step. The latest
  // summary stands in for the covered message-bearing events (an older
  // compaction's summary was input to this one's summarizer, so it subsumes);
  // covered session_meta events survive between summary and tail (F-178).
  const preserved = chain
    .slice(1, toIdx + 1)
    .filter((e) => e.kind === "session_meta");
  return [
    chain[0] as SessionEvent,
    summaryEvent,
    ...preserved,
    ...chain.slice(toIdx + 1),
  ];
};

export const reconstruct = (events: SessionEvent[]): SessionEvent[] =>
  reconstructFrom(events, currentHead(events));

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

// UX-17 (divergence-pinned): the active model derives from the chain — the
// last model_switch wins, else the session's starting model. Never re-reads
// the config default.
export const sessionModelOf = (chain: SessionEvent[]): string | null => {
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i];
    if (e?.kind !== "session_meta") continue;
    const sw = e.payload.model_switch as { to?: string } | undefined;
    if (sw?.to) return sw.to;
    if (e.payload.model) return String(e.payload.model);
  }
  return null;
};

// UX-17: one session event per switch; same-model switches are the caller's
// no-op (nothing appended here by contract). Refuses when invoked with a
// stale expected head — a switch appended mid-step would orphan off the
// reconstructed chain (audit F-088 class; the TUI's serialized turns make
// this unreachable, but the exported API guards it).
export const appendModelSwitch = (
  db: Database,
  sessionId: string,
  from: string,
  to: string,
  expectedHead?: string,
): SessionEvent => {
  const chain = reconstruct(listEvents(db, sessionId));
  const head = chain[chain.length - 1];
  if (!head) throw new Error("session has no events");
  if (expectedHead !== undefined && head.id !== expectedHead)
    throw new Error(
      "model switch raced the session head — the chain moved under it (UX-17)",
    );
  return appendEvent(db, {
    session_id: sessionId,
    parent_id: head.id,
    kind: "session_meta",
    payload: { model_switch: { from, to } },
  });
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
    // PROV-6: how the session authenticates; ledger/degradation policy reads
    // this — required so every creator states it.
    auth_kind: "subscription" | "api_key" | "none";
    // EVP-10: where session-start git-bundle snapshots are stored (a promotable
    // session needs one). Omit to use the kernel default.
    snapshot_store_dir?: string;
  },
): AgentSession => {
  const sessionId = startSession(db, {
    runner: "native",
    repo: args.repo,
    lockfile_hash: args.lockfile_hash,
    harness_version: args.harness_version,
  });
  const taskId = openTask(db, { repo: args.repo });
  // EVP-10: best-effort snapshot — null when the repo is not a git working
  // tree (a plain chat dir); promotion later requires a non-null one.
  let snapshot: string | null = null;
  try {
    snapshot = storeSnapshot(args.repo, args.snapshot_store_dir);
  } catch {
    snapshot = null;
  }
  const root = appendEvent(db, {
    session_id: sessionId,
    parent_id: null,
    kind: "session_meta",
    payload: {
      task_id: taskId,
      model: args.model,
      system: args.system,
      runner: "native",
      auth_kind: args.auth_kind,
      snapshot,
    },
  });
  return { sessionId, taskId, rootEventId: root.id };
};

// SES-6: fork a session at an event (default: current head). Appends an inert
// fork marker parented at the target — appendEvent's head_moved makes it the
// new current head, so both branches' heads coexist (SES-3). Returns the fork
// head and the pre-fork original head (recoverable, append-only).
export const forkSession = (
  db: Database,
  sessionId: string,
  eventId?: string,
): { forkHead: string; originalHead: string } => {
  const events = listEvents(db, sessionId);
  const originalHead = currentHead(events);
  if (originalHead === null)
    throw new Error(`no session ${sessionId} in the store (SES-6)`);
  const target = eventId ?? originalHead;
  if (!events.some((e) => e.id === target))
    throw new Error(`no event ${target} in session ${sessionId} (SES-6)`);
  const marker = appendEvent(db, {
    session_id: sessionId,
    parent_id: target,
    kind: "session_meta",
    payload: { forked_from: target },
  });
  return { forkHead: marker.id, originalHead };
};

export interface BranchSummary {
  head: string;
  cost_micro_usd: number;
  last_text: string;
  lifecycle: Lifecycle;
  event_count: number;
}

export interface BranchComparison {
  common_ancestor: string | null;
  shared_prefix: number;
  a: BranchSummary;
  b: BranchSummary;
}

// SES-7: read-only compare of two branch heads — per-branch cost + outcome and
// the deepest common ancestor. Appends nothing.
export const compareBranches = (
  db: Database,
  sessionId: string,
  headA: string,
  headB: string,
): BranchComparison => {
  const events = listEvents(db, sessionId);
  const summarize = (head: string): BranchSummary => {
    const chain = reconstructFrom(events, head);
    const assistants = chain.filter((e) => e.kind === "assistant_message");
    return {
      head,
      cost_micro_usd: assistants.reduce(
        (sum, e) => sum + Number(e.payload.cost_micro_usd ?? 0),
        0,
      ),
      last_text: String(assistants.at(-1)?.payload.text ?? ""),
      lifecycle: lifecycle(chain),
      event_count: chain.length,
    };
  };
  const chainA = reconstructFrom(events, headA);
  const idsB = new Set(reconstructFrom(events, headB).map((e) => e.id));
  let common: string | null = null;
  let shared = 0;
  for (const e of chainA) {
    if (idsB.has(e.id)) {
      common = e.id;
      shared++;
    } else break;
  }
  return {
    common_ancestor: common,
    shared_prefix: shared,
    a: summarize(headA),
    b: summarize(headB),
  };
};

// SES-8: compact the reconstructed chain to head — summarize (caller supplies
// the summarizer, a cheap routed model in production) and append one compaction
// marker covering [first-real-after-root, head] (never the root — F-177). On a
// re-compaction that first real event is a preserved covered session_meta when
// one exists, else the prior compaction marker (the synthetic summary is not a
// stored id); either way the prior summary was input to this summarizer, so
// the originals it covered are subsumed transitively. Covered originals are
// never deleted; only reconstruction substitutes (reconstructFrom).
export const compactSession = (
  db: Database,
  sessionId: string,
  summarize: (chain: SessionEvent[]) => string,
): { from_event: string; to_event: string } => {
  const events = listEvents(db, sessionId);
  const head = currentHead(events);
  if (head === null)
    throw new Error(`no session ${sessionId} in the store (SES-8)`);
  const chain = reconstructFrom(events, head);
  // SES-8/F-177: the covered span never includes the session_meta root, so
  // `from` is the first REAL event after it (skipping a prior compaction's
  // synthetic in-memory summary, which is not a stored id). A chain with
  // nothing real after the root has nothing to compact.
  const realIds = new Set(events.map((e) => e.id));
  const from = chain.slice(1).find((e) => realIds.has(e.id));
  if (!from)
    throw new Error(`session ${sessionId}: nothing to compact (SES-8)`);
  const summary = summarize(chain);
  appendEvent(db, {
    session_id: sessionId,
    parent_id: head,
    kind: "session_meta",
    payload: {
      compaction: { summary, from_event: from.id, to_event: head },
    },
  });
  return { from_event: from.id, to_event: head };
};

// AGT-16: integer tie comparison — footprint × 5 ≥ window × 4 (divergence
// pin 2026-07-11: no float threshold; exact at the 80% boundary).
export const autoCompactDue = (
  usage: {
    tokens_in: number;
    tokens_cache_read: number;
    tokens_cache_write: number;
  },
  contextWindow: number,
): boolean =>
  (usage.tokens_in + usage.tokens_cache_read + usage.tokens_cache_write) * 5 >=
  contextWindow * 4;

// AGT-16: the built-in summarizer — pure formatter over the reconstructed
// chain, byte-identical for identical chains, zero model calls. Four fixed
// lines; excerpts head-capped at 200 UTF-16 code units.
export const deterministicDigest = (chain: SessionEvent[]): string => {
  // Single-line excerpts (a prior digest embeds newlines — the four-line
  // frame must survive re-compaction), head-capped at 200 code units.
  const excerpt = (s: string): string => {
    const flat = s.replace(/\n/g, " ");
    return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
  };
  const firstUser = chain.find((e) => e.kind === "user_message");
  const lastAssistant = [...chain]
    .reverse()
    .find((e) => e.kind === "assistant_message");
  const tools = [
    ...new Set(
      chain
        .filter((e) => e.kind === "assistant_message")
        .flatMap((e) => (e.payload.tool_calls ?? []) as { name?: unknown }[])
        .map((c) => c.name)
        .filter((n): n is string => typeof n === "string"),
    ),
  ].sort();
  // Count = message-bearing events folded; session_meta bookkeeping is
  // preserved through substitution, not folded (AGT-16/F-178).
  const folded = chain.filter(
    (e, i) => i > 0 && e.kind !== "session_meta",
  ).length;
  return [
    `events: ${folded}`,
    `task: ${excerpt(String(firstUser?.payload.text ?? ""))}`,
    `last: ${excerpt(String(lastAssistant?.payload.text ?? ""))}`,
    `tools: ${tools.join(", ")}`,
  ].join("\n");
};

export const authKindOf = (
  credential: { type: string } | null,
): "subscription" | "api_key" | "none" =>
  credential === null
    ? "none"
    : credential.type === "api_key"
      ? "api_key"
      : "subscription";
