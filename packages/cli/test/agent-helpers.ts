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
  // Parsed request bodies in arrival order — lets a test assert what the
  // provider actually received (SES-4's empty-assistant-drop is only
  // observable on the wire).
  bodies: () => unknown[];
  stop: () => void;
}

export const mockOpenAiServer = (turns: MockTurn[]): MockServer => {
  let call = 0;
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      bodies.push(await req.json().catch(() => null));
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
    bodies: () => [...bodies],
    stop: () => server.stop(true),
  };
};

export interface TestRepo {
  repo: string;
  home: string;
  env: Record<string, string>;
}

// A temp repo + temp HOME: obligato.lock, .obligato store dir, and (optionally)
// a mock-model overlay + config so setupAgent resolves end-to-end.
export const makeTestRepo = (opts: {
  baseUrl?: string;
  configured?: boolean;
}): TestRepo => {
  const repo = mkdtempSync(join(tmpdir(), "obligato-repo-"));
  const home = mkdtempSync(join(tmpdir(), "obligato-home-"));
  mkdirSync(join(repo, ".obligato"), { recursive: true });
  mkdirSync(join(home, ".obligato"), { recursive: true });
  writeFileSync(
    join(repo, "obligato.lock"),
    JSON.stringify({ schema_version: 1, parent_hash: null, entries: [] }),
  );
  if (opts.baseUrl) {
    writeFileSync(
      join(home, ".obligato", "models.json"),
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
      join(repo, ".obligato", "config.json"),
      JSON.stringify({ default_model: "mock-m", schema_version: 1 }),
    );
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "ANTHROPIC_API_KEY" && k !== "OPENAI_API_KEY")
      env[k] = v;
  env.HOME = home;
  // Refusing loopback root: any test that runs an anthropic login must not
  // fire a live GET /v1/models (LLM-layer rule) — detection degrades to its
  // skip notice. PROV-12 fixtures override this with their own server root.
  env.OBLIGATO_TEST_ANTHROPIC_ROOT = "http://127.0.0.1:9";
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
