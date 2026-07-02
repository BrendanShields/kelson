import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { LedgerEntry } from "@kelson/schemas";
import { verifyLedgerEntry, writeLedgerEntry } from "../../src/evalrun.ts";
import { openDb } from "../../src/storage.ts";
import { seedClaudeRun, tmpDir } from "../eval-helpers.ts";

describe("EVT-3/EVP-6: ledger entries are runner-generated, schema-valid, and verified against their manifest", () => {
  it("a runner-generated entry validates and passes verification", () => {
    const db = openDb(":memory:");
    const runId = seedClaudeRun(db);
    const ledgerDir = tmpDir();
    const path = writeLedgerEntry(db, {
      runId,
      pack: "ponytail",
      version: "1.2.0",
      ledgerDir,
    });
    const entry = LedgerEntry.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(entry.verdict).toBe("helps");
    expect(entry.n).toBe(24);
    expect(verifyLedgerEntry(db, path)).toEqual({ ok: true, problems: [] });
    db.close();
  });
});
