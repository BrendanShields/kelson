import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRegistryEntry } from "@kelson/schemas";
import { z } from "zod";
import { SHIPPED_MODELS } from "./models.ts";

export interface Usage {
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

// PROV-1: shipped registry overlaid by ~/.kelson/models.json; overlay wins
// on id collision.
export const loadRegistry = (
  overlayPath = join(homedir(), ".kelson", "models.json"),
): ModelRegistryEntry[] => {
  const byId = new Map(SHIPPED_MODELS.map((m) => [m.id, m]));
  if (existsSync(overlayPath)) {
    const overlay = z
      .array(ModelRegistryEntry)
      .parse(JSON.parse(readFileSync(overlayPath, "utf8")));
    for (const m of overlay) byId.set(m.id, m);
  }
  return [...byId.values()];
};

export const resolveEntry = (
  registry: ModelRegistryEntry[],
  ref: string,
): ModelRegistryEntry => {
  const entry = registry.find((m) => m.id === ref);
  if (!entry)
    throw new Error(
      `unknown model "${ref}" — known models: ${registry.map((m) => m.id).join(", ")}`,
    );
  return entry;
};

// PROV-3: integer micro-USD from registry prices; null (never estimated)
// when the model has no prices.
export const costOf = (
  usage: Usage,
  entry: ModelRegistryEntry,
): number | null => {
  if (entry.prices === null) return null;
  const p = entry.prices;
  return Math.round(
    (usage.tokens_in * p.in +
      usage.tokens_out * p.out +
      usage.tokens_cache_read * p.cache_read +
      usage.tokens_cache_write * p.cache_write) /
      1_000_000,
  );
};
