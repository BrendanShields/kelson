import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, registerArtifact } from "@kelson/kernel";
import { makeTestRepo, mockOpenAiServer, runCli } from "../agent-helpers.ts";

// Seed a clause + governed file + obligation test into the repo the CLI will
// open, so `kelson run` loads a non-empty SpecContext. Uses the realpath —
// the CLI child's process.cwd() resolves /tmp → /private/tmp on macOS, and
// trace links are keyed by that resolved repo path.
const seedRepo = (repoArg: string) => {
  const repo = realpathSync(repoArg);
  const db = openDb(join(repo, ".kelson", "kelson.db"));
  registerArtifact(db, {
    repo,
    logical_id: "AGT-DEMO",
    type: "spec",
    content: "clause AGT-DEMO",
    authority: "authored",
    tier: "T1",
  });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "governed.ts"), "// empty\n");
  registerArtifact(db, {
    repo,
    logical_id: "src/governed.ts",
    type: "code_region",
    content: "// empty\n",
    authority: "authored",
    tier: "T1",
    upstream: ["AGT-DEMO"],
  });
  const obDir = join(repo, "packages", "pkg", "test", "obligations");
  mkdirSync(obDir, { recursive: true });
  writeFileSync(
    join(obDir, "AGT-DEMO.test.ts"),
    `import { readFileSync } from "node:fs";
import { expect, it } from "bun:test";
it("sentinel", () => {
  expect(readFileSync("src/governed.ts", "utf8")).toContain("SENTINEL");
});
`,
  );
  db.close();
};

describe("AGT-9 (operator surface): kelson run over a spec-native repo emits a VerificationReport", () => {
  it("a run that writes the sentinel reaches done and records a clean report", async () => {
    const server = mockOpenAiServer([
      {
        kind: "tool",
        id: "c1",
        name: "write",
        input: { path: "src/governed.ts", content: "const x = 'SENTINEL';\n" },
      },
      { kind: "text", text: "done" },
    ]);
    const t = makeTestRepo({ baseUrl: server.url, configured: true });
    seedRepo(t.repo);
    const dbPath = join(t.repo, ".kelson", "kelson.db");
    const r = await runCli(t, [
      "run",
      "-p",
      "add the sentinel",
      "--allow-asks",
      "--db",
      dbPath,
      "--json",
    ]);
    expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    const report = db
      .query("SELECT results, failure_class FROM verification_report LIMIT 1")
      .get() as { results: string; failure_class: string | null } | null;
    expect(report).not.toBeNull();
    expect(report?.failure_class).toBeNull();
    const obligations = JSON.parse(report?.results ?? "{}").obligations as {
      clause_id: string;
      status: string;
    }[];
    expect(obligations.map((o) => [o.clause_id, o.status])).toEqual([
      ["AGT-DEMO", "passed"],
    ]);
    db.close();
    server.stop();
  }, 60_000);
});
