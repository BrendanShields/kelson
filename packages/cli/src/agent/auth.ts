import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SHIPPED_MODELS, saveConfig, saveCredential } from "@obligato/agent";
import { type Credential, ModelRegistryEntry } from "@obligato/schemas";
import { z } from "zod";
import { write } from "../components/sink.js";
import { fail } from "./common.js";

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

const overlayPath = () => join(homedir(), ".obligato", "models.json");

const readOverlay = (): ModelRegistryEntry[] =>
  existsSync(overlayPath())
    ? z
        .array(ModelRegistryEntry)
        .parse(JSON.parse(readFileSync(overlayPath(), "utf8")))
    : [];

const writeOverlay = (entries: ModelRegistryEntry[]): void => {
  // A fresh HOME has no ~/.obligato yet (saveCredential mkdirs its own path;
  // this write must too — E2E caught the ENOENT on a never-configured machine).
  mkdirSync(join(homedir(), ".obligato"), { recursive: true });
  const byId = new Map(readOverlay().map((m) => [m.id, m]));
  for (const e of entries) byId.set(e.id, e);
  writeFileSync(overlayPath(), JSON.stringify([...byId.values()], null, 2));
};

// PROV-12: best-effort detection, strictly after credential/config persistence
// — never fails the login. The root env seam is test-only, honored for
// loopback hosts only — a non-loopback seam disables detection rather than
// falling through, so the real credential can never be redirected (F-119
// class); PROV-10 stays the sole endpoint-override surface.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

const detectAnthropicModels = async (credential: Credential): Promise<void> => {
  const skip = (why: string) =>
    write(`obligato: model detection skipped (${why}) — using shipped models`);
  let root = "https://api.anthropic.com";
  const seam = process.env.OBLIGATO_TEST_ANTHROPIC_ROOT;
  if (seam) {
    let host: string;
    try {
      host = new URL(seam).hostname;
    } catch {
      return skip("non-loopback test root ignored");
    }
    if (!LOOPBACK_HOSTS.has(host))
      return skip("non-loopback test root ignored");
    root = seam.replace(/\/$/, "");
  }
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
  };
  if (credential.type === "token") {
    // PROV-5 header discipline: bearer + OAuth beta header, never x-api-key.
    headers.authorization = `Bearer ${credential.token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else if (credential.type === "api_key") {
    headers["x-api-key"] = credential.key;
  }
  const found: {
    id: string;
    max_input_tokens: number;
    max_tokens: number;
  }[] = [];
  let after: string | null = null;
  for (;;) {
    const url = new URL(`${root}/v1/models`);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after_id", after);
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    // 200-only partition: a rejected credential (401 — e.g. a subscription
    // token the endpoint refuses) degrades to no detection, never a failure.
    if (res?.status !== 200)
      return skip(
        res ? `endpoint answered ${res.status}` : "endpoint unreachable",
      );
    const body = (await res.json().catch(() => null)) as {
      data?: {
        id?: unknown;
        max_input_tokens?: unknown;
        max_tokens?: unknown;
      }[];
      has_more?: boolean;
      last_id?: string;
    } | null;
    if (!Array.isArray(body?.data)) return skip("no model list in response");
    for (const m of body.data)
      if (
        typeof m.id === "string" &&
        Number.isInteger(m.max_input_tokens) &&
        Number.isInteger(m.max_tokens)
      )
        found.push({
          id: m.id,
          max_input_tokens: m.max_input_tokens as number,
          max_tokens: m.max_tokens as number,
        });
    if (body.has_more !== true) break;
    // Auditor-surfaced two-reading edge, pinned as malformed: a has_more page
    // without a cursor stops detection — accumulated entries are discarded.
    if (typeof body.last_id !== "string") return skip("malformed page");
    after = body.last_id;
  }

  const shipped = new Set(SHIPPED_MODELS.map((m) => m.id));
  const existing = new Map(readOverlay().map((m) => [m.id, m]));
  const entries = found
    .filter((m) => !shipped.has(m.id))
    .map((m) =>
      ModelRegistryEntry.parse({
        id: m.id,
        provider: "anthropic",
        context_window: m.max_input_tokens,
        max_output: m.max_tokens,
        // Bulk detection never clobbers hand-maintained prices (PROV-3:
        // unknown is never estimated, known is never discarded).
        prices: existing.get(m.id)?.prices ?? null,
        tools: true,
      }),
    );
  if (entries.length === 0) return;
  writeOverlay(entries);
  write(`obligato: detected ${entries.length} additional model(s)`);
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
    let cred: Credential;
    if (named.token || (!key && token))
      cred = { type: "token", token: token as string };
    else if (key) cred = { type: "api_key", key };
    else
      return fail(
        "pass --key <api-key> or --token <setup-token> (or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)",
      );
    saveCredential("anthropic", cred);
    const model = named.model ?? SHIPPED_MODELS[0]?.id;
    if (!model) return fail("no shipped models — pass --model");
    saveConfig(root, { default_model: model, schema_version: 1 });
    // PROV-12: after both persists; a throw (e.g. corrupt overlay) degrades
    // to the same skipped-detection notice, never a failed login.
    await detectAnthropicModels(cred).catch(() =>
      write("obligato: model detection skipped (error) — using shipped models"),
    );
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
