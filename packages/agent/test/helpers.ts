import type { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@kelson/kernel";
import type { ModelRegistryEntry } from "@kelson/schemas";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { StepDeps } from "../src/loop.ts";
import { appendEvent, createAgentSession } from "../src/sessions.ts";
import { CORE_TOOLS, localExec } from "../src/tools.ts";

export const TEST_ENTRY: ModelRegistryEntry = {
  id: "mock-model",
  provider: "anthropic",
  context_window: 1_000_000,
  max_output: 64_000,
  prices: {
    in: 5_000_000,
    out: 25_000_000,
    cache_read: 500_000,
    cache_write: 6_250_000,
  },
  tools: true,
};

// Four distinct token-class values so a class-swap bug cannot cancel out.
export const USAGE_FIXTURE = {
  inputTokens: { total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export const textResponse = (text: string): unknown[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: "stop", usage: USAGE_FIXTURE },
];

export const toolCallResponse = (
  calls: { id: string; name: string; input: Record<string, unknown> }[],
): unknown[] => [
  { type: "stream-start", warnings: [] },
  ...calls.map((c) => ({
    type: "tool-call",
    toolCallId: c.id,
    toolName: c.name,
    input: JSON.stringify(c.input),
  })),
  { type: "finish", finishReason: "tool-calls", usage: USAGE_FIXTURE },
];

export const mockModel = (responses: unknown[][]): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: responses.map((chunks) => ({
      // biome-ignore lint/suspicious/noExplicitAny: scripted fixture chunks
      stream: simulateReadableStream({ chunks: chunks as any[] }),
    })),
  });

export interface Fixture {
  db: Database;
  dir: string;
  deps: StepDeps;
  sessionId: string;
  taskId: string;
  model: MockLanguageModelV4;
}

export const fixture = (
  responses: unknown[][],
  opts: { dbPath?: string; task?: string } = {},
): Fixture => {
  // realpath: macOS tmpdir is a symlink; tool containment compares prefixes.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kelson-agent-")));
  const db = openDb(opts.dbPath ?? ":memory:");
  const { sessionId, taskId, rootEventId } = createAgentSession(db, {
    repo: "test-repo",
    lockfile_hash: "sha256:".padEnd(71, "0"),
    harness_version: "0.0.1",
    model: TEST_ENTRY.id,
    system: "You are a test agent.",
  });
  appendEvent(db, {
    session_id: sessionId,
    parent_id: rootEventId,
    kind: "user_message",
    payload: { text: opts.task ?? "do the thing" },
  });
  const model = mockModel(responses);
  const deps: StepDeps = {
    db,
    sessionId,
    entry: TEST_ENTRY,
    model,
    tools: CORE_TOOLS,
    rules: [],
    ctx: { cwd: dir, exec: localExec(dir) },
  };
  return { db, dir, deps, sessionId, taskId, model };
};
