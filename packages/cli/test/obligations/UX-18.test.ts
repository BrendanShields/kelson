import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runBench } from "@kelson/kernel";
import { BenchReport } from "@kelson/schemas";
import {
  baseTask,
  makeSnapshot,
  makeSuite,
  tmpDir,
} from "../../../kernel/test/eval-helpers.ts";
import { BENCH_ENTRY } from "../../src/commands/bench.js";
import { JSON_OUTPUT } from "../../src/output/registry.js";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

const setupBenchRepo = (baseUrl: string) => {
  const t = makeTestRepo({ baseUrl, configured: false });
  const store = tmpDir();
  // The task snapshot commits its own .kelson/config.json — the api
  // executor's model source inside the sandbox (EVP-9 pattern).
  const snapshot = makeSnapshot(
    {
      "README.md": "fixture\n",
      ".kelson/config.json": JSON.stringify({
        default_model: "mock-m",
        schema_version: 1,
      }),
    },
    store,
  );
  const suiteDir = makeSuite([
    baseTask({
      id: "t1",
      snapshot,
      statement: "create done.txt containing ok",
      checks: [{ kind: "artifact_exists", path: "done.txt" }],
      // the baseline (command agent) always fails; the api candidate writes
      session_command: "exit 1",
    }),
  ]);
  const dbPath = join(t.repo, ".kelson", "kelson.db");
  return { t, suiteDir, dbPath, store };
};

// One write + one final answer per api session; two invocations in this file.
const TURNS = [
  {
    kind: "tool" as const,
    id: "b1",
    name: "write",
    input: { path: "done.txt", content: "ok" },
  },
  { kind: "text" as const, text: "created" },
  {
    kind: "tool" as const,
    id: "b2",
    name: "write",
    input: { path: "done.txt", content: "ok" },
  },
  { kind: "text" as const, text: "created" },
];

describe("UX-18: kelson bench renders the matrix + full verdict; --json validates BenchReport", () => {
  it("dispatches to the exported kernel entry (F-085 identity)", () => {
    expect(BENCH_ENTRY).toBe(runBench);
  });

  it("the JSON_OUTPUT registry declares the BenchReport schema (UX-1 matrix)", () => {
    const entry = JSON_OUTPUT.bench;
    expect(entry !== undefined && "schema" in entry).toBe(true);
    if (entry && "schema" in entry) expect(entry.schema).toBe(BenchReport);
  });

  it("renders per-task matrix with symbols and a verdict with CIs + underpowered deficit", async () => {
    const server = mockOpenAiServer(TURNS);
    const { t, suiteDir, dbPath, store } = setupBenchRepo(server.url);
    const r = await runCli(t, [
      "bench",
      "--suite",
      suiteDir,
      "--agents",
      "api,command",
      "--repeats",
      "1",
      "--db",
      dbPath,
      "--snapshots",
      store,
    ]);
    // Exit 0 on any completed verdict — underpowered is a successful
    // measurement (UX-18).
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("t1");
    // symbols accompany color (UX-4): candidate passed, baseline failed
    expect(r.stdout).toContain("✓ pass");
    expect(r.stdout).toContain("✗ fail");
    // never a bare verdict: decision + both deltas with CIs + n/alpha/B
    expect(r.stdout).toContain("verdict: underpowered");
    expect(r.stdout).toMatch(/fpar delta:\s+[+-][\d.]+ \[/);
    expect(r.stdout).toMatch(/cost delta:\s+[+-][\d.]+% \[/);
    expect(r.stdout).toMatch(/n=1 alpha=0\.05 B=\d+/);
    // underpowered names its deficit (UX-P5)
    expect(r.stdout).toMatch(/19 more paired tasks needed/);
    server.stop();
  }, 30_000);

  it("a pre-flight refusal exits non-zero with a kelson: diagnostic, not a raw stack", async () => {
    const t = makeTestRepo({ configured: false });
    const r = await runCli(t, [
      "bench",
      "--suite",
      join(t.repo, "no-such-suite"),
      "--agents",
      "command,command",
      "--db",
      join(t.repo, ".kelson", "kelson.db"),
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("kelson:");
    expect(r.stderr).not.toContain("    at "); // no stack frames
  }, 20_000);

  it("--json emits a BenchReport that round-trips its registered schema", async () => {
    const server = mockOpenAiServer(TURNS);
    const { t, suiteDir, dbPath, store } = setupBenchRepo(server.url);
    const r = await runCli(t, [
      "bench",
      "--suite",
      suiteDir,
      "--agents",
      "api,command",
      "--repeats",
      "1",
      "--db",
      dbPath,
      "--snapshots",
      store,
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const report = BenchReport.parse(JSON.parse(r.stdout));
    expect(report.candidate).toBe("api");
    expect(report.baseline).toBe("command");
    expect(report.rows).toEqual([
      {
        task_id: "t1",
        candidate_fpar: 1,
        baseline_fpar: 0,
        candidate_cost_micro_usd: 0,
        baseline_cost_micro_usd: 0,
      },
    ]);
    expect(report.verdict.decision).toBe("underpowered");
    server.stop();
  }, 30_000);
});
