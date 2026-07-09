import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Credential, ModelRegistryEntry } from "@kelson/schemas";
import type { LanguageModel } from "ai";

// PROV-1: registry entry + credential -> configured AI SDK model instance.
// OAuth credentials use authToken (Bearer) instead of apiKey (Phase 7 wires
// the PKCE flow that mints them; the adapter path is already correct).
// opts.fetch is the test seam for the official (no base_url) endpoint —
// obligation fixtures capture the outbound request without leaving the
// process (PROV-5/PROV-10). Structural call signature, not typeof fetch:
// bun's fetch type adds a preconnect property no test double carries; the
// SDK only ever calls the function, so the cast at the spread is sound.
export type FetchLike = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export const instantiate = (
  entry: ModelRegistryEntry,
  credential: Credential | null,
  opts: { fetch?: FetchLike } = {},
): LanguageModel => {
  if (entry.provider === "anthropic") {
    // PROV-10: any base_url on an anthropic entry reads as an override
    // endpoint — the official endpoint is spelled by omitting base_url.
    // Operator credentials are withheld there on every request: the dummy
    // key defeats the SDK's process.env.ANTHROPIC_API_KEY fallback (F-119),
    // and no OAuth bearer or beta header rides along (the adapter sends
    // exactly one auth header — apiKey set means no Authorization).
    if (entry.base_url) {
      const provider = createAnthropic({
        apiKey: "kelson-local",
        baseURL: entry.base_url,
        ...(opts.fetch ? { fetch: opts.fetch as typeof globalThis.fetch } : {}),
      });
      return provider(entry.id);
    }
    const bearer =
      credential?.type === "token"
        ? credential.token
        : credential?.type === "oauth"
          ? credential.access
          : null;
    const provider = createAnthropic({
      ...(credential?.type === "api_key" ? { apiKey: credential.key } : {}),
      // PROV-5: subscription tokens ride Authorization: Bearer plus the OAuth
      // beta header (claude-api reference) — never x-api-key.
      ...(bearer
        ? {
            authToken: bearer,
            headers: { "anthropic-beta": "oauth-2025-04-20" },
          }
        : {}),
      ...(opts.fetch ? { fetch: opts.fetch as typeof globalThis.fetch } : {}),
    });
    return provider(entry.id);
  }
  const provider = createOpenAICompatible({
    name: entry.id,
    baseURL: entry.base_url ?? "http://127.0.0.1:11434/v1",
    // AGT-3: without stream_options.include_usage, Ollama omits usage and
    // token counts silently record as 0 (caught by the first live smoke).
    includeUsage: true,
    ...(credential?.type === "api_key" ? { apiKey: credential.key } : {}),
  });
  return provider(entry.id);
};
