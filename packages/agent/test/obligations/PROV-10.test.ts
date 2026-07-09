import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ModelRegistryEntry } from "@kelson/schemas";
import { instantiate } from "../../src/llm/resolve.ts";
import { runTurn } from "../../src/loop.ts";
import {
  appendEvent,
  appendModelSwitch,
  listEvents,
  reconstruct,
} from "../../src/sessions.ts";
import { fixture, TEST_ENTRY, textResponse } from "../helpers.ts";
import { testRoutingContext } from "../routing-helpers.ts";

// Valid minimal anthropic messages SSE stream so each step completes
// end-to-end through the real adapter (no live endpoint — F-119 rule: the
// assertion is on the header VALUE the server saw, never the code branch).
const anthropicSse = (text: string): string =>
  [
    {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

const captureServer = (reply: string) => {
  const seen: Record<string, string>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      seen.push(Object.fromEntries(req.headers.entries()));
      return new Response(reply, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    seen,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
};

const overrideEntry = (id: string, baseUrl: string): ModelRegistryEntry => ({
  id,
  provider: "anthropic",
  base_url: baseUrl,
  context_window: 1_000_000,
  max_output: 64_000,
  prices: null,
  tools: true,
});

const OFFICIAL: ModelRegistryEntry = {
  id: "claude-official",
  provider: "anthropic",
  context_window: 1_000_000,
  max_output: 64_000,
  prices: null,
  tools: true,
};

const one = (seen: Record<string, string>[]): Record<string, string> => {
  const h = seen[0];
  if (!h) throw new Error("no request captured");
  return h;
};

const assertWithheld = (h: Record<string, string>): void => {
  expect(h["x-api-key"]).toBe("kelson-local");
  expect(h.authorization).toBeUndefined();
  expect(h["anthropic-beta"] ?? "").not.toContain("oauth-2025-04-20");
};

describe("PROV-10: override endpoints never see operator credentials", () => {
  // Env sentinel: proves the SDK's process.env.ANTHROPIC_API_KEY fallback is
  // defeated (F-119 leak class). Restored after the suite.
  const ENV_BEFORE = process.env.ANTHROPIC_API_KEY;
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "real-secret-key";
  });
  afterAll(() => {
    if (ENV_BEFORE === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ENV_BEFORE;
  });

  it("(a) a session started against an override base URL sends kelson-local and no bearer", async () => {
    const srv = captureServer(anthropicSse("ok"));
    try {
      const entry = overrideEntry("claude-opus-4-8", srv.url);
      const f = fixture([]);
      const result = await runTurn({
        ...f.deps,
        entry,
        model: instantiate(entry, { type: "api_key", key: "sk-real-stored" }),
      });
      expect(result.status).toBe("done");
      expect(srv.seen.length).toBe(1);
      assertWithheld(one(srv.seen));
      // Neither the stored key nor the env key reached the endpoint anywhere.
      expect(JSON.stringify(srv.seen)).not.toContain("sk-real-stored");
      expect(JSON.stringify(srv.seen)).not.toContain("real-secret-key");
    } finally {
      srv.stop();
    }
  });

  it("(b) a mid-session /model switch onto an override endpoint withholds; (d) switching back sends the stored credential", async () => {
    const srv = captureServer(anthropicSse("from override"));
    // (d) the official endpoint cannot be hit — capture via injected fetch.
    const officialSeen: Record<string, string>[] = [];
    const officialFetch = async (
      _input: URL | RequestInfo,
      init?: RequestInit,
    ): Promise<Response> => {
      officialSeen.push(
        Object.fromEntries(new Headers(init?.headers).entries()),
      );
      return new Response(anthropicSse("from official"), {
        headers: { "content-type": "text/event-stream" },
      });
    };
    try {
      const OVERRIDE = overrideEntry("claude-override", srv.url);
      const f = fixture([textResponse("first step on the session model")]);
      // The UX-17 switch path: loop resolves the chain-recorded model through
      // resolveModel, which instantiates with the operator's REAL credential —
      // withholding must happen inside instantiate, not at the call site.
      f.deps.resolveModel = (ref) => {
        if (ref === OVERRIDE.id)
          return {
            entry: OVERRIDE,
            model: instantiate(OVERRIDE, {
              type: "token",
              token: "tok-real-stored",
            }),
          };
        if (ref === OFFICIAL.id)
          return {
            entry: OFFICIAL,
            model: instantiate(
              OFFICIAL,
              { type: "api_key", key: "sk-real-stored" },
              { fetch: officialFetch },
            ),
          };
        throw new Error(`unexpected ref ${ref}`);
      };
      expect((await runTurn(f.deps)).status).toBe("done");

      appendModelSwitch(f.db, f.sessionId, TEST_ENTRY.id, OVERRIDE.id);
      let head = reconstruct(listEvents(f.db, f.sessionId)).at(-1)?.id;
      if (!head) throw new Error("no head");
      appendEvent(f.db, {
        session_id: f.sessionId,
        parent_id: head,
        kind: "user_message",
        payload: { text: "second turn on the override model" },
      });
      expect((await runTurn(f.deps)).status).toBe("done");
      expect(srv.seen.length).toBe(1);
      // A subscription-token credential: no bearer, no beta header, dummy key.
      assertWithheld(one(srv.seen));
      expect(JSON.stringify(srv.seen)).not.toContain("tok-real-stored");

      appendModelSwitch(f.db, f.sessionId, OVERRIDE.id, OFFICIAL.id);
      head = reconstruct(listEvents(f.db, f.sessionId)).at(-1)?.id;
      if (!head) throw new Error("no head");
      appendEvent(f.db, {
        session_id: f.sessionId,
        parent_id: head,
        kind: "user_message",
        payload: { text: "third turn, back on the credentialed provider" },
      });
      expect((await runTurn(f.deps)).status).toBe("done");
      const oh = one(officialSeen);
      expect(oh["x-api-key"]).toBe("sk-real-stored");
      expect(oh.authorization).toBeUndefined();
      // The override endpoint saw nothing further after the switch back.
      expect(srv.seen.length).toBe(1);
    } finally {
      srv.stop();
    }
  });

  it("(c) a routed step (AGT-10) resolving to an override-endpoint model withholds", async () => {
    const srv = captureServer(anthropicSse("routed"));
    try {
      const f = fixture([]);
      f.deps.routing = testRoutingContext(100_000);
      f.deps.resolveModel = (ref) => {
        const entry = overrideEntry(ref, srv.url);
        return {
          entry,
          model: instantiate(entry, { type: "api_key", key: "sk-real-stored" }),
        };
      };
      const result = await runTurn(f.deps);
      expect(result.status).toBe("done");
      // Proof the step went through routing, not the fixed session model.
      const n = (
        f.db.query("SELECT COUNT(*) AS n FROM routing_decision").get() as {
          n: number;
        }
      ).n;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(srv.seen.length).toBe(1);
      assertWithheld(one(srv.seen));
      expect(JSON.stringify(srv.seen)).not.toContain("sk-real-stored");
      expect(JSON.stringify(srv.seen)).not.toContain("real-secret-key");
    } finally {
      srv.stop();
    }
  });
});
