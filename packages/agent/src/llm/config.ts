import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentConfig } from "@kelson/schemas";

export const configPath = (repoRoot: string): string =>
  join(repoRoot, ".kelson", "config.json");

export const loadConfig = (repoRoot: string): AgentConfig | null => {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return null;
  return AgentConfig.parse(JSON.parse(readFileSync(path, "utf8")));
};

export const saveConfig = (repoRoot: string, config: AgentConfig): void => {
  writeFileSync(
    configPath(repoRoot),
    JSON.stringify(AgentConfig.parse(config), null, 2),
  );
};
