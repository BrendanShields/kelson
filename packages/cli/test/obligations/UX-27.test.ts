import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@kelson/kernel";
import { DbBackupResult, DbStatsResult } from "@kelson/schemas";
import { makeTestRepo, runCli } from "../agent-helpers.ts";

const hashFile = (p: string): string =>
  new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");

// Fixture tables with known counts on top of the migrated schema — the
// expected values are seeded here, independent of the command's counting.
const seedStore = (dbPath: string): void => {
  const db = openDb(dbPath);
  db.exec("CREATE TABLE fixture_a (x TEXT)");
  db.exec("CREATE TABLE fixture_b (x TEXT)");
  for (let i = 0; i < 3; i++)
    db.query("INSERT INTO fixture_a (x) VALUES (?)").run(`a${i}`);
  for (let i = 0; i < 2; i++)
    db.query("INSERT INTO fixture_b (x) VALUES (?)").run(`b${i}`);
  db.close();
};

const countsOf = (path: string): Map<string, number> => {
  const db = new Database(path, { readonly: true });
  try {
    const names = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    return new Map(
      names.map(({ name }) => [
        name,
        (db.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number })
          .n,
      ]),
    );
  } finally {
    db.close();
  }
};

describe("UX-27: db stats is read-only with exact per-table counts; db backup is a consistent VACUUM INTO snapshot refusing an existing dest", () => {
  it("db stats reports path, size, and the exact seeded per-table counts; store bytes unchanged; --json validates", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".kelson", "kelson.db");
    seedStore(dbPath);
    const before = hashFile(dbPath);
    const r = await runCli(t, ["db", "stats", "--db", dbPath, "--json"]);
    expect(r.exitCode).toBe(0);
    const stats = DbStatsResult.parse(JSON.parse(r.stdout));
    expect(stats.path).toBe(dbPath);
    expect(stats.size_bytes).toBe(statSync(dbPath).size);
    const byName = new Map(stats.tables.map((tb) => [tb.name, tb.rows]));
    expect(byName.get("fixture_a")).toBe(3);
    expect(byName.get("fixture_b")).toBe(2);
    expect(hashFile(dbPath)).toBe(before);
    const rendered = await runCli(t, ["db", "stats", "--db", dbPath]);
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toContain("fixture_a");
    expect(hashFile(dbPath)).toBe(before);
  }, 30_000);

  it("db backup writes an openable snapshot whose per-table counts equal the source; source unchanged; --json validates", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".kelson", "kelson.db");
    seedStore(dbPath);
    const before = hashFile(dbPath);
    const dest = join(t.repo, "backup.db");
    const r = await runCli(t, ["db", "backup", dest, "--db", dbPath, "--json"]);
    expect(r.exitCode).toBe(0);
    const backup = DbBackupResult.parse(JSON.parse(r.stdout));
    expect(backup.source).toBe(dbPath);
    expect(backup.dest).toBe(dest);
    // Independent route: open both files directly and compare all counts.
    const src = countsOf(dbPath);
    const snap = countsOf(dest);
    expect(snap.size).toBe(src.size);
    for (const [name, n] of src) expect(snap.get(name)).toBe(n);
    expect(snap.get("fixture_a")).toBe(3);
    expect(snap.get("fixture_b")).toBe(2);
    expect(hashFile(dbPath)).toBe(before);
  }, 30_000);

  it("backup onto an existing dest exits non-zero leaving both files byte-identical", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".kelson", "kelson.db");
    seedStore(dbPath);
    const dest = join(t.repo, "occupied.db");
    writeFileSync(dest, "precious bytes, not a database");
    const beforeSource = hashFile(dbPath);
    const beforeDest = hashFile(dest);
    const r = await runCli(t, ["db", "backup", dest, "--db", dbPath]);
    expect(r.exitCode).not.toBe(0);
    expect(hashFile(dbPath)).toBe(beforeSource);
    expect(hashFile(dest)).toBe(beforeDest);
  }, 30_000);

  it("a missing store fails naming kelson init without creating it", async () => {
    const t = makeTestRepo({});
    const dbPath = join(t.repo, ".kelson", "kelson.db");
    const r = await runCli(t, ["db", "stats", "--db", dbPath]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("kelson init");
    expect(() => statSync(dbPath)).toThrow();
  }, 30_000);
});
