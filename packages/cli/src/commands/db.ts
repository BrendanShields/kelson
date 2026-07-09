import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { DEFAULT_DB_PATH } from "@kelson/kernel";
import {
  DbBackupResult,
  DbStatsResult,
  type DbTableCount,
} from "@kelson/schemas";
import { fail } from "../agent/common.js";
import { parseArgs } from "../args.js";
import { kvGrid, panel } from "../components/render.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";

// UX-27: stats and backup never mutate the source, so neither goes through
// openDb — it applies pending migrations on open. Read-only connections only.
const openReadonly = (path: string): Database => {
  if (!existsSync(path))
    return fail(`${path} does not exist — fix: kelson init`);
  return new Database(path, { readonly: true });
};

const tableCounts = (db: Database): DbTableCount[] =>
  (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map(({ name }) => ({
    name,
    rows: (
      db.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }
    ).n,
  }));

const tableRows = (tables: DbTableCount[]): [string, string][] =>
  tables.map((t) => [t.name, `${t.rows} rows`]);

const statsCommand = (argv: string[]): void => {
  const { named } = parseArgs(argv);
  const path = typeof named.db === "string" ? named.db : DEFAULT_DB_PATH;
  const db = openReadonly(path);
  let tables: DbTableCount[];
  try {
    tables = tableCounts(db);
  } finally {
    db.close();
  }
  const result = DbStatsResult.parse({
    path,
    size_bytes: statSync(path).size,
    tables,
    schema_version: 1,
  });
  if (named.json === true) emitJson(result);
  else
    write(
      panel(
        "db stats",
        kvGrid([
          ["path", result.path],
          ["size", `${result.size_bytes} bytes`],
          ...tableRows(result.tables),
        ]),
      ),
    );
};

const backupCommand = (argv: string[]): void => {
  const { named, positional } = parseArgs(argv);
  const dest = positional[0];
  if (dest === undefined) return fail("usage: kelson db backup <dest>");
  // Refused before any connection opens — neither file may be touched.
  if (existsSync(dest))
    return fail(`${dest} already exists — refusing to overwrite`);
  const source = typeof named.db === "string" ? named.db : DEFAULT_DB_PATH;
  const db = openReadonly(source);
  let tables: DbTableCount[];
  try {
    db.run("VACUUM INTO ?", [dest]);
    tables = tableCounts(db);
  } finally {
    db.close();
  }
  const result = DbBackupResult.parse({
    source,
    dest,
    size_bytes: statSync(dest).size,
    tables,
    schema_version: 1,
  });
  if (named.json === true) emitJson(result);
  else
    write(
      panel(
        "db backup",
        kvGrid([
          ["source", result.source],
          ["dest", result.dest],
          ["size", `${result.size_bytes} bytes`],
          ...tableRows(result.tables),
        ]),
      ),
    );
};

export const dbCommand = (argv: string[]): void => {
  const sub = argv[0];
  if (sub === "stats") return statsCommand(argv.slice(1));
  if (sub === "backup") return backupCommand(argv.slice(1));
  fail(`unknown db subcommand: ${sub ?? "(none)"} (have: stats, backup)`);
};
