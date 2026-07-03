import { describe, expect, it } from "bun:test";
import { RunResult } from "@kelson/schemas";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

describe("UX-15: run streams plain text, --json validates against RunResult, exit 0 only on done", () => {
  it("plain mode emits the final text", async () => {
    const server = mockOpenAiServer([{ kind: "text", text: "plain answer" }]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    const r = await runCli(t, ["run", "-p", "say something"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("plain answer");
    server.stop();
  }, 20_000);

  it("--json output parses with the RunResult schema", async () => {
    const server = mockOpenAiServer([{ kind: "text", text: "json answer" }]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    const r = await runCli(t, ["run", "-p", "say something", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = RunResult.parse(JSON.parse(r.stdout));
    expect(parsed.status).toBe("done");
    expect(parsed.text).toBe("json answer");
    expect(parsed.steps).toBe(1);
    // Ollama-style zero prices: cost is a known 0, not unknown.
    expect(parsed.cost_micro_usd).toBe(0);
    server.stop();
  }, 20_000);

  it("a failed session exits non-zero", async () => {
    // Endpoint that nothing listens on — the session fails, exit must be ≠ 0.
    const t = makeTestRepo({
      baseUrl: "http://127.0.0.1:9/v1",
      configured: true,
    });
    const r = await runCli(t, ["run", "-p", "unreachable"]);
    expect(r.exitCode).not.toBe(0);
  }, 20_000);
});
