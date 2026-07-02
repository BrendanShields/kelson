import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact } from "@kelson/schemas";
import { ulid } from "./ulid.ts";

export const hashContent = (content: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

export interface RegisterArtifact {
  repo: string;
  logical_id: string;
  type: Artifact["type"];
  content: string | Uint8Array;
  authority?: Artifact["authority"];
  tier?: Artifact["tier"];
  upstream?: string[];
}

// ART-1: registering (or re-registering) an artifact records the content hash
// of every declared upstream at link time. Links are replaced, not appended,
// so an artifact's recorded upstreams always reflect its latest declaration.
export const registerArtifact = (db: Database, a: RegisterArtifact): string => {
  const hash = hashContent(a.content);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.query(
      `INSERT INTO artifact (repo, logical_id, type, content_hash, authority, tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, logical_id) DO UPDATE SET
         type = excluded.type, content_hash = excluded.content_hash,
         authority = excluded.authority, tier = excluded.tier, updated_at = excluded.updated_at`,
    ).run(
      a.repo,
      a.logical_id,
      a.type,
      hash,
      a.authority ?? "authored",
      a.tier ?? "T0",
      now,
      now,
    );
    db.query("DELETE FROM trace_link WHERE repo = ? AND downstream_id = ?").run(
      a.repo,
      a.logical_id,
    );
    for (const up of a.upstream ?? []) {
      const upstream = db
        .query(
          "SELECT content_hash FROM artifact WHERE repo = ? AND logical_id = ?",
        )
        .get(a.repo, up) as { content_hash: string } | null;
      if (!upstream) throw new Error(`upstream artifact not registered: ${up}`);
      db.query(
        "INSERT INTO trace_link (id, repo, upstream_id, downstream_id, upstream_hash_at_link, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(ulid(), a.repo, up, a.logical_id, upstream.content_hash, now);
    }
  })();
  return hash;
};

// ART-2: a stale link is one whose recorded upstream hash no longer matches the
// upstream's current hash; the flagged set is every stale link's downstream plus
// everything transitively downstream of it (recursive CTE per ADR-0002).
export const staleDownstream = (db: Database, repo: string): string[] =>
  (
    db
      .query(
        `WITH RECURSIVE stale (id) AS (
           SELECT DISTINCT tl.downstream_id
             FROM trace_link tl
             JOIN artifact a ON a.repo = tl.repo AND a.logical_id = tl.upstream_id
            WHERE tl.repo = ?1 AND tl.upstream_hash_at_link <> a.content_hash
           UNION
           SELECT tl.downstream_id FROM trace_link tl
             JOIN stale s ON tl.repo = ?1 AND tl.upstream_id = s.id
         )
         SELECT id FROM stale ORDER BY id`,
      )
      .all(repo) as { id: string }[]
  ).map((r) => r.id);

export const detectStaleness = (db: Database, repo: string): string[] => {
  const flagged = staleDownstream(db, repo);
  const now = new Date().toISOString();
  for (const id of flagged) {
    const open = db
      .query(
        "SELECT 1 FROM drift_event WHERE repo = ? AND artifact_id = ? AND direction = 'upstream_stale' AND resolution = 'open'",
      )
      .get(repo, id);
    if (!open)
      db.query(
        "INSERT INTO drift_event (id, repo, artifact_id, direction, detected_at, schema_version) VALUES (?, ?, ?, 'upstream_stale', ?, 1)",
      ).run(ulid(), repo, id, now);
  }
  return flagged;
};

// ERD §1: the index is derived from files and rebuildable — re-hash every
// path-addressed artifact from disk; returns the logical_ids whose hash changed.
export const rehashFromDisk = (
  db: Database,
  repo: string,
  rootDir: string,
): string[] => {
  const rows = db
    .query(
      "SELECT logical_id, content_hash FROM artifact WHERE repo = ? AND logical_id NOT LIKE '%#%'",
    )
    .all(repo) as { logical_id: string; content_hash: string }[];
  const changed: string[] = [];
  const now = new Date().toISOString();
  for (const row of rows) {
    const hash = hashContent(readFileSync(join(rootDir, row.logical_id)));
    if (hash !== row.content_hash) {
      db.query(
        "UPDATE artifact SET content_hash = ?, updated_at = ? WHERE repo = ? AND logical_id = ?",
      ).run(hash, now, repo, row.logical_id);
      changed.push(row.logical_id);
    }
  }
  return changed;
};
