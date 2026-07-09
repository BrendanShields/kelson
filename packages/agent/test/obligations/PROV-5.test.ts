import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistryEntry } from "@kelson/schemas";
import { resolveCredential, saveCredential } from "../../src/llm/auth.ts";
import { instantiate } from "../../src/llm/resolve.ts";
import { runTurn } from "../../src/loop.ts";
import { CORE_TOOLS, localExec } from "../../src/tools.ts";
import { fixture } from "../helpers.ts";

describe("PROV-5: subscription token precedence and Bearer wiring", () => {
  it("resolves stored > ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kelson-auth-")), "auth.json");
    const both = {
      ANTHROPIC_API_KEY: "sk-env",
      CLAUDE_CODE_OAUTH_TOKEN: "tok-env",
    };
    expect(resolveCredential("anthropic", path, both)).toEqual({
      type: "api_key",
      key: "sk-env",
    });
    expect(
      resolveCredential("anthropic", path, {
        CLAUDE_CODE_OAUTH_TOKEN: "tok-env",
      }),
    ).toEqual({ type: "token", token: "tok-env" });
    saveCredential("anthropic", { type: "token", token: "tok-stored" }, path);
    expect(resolveCredential("anthropic", path, both)).toEqual({
      type: "token",
      token: "tok-stored",
    });
  });

  it("a token credential's request carries Bearer + the OAuth beta header and no x-api-key", async () => {
    // Capturing fetch on the official (no base_url) endpoint — PROV-10 makes
    // any base_url an override endpoint that withholds credentials, so the
    // credentialed request is observed via the injected-fetch seam instead.
    let headers: Record<string, string> | null = null;
    const capturingFetch = async (
      _input: URL | RequestInfo,
      init?: RequestInit,
    ): Promise<Response> => {
      headers = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "capture only" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };
    const entry: ModelRegistryEntry = {
      id: "claude-opus-4-8",
      provider: "anthropic",
      context_window: 1_000_000,
      max_output: 64_000,
      prices: null,
      tools: true,
    };
    const f = fixture([]);
    const deps = {
      ...f.deps,
      entry,
      model: instantiate(
        entry,
        { type: "token", token: "tok-sub" },
        { fetch: capturingFetch },
      ),
      tools: CORE_TOOLS,
      ctx: { cwd: f.dir, exec: localExec(f.dir) },
    };
    await runTurn(deps).catch(() => {});
    expect(headers).not.toBeNull();
    const h = headers as unknown as Record<string, string>;
    expect(h.authorization).toBe("Bearer tok-sub");
    expect(h["anthropic-beta"] ?? "").toContain("oauth-2025-04-20");
    expect(h["x-api-key"]).toBeUndefined();
  });
});
