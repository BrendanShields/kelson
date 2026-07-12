import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  buildSessionTree,
  createAgentSession,
  currentHead,
  listEvents,
} from "@obligato/agent";
import { openDb } from "@obligato/kernel";
import { SessionTreeNode } from "@obligato/schemas";
import { z } from "zod";
import { treePaneLines } from "../../src/chat/view.js";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

const seedSession = (db: Database) => {
  const { sessionId, rootEventId } = createAgentSession(db, {
    repo: "test-repo",
    lockfile_hash: "sha256:".padEnd(71, "0"),
    harness_version: "0.0.1",
    model: "mock-m",
    system: "sys",
    auth_kind: "none",
  });
  return { sessionId, rootEventId };
};

const add = (
  db: Database,
  sessionId: string,
  parent: string,
  kind = "user_message",
) =>
  appendEvent(db, {
    session_id: sessionId,
    parent_id: parent,
    kind: kind as never,
    payload: { text: "x" },
  }).id;

describe("UX-34: session tree — one builder for pane and CLI", () => {
  it("linear chain: exactly root and head, head suffixed once, parent = root", () => {
    const db = openDb(":memory:");
    const { sessionId, rootEventId } = seedSession(db);
    const a = add(db, sessionId, rootEventId);
    const b = add(db, sessionId, a, "assistant_message");
    const events = listEvents(db, sessionId);
    const nodes = buildSessionTree(events, currentHead(events));
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.parent).toBeNull();
    expect(nodes[1]?.id).toBe(b);
    expect(nodes[1]?.parent).toBe(rootEventId);
    // revert-check: force-retain the head's ancestors → length 2 fails.
    const suffixed = nodes.filter((n) => n.label.endsWith("← head"));
    expect(suffixed).toHaveLength(1);
    expect(suffixed[0]?.id).toBe(b);
  });

  it("two-branch fork: root, fork node, both heads; heads parent at the fork", () => {
    const db = openDb(":memory:");
    const { sessionId, rootEventId } = seedSession(db);
    const a = add(db, sessionId, rootEventId);
    const b1 = add(db, sessionId, a);
    const b1b = add(db, sessionId, b1, "assistant_message");
    // SES-6: appending at a non-head parent forks.
    const b2 = add(db, sessionId, a);
    const events = listEvents(db, sessionId);
    const nodes = buildSessionTree(events, currentHead(events));
    const ids = nodes.map((n) => n.id);
    expect(ids).toEqual([rootEventId, a, b1b, b2]);
    expect(nodes.find((n) => n.id === b1b)?.parent).toBe(a);
    expect(nodes.find((n) => n.id === b2)?.parent).toBe(a);
    // b1 collapsed (one child); input order preserved (divergence pin).
    expect(ids).not.toContain(b1);
    const suffixed = nodes.filter((n) => n.label.endsWith("← head"));
    expect(suffixed).toHaveLength(1);
  });

  it("CLI: `session tree` prints depth-indented lines; --json validates; pane renders the same builder output", async () => {
    const t = makeTestRepo({});
    mkdirSync(join(t.home, "store"), { recursive: true });
    const dbPath = join(t.home, "store", "tree.sqlite");
    const db = openDb(dbPath);
    const { sessionId, rootEventId } = seedSession(db);
    const a = add(db, sessionId, rootEventId);
    add(db, sessionId, a);
    add(db, sessionId, a);
    db.close();

    const r = await runCli(t, ["session", "tree", sessionId, "--db", dbPath]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.length).toBe(4);
    // Depth indentation: two spaces per level (root 0, fork 1, heads 2).
    expect(lines[1]?.startsWith("  ")).toBe(true);
    expect(lines[3]?.startsWith("    ")).toBe(true);

    const j = await runCli(t, [
      "session",
      "tree",
      sessionId,
      "--db",
      dbPath,
      "--json",
    ]);
    // Verification independence (F-031): validate against the schema HERE,
    // not just via the CLI's own parse call.
    const parsed = z.array(SessionTreeNode).parse(JSON.parse(j.stdout));
    expect(parsed).toHaveLength(4);

    // Identity (F-085): the pane renders from the same builder output.
    const db2 = openDb(dbPath);
    const events = listEvents(db2, sessionId);
    const nodes = buildSessionTree(events, currentHead(events));
    const paneTexts = treePaneLines(nodes).map((l) =>
      l.map((s) => s.text).join(""),
    );
    expect(paneTexts).toEqual(lines);
  }, 20_000);
});
