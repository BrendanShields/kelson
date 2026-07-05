import { describe, expect, it } from "bun:test";
import type { ModelRegistryEntry } from "@kelson/schemas";
import { assembleContext } from "../../src/context.ts";
import { instantiate } from "../../src/llm/resolve.ts";
import { runTurn } from "../../src/loop.ts";
import { appendEvent, listEvents, reconstruct } from "../../src/sessions.ts";
import { CORE_TOOLS, localExec } from "../../src/tools.ts";
import { fixture } from "../helpers.ts";

const marker = (m: unknown): unknown =>
  (m as { providerOptions?: { anthropic?: { cacheControl?: unknown } } })
    .providerOptions?.anthropic?.cacheControl;

describe("PROV-8: prompt-cache breakpoints on the system block and the final message", () => {
  it("assembled context marks instructions and exactly the final message", () => {
    const f = fixture([]);
    // Grow the chain: user → assistant(with call) → tool_result → user.
    const events = listEvents(f.db, f.sessionId);
    const head = reconstruct(events).at(-1)?.id as string;
    const a = appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: head,
      kind: "assistant_message",
      payload: {
        text: "looking",
        tool_calls: [{ id: "c1", name: "read", input: { path: "a" } }],
      },
    });
    const t = appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: a.id,
      kind: "tool_result",
      payload: { tool_call_id: "c1", name: "read", output: "x" },
    });
    appendEvent(f.db, {
      session_id: f.sessionId,
      parent_id: t.id,
      kind: "user_message",
      payload: { text: "now finish" },
    });

    const ctx = assembleContext(reconstruct(listEvents(f.db, f.sessionId)));
    expect(marker(ctx.instructions)).toEqual({ type: "ephemeral" });
    const marked = ctx.messages.filter((m) => marker(m) !== undefined);
    expect(marked.length).toBe(1);
    expect(marked[0]).toBe(ctx.messages.at(-1) as (typeof ctx.messages)[0]);
  });

  it("a capturing anthropic fixture observes cache_control on the system block and the final message", async () => {
    let body: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        body = await req.text();
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "capture only" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    });
    const entry: ModelRegistryEntry = {
      id: "claude-opus-4-8",
      provider: "anthropic",
      base_url: `http://127.0.0.1:${server.port}`,
      context_window: 1_000_000,
      max_output: 64_000,
      prices: null,
      tools: true,
    };
    const f = fixture([]);
    await runTurn({
      ...f.deps,
      entry,
      model: instantiate(entry, { type: "api_key", key: "kelson-test" }),
      tools: CORE_TOOLS,
      ctx: { cwd: f.dir, exec: localExec(f.dir) },
    }).catch(() => {});
    server.stop(true);

    expect(body).not.toBeNull();
    const parsed = JSON.parse(body as unknown as string) as {
      system?: { text: string; cache_control?: { type: string } }[];
      messages: {
        content: { cache_control?: { type: string } }[];
      }[];
    };
    // system block carries the breakpoint
    const sys = parsed.system ?? [];
    expect(sys.length).toBeGreaterThan(0);
    expect(sys.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    // the final message's final content part carries the breakpoint; no
    // earlier message does
    const msgs = parsed.messages;
    expect(msgs.length).toBeGreaterThan(0);
    const lastParts = msgs.at(-1)?.content ?? [];
    expect(lastParts.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    for (const m of msgs.slice(0, -1))
      for (const part of m.content) expect(part.cache_control).toBeUndefined();
  });

  it("an openai-compatible request carries no cache_control and the step completes", async () => {
    let body: string | null = null;
    const sse = [
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "done" },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        body = await req.text();
        return new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const entry: ModelRegistryEntry = {
      id: "local-m",
      provider: "openai-compatible",
      base_url: `http://127.0.0.1:${server.port}/v1`,
      context_window: 32_768,
      max_output: 8_192,
      prices: null,
      tools: true,
    };
    const f = fixture([]);
    const result = await runTurn({
      ...f.deps,
      entry,
      model: instantiate(entry, null),
      tools: CORE_TOOLS,
      ctx: { cwd: f.dir, exec: localExec(f.dir) },
    });
    server.stop(true);
    expect(result.status).toBe("done");
    expect(body).not.toBeNull();
    expect(String(body)).not.toContain("cache_control");
  });
});
