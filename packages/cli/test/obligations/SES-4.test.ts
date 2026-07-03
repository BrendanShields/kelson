import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

describe("SES-4: run --continue extends the same chain; new sessions get a kernel session row", () => {
  it("the follow-up user_message's parent is the prior head, in the same session", async () => {
    const server = mockOpenAiServer([{ kind: "text", text: "first answer" }]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    const dbPath = join(t.repo, ".kelson", "kelson.db");

    const first = await runCli(t, [
      "run",
      "-p",
      "first task",
      "--db",
      dbPath,
      "--json",
    ]);
    expect(first.exitCode).toBe(0);
    const sessionId = JSON.parse(first.stdout).session_id as string;

    const second = await runCli(t, [
      "run",
      "-p",
      "follow-up task",
      "--continue",
      sessionId,
      "--db",
      dbPath,
      "--json",
    ]);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).session_id).toBe(sessionId);

    const db = new Database(dbPath, { readonly: true });
    // New-session half: exactly one kernel session row, native runner meta.
    const sessions = db.query("SELECT id, status FROM session").all() as {
      id: string;
      status: string;
    }[];
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.id).toBe(sessionId);

    // Continue half: the second user_message's parent is the first turn's
    // head (the first assistant message), on the same chain.
    const events = db
      .query(
        "SELECT id, parent_id, kind, payload FROM session_event WHERE session_id = ? ORDER BY rowid",
      )
      .all(sessionId) as {
      id: string;
      parent_id: string | null;
      kind: string;
      payload: string;
    }[];
    const userMessages = events.filter((e) => e.kind === "user_message");
    expect(userMessages.length).toBe(2);
    const firstAssistant = events.find((e) => e.kind === "assistant_message");
    expect(userMessages[1]?.parent_id).toBe(firstAssistant?.id ?? "");
    const meta = events.find((e) => e.kind === "session_meta");
    expect(JSON.parse(meta?.payload ?? "{}").runner).toBe("native");
    db.close();
    server.stop();
  }, 20_000);
});
