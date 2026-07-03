import { describe, expect, it } from "bun:test";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

describe("PROV-4: no config → instruct and exit, never probe; login unblocks", () => {
  it("an unconfigured invocation exits non-zero mentioning kelson auth login and calls no endpoint", async () => {
    const server = mockOpenAiServer([{ kind: "text", text: "hi" }]);
    // Overlay names the endpoint, but no config.json selects a model — the
    // CLI must not touch the network to find one.
    const t = makeTestRepo({ baseUrl: server.url, configured: false });
    const r = await runCli(t, ["run", "-p", "hello"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("kelson auth login");
    expect(server.calls()).toBe(0);
    server.stop();
  }, 20_000);

  it("a configured anthropic model with no credential fails fast naming kelson auth login", async () => {
    const t = makeTestRepo({ configured: false });
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(
      join(t.repo, ".kelson", "config.json"),
      JSON.stringify({ default_model: "claude-opus-4-8", schema_version: 1 }),
    );
    const r = await runCli(t, ["run", "-p", "hello"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("kelson auth login");
  }, 20_000);

  it("after a scripted login the same invocation proceeds past setup", async () => {
    const server = mockOpenAiServer([{ kind: "text", text: "hi from mock" }]);
    const t = makeTestRepo({ baseUrl: server.url, configured: false });
    const login = await runCli(t, [
      "auth",
      "login",
      "anthropic",
      "--key",
      "sk-test-cred",
      "--model",
      "mock-m",
    ]);
    expect(login.exitCode).toBe(0);
    const r = await runCli(t, ["run", "-p", "hello"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hi from mock");
    expect(server.calls()).toBe(1);
    server.stop();
  }, 20_000);
});
