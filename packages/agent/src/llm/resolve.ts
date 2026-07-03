import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Credential, ModelRegistryEntry } from "@kelson/schemas";
import type { LanguageModel } from "ai";

// PROV-1: registry entry + credential -> configured AI SDK model instance.
// OAuth credentials use authToken (Bearer) instead of apiKey (Phase 7 wires
// the PKCE flow that mints them; the adapter path is already correct).
export const instantiate = (
  entry: ModelRegistryEntry,
  credential: Credential | null,
): LanguageModel => {
  if (entry.provider === "anthropic") {
    const provider = createAnthropic({
      ...(credential?.type === "api_key" ? { apiKey: credential.key } : {}),
      ...(credential?.type === "oauth" ? { authToken: credential.access } : {}),
      ...(entry.base_url ? { baseURL: entry.base_url } : {}),
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
