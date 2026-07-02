import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { verifyLedgerEntry, writeLedgerEntry } from "../../src/evalrun.ts";
import { openDb } from "../../src/storage.ts";
import { seedClaudeRun, tmpDir } from "../eval-helpers.ts";

// Generation-only rule (never hand-authored) is discharged jointly with
// EVT-3/EVP-7: writeLedgerEntry is the sole writer and refuses non-claude
// runs. Registry-CI enforcement is the Phase 5 half.
describe("EVP-6: ledger entries verify against the run manifest they name", () => {
  it("a hand-edited delta fails verification against its manifest (EVP-6)", () => {
    const db = openDb(":memory:");
    const runId = seedClaudeRun(db);
    const ledgerDir = tmpDir();
    const path = writeLedgerEntry(db, {
      runId,
      pack: "ponytail",
      version: "1.2.0",
      ledgerDir,
    });
    const entry = JSON.parse(readFileSync(path, "utf8"));
    entry.fpar_delta.mean = 0.99;
    writeFileSync(path, JSON.stringify(entry));
    const check = verifyLedgerEntry(db, path);
    expect(check.ok).toBe(false);
    expect(check.problems).toContain("fpar_delta mismatch");
    db.close();
  });

  it("an entry naming an unknown manifest fails verification", () => {
    const db = openDb(":memory:");
    const runId = seedClaudeRun(db);
    const ledgerDir = tmpDir();
    const path = writeLedgerEntry(db, {
      runId,
      pack: "ponytail",
      version: "1.2.0",
      ledgerDir,
    });
    const entry = JSON.parse(readFileSync(path, "utf8"));
    entry.run_manifest_hash = `sha256:${"f".repeat(64)}`;
    writeFileSync(path, JSON.stringify(entry));
    expect(verifyLedgerEntry(db, path).ok).toBe(false);
    db.close();
  });
});
