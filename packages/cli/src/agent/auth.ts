import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SHIPPED_MODELS, saveConfig, saveCredential } from "@obligato/agent";
import { ModelRegistryEntry } from "@obligato/schemas";
import { z } from "zod";
import { write } from "../components/sink.js";
import { fail } from "./common.js";

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

const writeOverlay = (entries: ModelRegistryEntry[]): void => {
  const path = join(homedir(), ".obligato", "models.json");
  // A fresh HOME has no ~/.obligato yet (saveCredential mkdirs its own path;
  // this write must too — E2E caught the ENOENT on a never-configured machine).
  mkdirSync(join(homedir(), ".obligato"), { recursive: true });
  const existing = existsSync(path)
    ? z.array(ModelRegistryEntry).parse(JSON.parse(readFileSync(path, "utf8")))
    : [];
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const e of entries) byId.set(e.id, e);
  writeFileSync(path, JSON.stringify([...byId.values()], null, 2));
};

// UX-16/PROV-4: flags-based so scripted logins work; never echoes the key.
export const authCommand = async (argv: string[]): Promise<void> => {
  const [sub, provider] = argv;
  if (sub !== "login" || !provider)
    return fail(
      "usage: obligato auth login <anthropic|ollama|openai-compatible> [--key <api-key> | --token <setup-token>] [--model --base-url --context --max-output]",
    );
  const named: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--") && argv[i + 1] !== undefined) {
      named[a.slice(2)] = argv[i + 1] as string;
      i++;
    }
  }
  const root = process.cwd();
  if (!existsSync(join(root, ".obligato")))
    return fail("no .obligato directory — run `obligato init` first");

  if (provider === "anthropic") {
    // PROV-5: --token stores a Claude subscription bearer (`claude
    // setup-token` output); --key stores an API key. One or the other.
    if (named.token && named.key)
      return fail("pass --key or --token, not both");
    const token = named.token ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const key = named.key ?? process.env.ANTHROPIC_API_KEY;
    if (named.token || (!key && token))
      saveCredential("anthropic", { type: "token", token: token as string });
    else if (key) saveCredential("anthropic", { type: "api_key", key });
    else
      return fail(
        "pass --key <api-key> or --token <setup-token> (or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)",
      );
    const model = named.model ?? SHIPPED_MODELS[0]?.id;
    if (!model) return fail("no shipped models — pass --model");
    saveConfig(root, { default_model: model, schema_version: 1 });
    write(`obligato: anthropic configured, default model ${model}`);
    return;
  }

  if (provider === "ollama") {
    const base = (named["base-url"] ?? OLLAMA_DEFAULT).replace(/\/$/, "");
    const res = await fetch(`${base}/api/tags`).catch(() => null);
    if (!res?.ok)
      return fail(`cannot reach ollama at ${base} — is it running?`);
    const tags = (await res.json()) as { models?: { name: string }[] };
    const names = (tags.models ?? []).map((m) => m.name);
    if (names.length === 0)
      return fail(
        `ollama at ${base} has no models — \`ollama pull\` one first`,
      );
    // Local inference is genuinely $0 marginal cost — 0 is true, not a guess.
    writeOverlay(
      names.map((name) => ({
        id: name,
        provider: "openai-compatible" as const,
        base_url: `${base}/v1`,
        context_window: 32_768,
        max_output: 8_192,
        prices: { in: 0, out: 0, cache_read: 0, cache_write: 0 },
        tools: true,
      })),
    );
    const model = named.model ?? (names[0] as string);
    if (!names.includes(model))
      return fail(`model ${model} not in ollama tags: ${names.join(", ")}`);
    saveConfig(root, { default_model: model, schema_version: 1 });
    write(
      `obligato: ollama configured (${names.length} model(s)), default ${model}`,
    );
    return;
  }

  if (provider === "openai-compatible") {
    // PROV-11: verbatim root minus a single trailing slash; never defaulted.
    const base = named["base-url"]?.replace(/\/$/, "");
    if (!base)
      return fail(
        "--base-url required: the endpoint's OpenAI-compatible root (e.g. https://openrouter.ai/api/v1)",
      );
    const model = named.model;
    if (!model) return fail("--model required: the model id to register");
    // PROV-11: value-based key resolution at login time only — an empty value
    // reads as absent, and the runtime never falls back to OPENAI_API_KEY
    // when resolving stored credentials (PROV-10 leak class).
    const key = named.key || process.env.OPENAI_API_KEY || null;
    const res = await fetch(`${base}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res)
      return fail(
        `cannot reach ${base}/models — check the URL (it should be the /v1 root)`,
      );
    // PROV-11: status before body — a 401 with a valid-looking list still fails.
    if (res.status === 401 || res.status === 403)
      return fail(`${base}/models rejected the credential (${res.status})`);
    // PROV-11: exactly 200 — a 2xx-not-200 falls to the fail-closed branch.
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as {
        data?: { id?: unknown }[];
      } | null;
      const ids =
        Array.isArray(body?.data) &&
        body.data.every((m) => typeof m?.id === "string")
          ? body.data.map((m) => m.id as string)
          : null;
      if (ids === null)
        write(
          `obligato: ${base}/models did not return a model list — skipping model check`,
        );
      else if (!ids.includes(model))
        return fail(
          `model ${model} not in ${base}/models list: ${ids.slice(0, 20).join(", ")}`,
        );
    } else if (res.status === 404 || res.status === 405 || res.status === 501) {
      write(
        `obligato: ${base} does not implement /models (${res.status}) — skipping model check`,
      );
    } else {
      // PROV-11: fail closed on any status the clause doesn't allowlist.
      return fail(`${base}/models answered ${res.status} — not configuring`);
    }
    // Zod gate before any persist: a non-numeric --context/--max-output must
    // fail here, not corrupt the overlay.
    const entry = ModelRegistryEntry.parse({
      id: model,
      provider: "openai-compatible",
      base_url: base,
      context_window: Number(named.context ?? 128_000),
      max_output: Number(named["max-output"] ?? 16_384),
      prices: null,
      tools: true,
    });
    writeOverlay([entry]);
    if (key) saveCredential(model, { type: "api_key", key });
    saveConfig(root, { default_model: model, schema_version: 1 });
    write(
      `obligato: openai-compatible endpoint configured, default model ${model}`,
    );
    return;
  }

  return fail(
    `unknown provider: ${provider} (have: anthropic, ollama, openai-compatible)`,
  );
};
