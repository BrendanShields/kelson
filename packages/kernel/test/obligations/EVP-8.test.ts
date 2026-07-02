import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runEval, writeLedgerEntry } from "../../src/evalrun.ts";
import { buildClaudeEnv } from "../../src/evaltask.ts";
import { openDb } from "../../src/storage.ts";
import {
  baseTask,
  FAST_GATE,
  lockWith,
  makeSnapshot,
  makeSuite,
  seedClaudeRun,
  tmpDir,
  WORKTREE,
} from "../eval-helpers.ts";

const store = tmpDir();
const snapshot = makeSnapshot({ "README.md": "x\n" }, store);

const overrideRun = (db: Database) =>
  runEval(db, {
    kind: "ablate",
    suiteDir: makeSuite([
      baseTask({
        id: "t",
        snapshot,
        // The override rides the env; a command session can observe it, which
        // also proves both sides received the same value (single run-level
        // option — a mismatch is unrepresentable).
        session_command: '[ "$ANTHROPIC_MODEL" = "gemma4:e4b" ]',
      }),
    ]),
    lockfileA: lockWith([{ name: "p", enabled: true }]),
    lockfileB: lockWith([{ name: "p", enabled: false }]),
    executor: "command",
    profile: WORKTREE,
    repeats: 1,
    snapshotStoreDir: store,
    gateOpts: FAST_GATE,
    sessionModel: { model: "gemma4:e4b", baseUrl: "http://localhost:11434" },
  });

describe("EVP-8: a session model override is recorded in the manifest, applied to both sides, and bars ledger publication", () => {
  it("the manifest carries session_model and session_base_url; both sides saw the override", () => {
    const db = openDb(":memory:");
    const result = overrideRun(db);
    expect(result.manifest.model_versions.session_model).toBe("gemma4:e4b");
    expect(result.manifest.model_versions.session_base_url).toBe(
      "http://localhost:11434",
    );
    // The session_command asserts $ANTHROPIC_MODEL on every execution; a side
    // missing the override would fail its session and flip fpar.
    const rows = db
      .query("SELECT side, fpar_pass FROM eval_task_result WHERE run_id = ?")
      .all(result.runId) as { side: string; fpar_pass: number }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.fpar_pass).toBe(1);
    db.close();
  });

  it("ledger publication from an overridden run is refused naming the override", () => {
    const db = openDb(":memory:");
    const runId = seedClaudeRun(db);
    db.query("UPDATE eval_run SET model_versions = ? WHERE id = ?").run(
      JSON.stringify({ session_model: "gemma4:e4b" }),
      runId,
    );
    expect(() =>
      writeLedgerEntry(db, {
        runId,
        pack: "ponytail",
        version: "1.0.0",
        ledgerDir: tmpDir(),
      }),
    ).toThrow(/session model override "gemma4:e4b".*EVP-8/);
    db.close();
  });

  it("with real credentials in the parent env, an override endpoint sees the dummy key and no OAuth token", () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    process.env.ANTHROPIC_API_KEY = "sk-real-operator-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "real-oauth-token";
    try {
      const overridden = buildClaudeEnv({
        ANTHROPIC_BASE_URL: "http://localhost:11434",
        ANTHROPIC_API_KEY: "kelson-local",
        ANTHROPIC_MODEL: "gemma4:e4b",
      });
      expect(overridden.ANTHROPIC_API_KEY).toBe("kelson-local");
      expect("CLAUDE_CODE_OAUTH_TOKEN" in overridden).toBe(false);
      // Without an override endpoint the operator credentials pass through.
      const normal = buildClaudeEnv({});
      expect(normal.ANTHROPIC_API_KEY).toBe("sk-real-operator-key");
      expect(normal.CLAUDE_CODE_OAUTH_TOKEN).toBe("real-oauth-token");
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  it("an un-overridden run's manifest carries no session_model", () => {
    const db = openDb(":memory:");
    const result = runEval(db, {
      kind: "ablate",
      suiteDir: makeSuite([baseTask({ id: "t", snapshot })]),
      lockfileA: lockWith([{ name: "p", enabled: true }]),
      lockfileB: lockWith([{ name: "p", enabled: false }]),
      executor: "command",
      profile: WORKTREE,
      repeats: 1,
      snapshotStoreDir: store,
      gateOpts: FAST_GATE,
    });
    expect("session_model" in result.manifest.model_versions).toBe(false);
    db.close();
  });
});
