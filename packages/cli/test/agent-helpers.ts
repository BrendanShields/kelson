import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = join(import.meta.dir, "..", "..", "..");
export const CLI = join(REPO, "packages", "cli", "src", "index.ts");

export type MockTurn =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown> };

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

const chunkBase = {
  id: "cmpl-1",
  object: "chat.completion.chunk",
  created: 0,
  model: "mock-m",
};

const turnBody = (turn: MockTurn): string => {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (turn.kind === "text")
    return [
      sse({
        ...chunkBase,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: turn.text },
            finish_reason: null,
          },
        ],
      }),
      sse({
        ...chunkBase,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      }),
      "data: [DONE]\n\n",
    ].join("");
  return [
    sse({
      ...chunkBase,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: turn.id,
                type: "function",
                function: {
                  name: turn.name,
                  arguments: JSON.stringify(turn.input),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sse({
      ...chunkBase,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage,
    }),
    "data: [DONE]\n\n",
  ].join("");
};

export interface MockServer {
  url: string;
  calls: () => number;
  stop: () => void;
}

export const mockOpenAiServer = (turns: MockTurn[]): MockServer => {
  let call = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      const turn = turns[Math.min(call, turns.length - 1)] as MockTurn;
      call++;
      return new Response(turnBody(turn), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    calls: () => call,
    stop: () => server.stop(true),
  };
};

export interface TestRepo {
  repo: string;
  home: string;
  env: Record<string, string>;
}

// A temp repo + temp HOME: kelson.lock, .kelson store dir, and (optionally)
// a mock-model overlay + config so setupAgent resolves end-to-end.
export const makeTestRepo = (opts: {
  baseUrl?: string;
  configured?: boolean;
}): TestRepo => {
  const repo = mkdtempSync(join(tmpdir(), "kelson-repo-"));
  const home = mkdtempSync(join(tmpdir(), "kelson-home-"));
  mkdirSync(join(repo, ".kelson"), { recursive: true });
  mkdirSync(join(home, ".kelson"), { recursive: true });
  writeFileSync(
    join(repo, "kelson.lock"),
    JSON.stringify({ schema_version: 1, parent_hash: null, entries: [] }),
  );
  if (opts.baseUrl) {
    writeFileSync(
      join(home, ".kelson", "models.json"),
      JSON.stringify([
        {
          id: "mock-m",
          provider: "openai-compatible",
          base_url: opts.baseUrl,
          context_window: 32_768,
          max_output: 8_192,
          prices: { in: 0, out: 0, cache_read: 0, cache_write: 0 },
          tools: true,
        },
      ]),
    );
  }
  if (opts.configured === true) {
    writeFileSync(
      join(repo, ".kelson", "config.json"),
      JSON.stringify({ default_model: "mock-m", schema_version: 1 }),
    );
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v;
  env.HOME = home;
  return { repo, home, env };
};

// Async on purpose: spawnSync would block this process's event loop, and the
// mock server the child talks to lives IN this process — a guaranteed
// deadlock (cost a hung suite once).
export const runCli = async (
  t: TestRepo,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const p = Bun.spawn(["bun", CLI, ...args], {
    cwd: t.repo,
    env: t.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { exitCode, stdout, stderr };
};
