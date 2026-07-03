import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAuth,
  resolveCredential,
  saveCredential,
} from "../../src/llm/auth.ts";

describe("PROV-2: credentials at 0600, written atomically, stored wins over env", () => {
  it("round-trips a credential with file mode 0600 and no temp residue", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kelson-auth-")), "auth.json");
    saveCredential("anthropic", { type: "api_key", key: "sk-test-1" }, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Atomicity proxy (named): the write goes through <path>.tmp + rename —
    // no .tmp residue after a successful save is the observable half; a
    // crash-injection seam would require faulting the fs layer.
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(loadAuth(path)).toEqual({
      anthropic: { type: "api_key", key: "sk-test-1" },
    });
  });

  it("stored credential wins over the env fallback; env applies only when nothing is stored", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kelson-auth-")), "auth.json");
    const env = { ANTHROPIC_API_KEY: "sk-env" };
    expect(resolveCredential("anthropic", path, env)).toEqual({
      type: "api_key",
      key: "sk-env",
    });
    saveCredential("anthropic", { type: "api_key", key: "sk-stored" }, path);
    expect(resolveCredential("anthropic", path, env)).toEqual({
      type: "api_key",
      key: "sk-stored",
    });
    expect(resolveCredential("ollama", path, env)).toBeNull();
  });
});
