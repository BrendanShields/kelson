import { describe, expect, it } from "bun:test";
import { openDb } from "@obligato/kernel";
import { assembleContext } from "../../src/context.ts";
import {
  appendEvent,
  compactSession,
  createAgentSession,
  currentHead,
  forkSession,
  listEvents,
  reconstruct,
  reconstructFrom,
} from "../../src/sessions.ts";
import { fixture } from "../helpers.ts";

const msg = (
  db: Parameters<typeof appendEvent>[0],
  sid: string,
  parent: string | null,
  text: string,
) =>
  appendEvent(db, {
    session_id: sid,
    parent_id: parent,
    kind: "user_message",
    payload: { text },
  });

describe("SES-8: compaction substitutes a summary without deleting originals", () => {
  it("reconstruct replaces the covered span with one summary; originals remain in the store", () => {
    const f = fixture([]);
    msg(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "turn-1",
    );
    msg(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "turn-2",
    );
    const beforeCount = listEvents(f.db, f.sessionId).length;

    const range = compactSession(
      f.db,
      f.sessionId,
      () => "SUMMARY of the chat",
    );

    const chain = reconstruct(listEvents(f.db, f.sessionId));
    const texts = chain
      .filter((e) => e.payload.text)
      .map((e) => e.payload.text);
    // The whole covered span collapses to the single summary message —
    // but the session_meta root survives in front of it (SES-8/F-177).
    expect(texts).toEqual(["SUMMARY of the chat"]);
    expect(chain[0]?.kind).toBe("session_meta");
    expect(chain[1]?.payload.compacted).toBe(true);
    // F-177 regression arm: assembly over the post-compaction reconstruction
    // must succeed, with the summary as the first message.
    const ctx = assembleContext(chain);
    expect(ctx.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(ctx.messages[0])).toContain("SUMMARY of the chat");
    // Nothing deleted — the originals (plus the new compaction event) remain.
    expect(listEvents(f.db, f.sessionId).length).toBeGreaterThan(beforeCount);
    // The covered range: from is the first real event AFTER the root (the
    // fixture's seeded task message — never the root), to is the
    // pre-compaction head (turn-2), not the new marker.
    const all = listEvents(f.db, f.sessionId);
    const seeded = all.find((e) => e.payload.text === "do the thing");
    const turn2 = all.find((e) => e.payload.text === "turn-2");
    expect(range.from_event).toBe(seeded?.id as string);
    expect(range.to_event).toBe(turn2?.id as string);
    const root = all.find((e) => e.parent_id === null);
    expect(range.from_event).not.toBe(root?.id as string);
  });

  it("a covered session_meta bookkeeping event survives reconstruction and yields no model message (F-178)", () => {
    const f = fixture([]);
    const head = msg(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "turn-1",
    );
    appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: head.id,
      kind: "session_meta",
      payload: { obligation_check: { clause_id: "X-1", status: "fail" } },
    });
    compactSession(f.db, f.sessionId, () => "SUMMARY");

    const chain = reconstruct(listEvents(f.db, f.sessionId));
    const preserved = chain.filter(
      (e) => e.kind === "session_meta" && e.payload.obligation_check,
    );
    expect(preserved.length).toBe(1);
    // Bookkeeping is context-free: assembly produces only the summary message.
    const ctx = assembleContext(chain);
    expect(ctx.messages.length).toBe(1);
    expect(JSON.stringify(ctx.messages[0])).toContain("SUMMARY");
  });

  it("a root-only chain refuses to compact and appends nothing", () => {
    const db = openDb(":memory:");
    const { sessionId } = createAgentSession(db, {
      repo: "test-repo",
      lockfile_hash: "sha256:".padEnd(71, "0"),
      harness_version: "0.0.1",
      model: "m",
      system: "SYS",
      auth_kind: "none",
    });
    const before = listEvents(db, sessionId).length;
    expect(() => compactSession(db, sessionId, () => "S")).toThrow(
      "nothing to compact",
    );
    expect(listEvents(db, sessionId).length).toBe(before);
  });

  it("a fork before the compaction reconstructs the full original history (no summary)", () => {
    const f = fixture([]);
    const preCompact = msg(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "turn-1",
    );
    msg(
      f.db,
      f.sessionId,
      currentHead(listEvents(f.db, f.sessionId)),
      "turn-2",
    );
    compactSession(f.db, f.sessionId, () => "SUMMARY");

    // Fork at an event BEFORE the compaction → full history, no summary.
    const { forkHead } = forkSession(f.db, f.sessionId, preCompact.id);
    const forkChain = reconstructFrom(listEvents(f.db, f.sessionId), forkHead);
    const texts = forkChain
      .filter((e) => e.payload.text)
      .map((e) => e.payload.text);
    expect(texts).toContain("turn-1");
    expect(texts).not.toContain("SUMMARY"); // compaction is on the other branch
  });
});
