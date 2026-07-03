import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CORE_TOOLS,
  instantiate,
  loadConfig,
  loadRegistry as loadModelRegistry,
  loadRules,
  localExec,
  resolveCredential,
  resolveEntry,
  type StepDeps,
} from "@kelson/agent";
import { DEFAULT_DB_PATH, hashLockfile, openDb } from "@kelson/kernel";
import type { AgentConfig, ModelRegistryEntry } from "@kelson/schemas";

export const fail = (msg: string): never => {
  console.error(`kelson: ${msg}`);
  process.exit(1);
};

// Pi-style minimal system prompt: the model already knows what a coding
// agent is; the harness adds constraints, not lectures.
export const SYSTEM_PROMPT =
  "You are Kelson, a coding agent working in the current repository. " +
  "Use the tools to read, search, and modify files and to run commands. " +
  "When the task is complete, reply with a short summary and stop calling tools.";

export interface AgentSetup {
  deps: Omit<StepDeps, "sessionId">;
  entry: ModelRegistryEntry;
  config: AgentConfig;
  lockfileHash: string;
  root: string;
}

// PROV-4: no configuration → instruct, never probe.
export const setupAgent = (
  root = process.cwd(),
  dbPath = DEFAULT_DB_PATH,
): AgentSetup => {
  const config = loadConfig(root);
  if (!config)
    return fail(
      "no agent configured — run `kelson auth login <provider>` first",
    );
  const lockPath = join(root, "kelson.lock");
  if (!existsSync(lockPath))
    return fail("no kelson.lock — run `kelson init` first");
  const lockfileHash = hashLockfile(JSON.parse(readFileSync(lockPath, "utf8")));

  const entry = resolveEntry(loadModelRegistry(), config.default_model);
  const credential = resolveCredential(
    entry.provider === "anthropic" ? "anthropic" : entry.id,
  );
  // PROV-4: a credential-less anthropic setup fails here with the login
  // instruction, not inside the SDK mid-request. openai-compatible endpoints
  // (local ollama) legitimately run keyless.
  if (entry.provider === "anthropic" && credential === null)
    return fail(
      "no anthropic credential — run `kelson auth login anthropic` first",
    );
  const model = instantiate(entry, credential);
  const db = openDb(dbPath);
  return {
    deps: {
      db,
      entry,
      model,
      tools: CORE_TOOLS,
      rules: loadRules(root),
      ctx: { cwd: root, exec: localExec(root) },
    },
    entry,
    config,
    lockfileHash,
    root,
  };
};
