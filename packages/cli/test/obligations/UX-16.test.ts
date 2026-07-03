import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

const filesUnder = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
};

describe("UX-16: login unblocks chat/run; the credential is never echoed and lives only in auth.json", () => {
  it("post-login run proceeds; the key appears in no output and no file except auth.json", async () => {
    const SECRET = "sk-test-cred-XYZZY";
    const server = mockOpenAiServer([{ kind: "text", text: "ok" }]);
    const t = makeTestRepo({ baseUrl: server.url, configured: false });

    const login = await runCli(t, [
      "auth",
      "login",
      "anthropic",
      "--key",
      SECRET,
      "--model",
      "mock-m",
    ]);
    expect(login.exitCode).toBe(0);
    expect(login.stdout).not.toContain(SECRET);
    expect(login.stderr).not.toContain(SECRET);

    const r = await runCli(t, ["run", "-p", "go"]);
    expect(r.exitCode).toBe(0);

    const authPath = join(t.home, ".kelson", "auth.json");
    expect(readFileSync(authPath, "utf8")).toContain(SECRET);
    const offenders = [...filesUnder(t.repo), ...filesUnder(t.home)]
      .filter((p) => p !== authPath)
      .filter((p) => {
        try {
          return readFileSync(p, "utf8").includes(SECRET);
        } catch {
          return false;
        }
      });
    expect(offenders).toEqual([]);
    server.stop();
  }, 20_000);
});
