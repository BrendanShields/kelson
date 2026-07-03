import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

const WRITE_THEN_DONE = [
  {
    kind: "tool" as const,
    id: "call-1",
    name: "write",
    input: { path: "made.txt", content: "hello" },
  },
  { kind: "text" as const, text: "all done" },
];

describe("PERM-3: headless ask resolves to deny (denial is feedback); the allow flag permits", () => {
  it("without the flag the write is denied, the file does not exist, and the session still finishes", async () => {
    const server = mockOpenAiServer(WRITE_THEN_DONE);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    const r = await runCli(t, ["run", "-p", "write a file"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("all done");
    expect(existsSync(join(t.repo, "made.txt"))).toBe(false);
    server.stop();
  }, 20_000);

  it("with --allow-asks the write occurs", async () => {
    const server = mockOpenAiServer(WRITE_THEN_DONE);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    const r = await runCli(t, ["run", "-p", "write a file", "--allow-asks"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(t.repo, "made.txt"))).toBe(true);
    server.stop();
  }, 20_000);
});
