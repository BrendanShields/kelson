import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerPermission,
  appendModelSwitch,
  listEvents,
  loadRegistry,
  reconstruct,
  resume,
  runTurn,
  sessionModelOf,
} from "@obligato/agent";
import type { ModelRegistryEntry } from "@obligato/schemas";
import {
  fixture,
  mockModel,
  TEST_ENTRY,
  textResponse,
  toolCallResponse,
} from "../../../agent/test/helpers.ts";
import { createChat, listModels, update } from "../../src/chat/model.ts";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

describe("UX-17: /model lists via the registry function and switches at the next model call", () => {
  it("the listing IS the exported registry function (identity, not a reimplementation)", () => {
    expect(listModels).toBe(loadRegistry);
  });

  it("reducer: /model lists; same-model select appends nothing; /model <id> emits the switch effect", () => {
    const m = createChat("model-a", {}, []);
    expect(update(m, { type: "submit", text: "/model" }).effects).toEqual([
      { type: "list_models" },
    ]);
    const same = update(m, { type: "submit", text: "/model model-a" });
    expect(same.effects).toEqual([]);
    expect(same.model.entries.at(-1)).toEqual({
      kind: "info",
      text: "model-a is already the active model",
    });
    expect(
      update(m, { type: "submit", text: "/model model-b" }).effects,
    ).toEqual([{ type: "switch_model", id: "model-b" }]);
  });

  it("a /model submitted while busy is rejected with a message and appends no switch effect", () => {
    const busy = { ...createChat("model-a", {}, []), busy: true };
    const r = update(busy, { type: "submit", text: "/model model-b" });
    expect(r.effects).toEqual([]);
    expect(r.model.entries.at(-1)?.kind).toBe("info");
    expect(r.model.modelId).toBe("model-a");
  });

  it("a switch while paused leaves the suspended step on the old model; the next call runs the new one", async () => {
    const ENTRY_B: ModelRegistryEntry = { ...TEST_ENTRY, id: "mock-model-b" };
    const f = fixture([
      toolCallResponse([
        { id: "c1", name: "write", input: { path: "a.txt", content: "x" } },
      ]),
    ]);
    const modelB = mockModel([textResponse("answered by B")]);
    f.deps.resolveModel = (ref) => {
      if (ref !== ENTRY_B.id) throw new Error(`unexpected ref ${ref}`);
      return { entry: ENTRY_B, model: modelB };
    };

    const paused = await runTurn(f.deps);
    expect(paused.status).toBe("paused");
    // Switch while paused (divergence-pinned: allowed, effective next call).
    appendModelSwitch(f.db, f.sessionId, TEST_ENTRY.id, ENTRY_B.id);
    const chain = reconstruct(listEvents(f.db, f.sessionId));
    expect(sessionModelOf(chain)).toBe(ENTRY_B.id);
    const request = chain.find((e) => e.kind === "permission_request");
    if (!request) throw new Error("no request");
    answerPermission(f.db, f.sessionId, request.id, "allow");

    const done = await resume(f.deps);
    expect(done.status).toBe("done");
    // Attribution: step 1 (the suspended one) on A, step 2 on B.
    const rows = f.db
      .query("SELECT model FROM step_event WHERE session_id = ? ORDER BY rowid")
      .all(f.sessionId) as { model: string }[];
    expect(rows.map((r) => r.model)).toEqual([TEST_ENTRY.id, ENTRY_B.id]);
    expect(f.model.doStreamCalls.length).toBe(1);
    expect(modelB.doStreamCalls.length).toBe(1);
    // The switch is one recorded session event.
    const switches = listEvents(f.db, f.sessionId).filter(
      (e) => e.kind === "session_meta" && e.payload.model_switch,
    );
    expect(switches.length).toBe(1);
  });

  it("run --continue resumes under the chain-derived model, not the config default (config bytes untouched)", async () => {
    const serverA = mockOpenAiServer([{ kind: "text", text: "from A" }]);
    const serverB = mockOpenAiServer([{ kind: "text", text: "from B" }]);
    const t = makeTestRepo({ baseUrl: serverA.url, configured: true });
    // Overlay carries both models, pointing at different endpoints.
    writeFileSync(
      join(t.home, ".obligato", "models.json"),
      JSON.stringify(
        (["mock-m", "mock-m2"] as const).map((id, i) => ({
          id,
          provider: "openai-compatible",
          base_url: i === 0 ? serverA.url : serverB.url,
          context_window: 32_768,
          max_output: 8_192,
          prices: { in: 0, out: 0, cache_read: 0, cache_write: 0 },
          tools: true,
        })),
      ),
    );
    const dbPath = join(t.repo, ".obligato", "obligato.db");
    const configPath = join(t.repo, ".obligato", "config.json");
    const configBefore = await Bun.file(configPath).text();

    const first = await runCli(t, [
      "run",
      "-p",
      "one",
      "--db",
      dbPath,
      "--json",
    ]);
    expect(first.exitCode).toBe(0);
    const sessionId = JSON.parse(first.stdout).session_id as string;

    // A chat-recorded switch, then continue headlessly.
    const { openDb } = await import("@obligato/kernel");
    const db = openDb(dbPath);
    appendModelSwitch(db, sessionId, "mock-m", "mock-m2");
    db.close();

    const second = await runCli(t, [
      "run",
      "-p",
      "two",
      "--continue",
      sessionId,
      "--db",
      dbPath,
      "--json",
    ]);
    expect(second.exitCode).toBe(0);
    expect(serverB.calls()).toBe(1);

    const db2 = new Database(dbPath, { readonly: true });
    const rows = db2
      .query("SELECT model FROM step_event WHERE session_id = ? ORDER BY rowid")
      .all(sessionId) as { model: string }[];
    expect(rows.map((r) => r.model)).toEqual(["mock-m", "mock-m2"]);
    db2.close();
    // Config default never re-read or rewritten.
    expect(await Bun.file(configPath).text()).toBe(configBefore);
    serverA.stop();
    serverB.stop();
  }, 30_000);
});
