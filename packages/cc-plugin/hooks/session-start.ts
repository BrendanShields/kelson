// SessionStart → open the store, begin a kernel session pinned to the current
// lockfile hash, remember the mapping for session-end.
// KERN-1: telemetry must never break the session — everything (imports
// included, which fail on a fresh clone before `bun install`) stays inside
// the try; always exit 0.
try {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { openDb } = await import("@kelson/kernel");
  const { beginSession } = await import("../src/session.ts");

  const input = JSON.parse(await Bun.stdin.text()) as { session_id?: string };
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const db = openDb(join(root, ".kelson", "kelson.db"));
  const id = beginSession(db, root);
  db.close();
  // EVP §4: content-addressed session snapshot + environment manifest, the
  // raw material for counterfactual replay (EVAL-5). Committed state only;
  // working-tree diff capture is a recorded gap.
  const { storeSnapshot, DEFAULT_SNAPSHOT_DIR, hashLockfile } = await import(
    "@kelson/kernel"
  );
  const { readFileSync, existsSync } = await import("node:fs");
  const snapshot = storeSnapshot(root, DEFAULT_SNAPSHOT_DIR);
  const lockPath = join(root, "kelson.lock");
  // Model IDs are unknown at session start — a recorded manifest gap until
  // session-end enrichment lands.
  writeFileSync(
    join(
      DEFAULT_SNAPSHOT_DIR,
      `${snapshot.replace("sha256:", "")}.session.json`,
    ),
    JSON.stringify({
      kelson_session_id: id,
      snapshot,
      lockfile_hash: existsSync(lockPath)
        ? hashLockfile(JSON.parse(readFileSync(lockPath, "utf8")))
        : null,
      kelson_version: "0.1.0",
      models: [],
      bun: Bun.version,
      os: process.platform,
      at: new Date().toISOString(),
    }),
  );
  if (input.session_id) {
    const runtime = join(root, ".kelson", "runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, `session-${input.session_id}`), id);
  }
} catch {
  /* KERN-1 */
}
process.exit(0);
