import { describe, expect, it } from "bun:test";
import { openDb } from "@kelson/kernel";
import { toMessages } from "../../src/context.ts";
import {
  appendEvent,
  createAgentSession,
  listEvents,
  reconstruct,
} from "../../src/sessions.ts";

describe("SES-4: a done session with an empty final assistant turn stays --continue-able", () => {
  it("toMessages drops a text-less, tool-less assistant message so the provider never receives empty content", () => {
    const db = openDb(":memory:");
    const { sessionId, rootEventId } = createAgentSession(db, {
      repo: "r",
      lockfile_hash: `sha256:${"0".repeat(64)}`,
      harness_version: "0.0.1",
      model: "mock",
      system: "s",
      auth_kind: "none",
    });
    let head = appendEvent(db, {
      session_id: sessionId,
      parent_id: rootEventId,
      kind: "user_message",
      payload: { text: "q1" },
    }).id;
    // The done turn carried neither text nor tool calls.
    head = appendEvent(db, {
      session_id: sessionId,
      parent_id: head,
      kind: "assistant_message",
      payload: { text: "", tool_calls: [] },
    }).id;
    // --continue: a new user message on the same chain, then a real answer.
    head = appendEvent(db, {
      session_id: sessionId,
      parent_id: head,
      kind: "user_message",
      payload: { text: "q2" },
    }).id;
    appendEvent(db, {
      session_id: sessionId,
      parent_id: head,
      kind: "assistant_message",
      payload: { text: "a2", tool_calls: [] },
    });

    const messages = toMessages(reconstruct(listEvents(db, sessionId)));
    // No message carries an empty content array (the provider rejects those).
    for (const m of messages)
      if (Array.isArray(m.content)) expect(m.content.length).toBeGreaterThan(0);
    // The empty assistant turn is gone; only the real answer remains.
    expect(messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    db.close();
  });
});
