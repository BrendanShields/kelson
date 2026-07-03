import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthFile, type Credential } from "@kelson/schemas";

export const defaultAuthPath = (): string =>
  join(homedir(), ".kelson", "auth.json");

export const loadAuth = (path = defaultAuthPath()): AuthFile => {
  if (!existsSync(path)) return {};
  return AuthFile.parse(JSON.parse(readFileSync(path, "utf8")));
};

// PROV-2: 0600, atomic (temp file + rename).
export const saveCredential = (
  provider: string,
  credential: Credential,
  path = defaultAuthPath(),
): void => {
  const auth = { ...loadAuth(path), [provider]: credential };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(AuthFile.parse(auth), null, 2), {
    mode: 0o600,
  });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

const ENV_FALLBACK: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
};

// PROV-2: stored credential wins over env.
export const resolveCredential = (
  provider: string,
  path = defaultAuthPath(),
  env: Record<string, string | undefined> = process.env,
): Credential | null => {
  const stored = loadAuth(path)[provider];
  if (stored) return stored;
  const envVar = ENV_FALLBACK[provider];
  const key = envVar ? env[envVar] : undefined;
  return key ? { type: "api_key", key } : null;
};
