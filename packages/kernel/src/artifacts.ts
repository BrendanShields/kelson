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
         authority = excluded.authority, tier = excluded.tier,
         updated_at = CASE WHEN artifact.content_hash = excluded.content_hash
                           THEN artifact.updated_at ELSE excluded.updated_at END`,
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
        "INSERT INTO trace_link (id, repo, upstream_id, downstream_id, upstream_hash_at_link, downstream_hash_at_link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(ulid(), a.repo, up, a.logical_id, upstream.content_hash, hash, now);
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

// ART-3/ART-5: spec-code drift is evaluated per trace link against the hashes
// frozen on the link itself — never against the rebuildable index's current
// hash, which an index re-sync would silently move (divergence finding F-040).
// Events anchor on the link's downstream artifact in both directions.
export type HashSource = (logicalId: string) => string | null;

export const diskHashSource =
  (rootDir: string): HashSource =>
  (logicalId) => {
    try {
      return hashContent(readFileSync(join(rootDir, logicalId)));
    } catch {
      return null;
    }
  };

export interface DriftFinding {
  artifact_id: string;
  direction: "code_under_spec" | "spec_over_code";
}

export const detectDrift = (
  db: Database,
  repo: string,
  current: HashSource,
): DriftFinding[] => {
  const links = db
    .query(
      `SELECT tl.upstream_id, tl.downstream_id, tl.upstream_hash_at_link, tl.downstream_hash_at_link
         FROM trace_link tl
         JOIN artifact ua ON ua.repo = tl.repo AND ua.logical_id = tl.upstream_id
        WHERE tl.repo = ? AND ua.type = 'spec'`,
    )
    .all(repo) as {
    upstream_id: string;
    downstream_id: string;
    upstream_hash_at_link: string;
    downstream_hash_at_link: string | null;
  }[];
  const inserted: DriftFinding[] = [];
  const now = new Date().toISOString();
  for (const link of links) {
    const upMoved = current(link.upstream_id) !== link.upstream_hash_at_link;
    const downMoved =
      link.downstream_hash_at_link !== null &&
      current(link.downstream_id) !== link.downstream_hash_at_link;
    const directions: DriftFinding["direction"][] = [];
    if (downMoved) directions.push("code_under_spec");
    if (upMoved) directions.push("spec_over_code");
    for (const direction of directions) {
      const open = db
        .query(
          "SELECT 1 FROM drift_event WHERE repo = ? AND artifact_id = ? AND direction = ? AND resolution = 'open'",
        )
        .get(repo, link.downstream_id, direction);
      if (open) continue;
      db.query(
        "INSERT INTO drift_event (id, repo, artifact_id, direction, detected_at, schema_version) VALUES (?, ?, ?, ?, ?, 1)",
      ).run(ulid(), repo, link.downstream_id, direction, now);
      inserted.push({ artifact_id: link.downstream_id, direction });
    }
  }
  return inserted;
};

// ART-4: stale = the clause sits in the ART-2 stale set, or an open drift
// event exists on any of its links (either endpoint). Inferred clauses alert
// only; confirmed/authored block at T1+, warn at T0; a recorded override
// (drift events resolved as 'overridden') unblocks any case.
export interface StaleClause {
  clause_id: string;
  authority: string;
  tier: string;
}

export interface GateResult {
  action: "block" | "warn" | "proceed";
  stale: StaleClause[];
  alerts: string[];
  overridden: boolean;
}

export const buildGate = (
  db: Database,
  repo: string,
  clauseIds: string[],
  override?: { by: string; reason: string },
): GateResult => {
  if (clauseIds.length === 0)
    return { action: "proceed", stale: [], alerts: [], overridden: false };
  const marks = clauseIds.map(() => "?").join(", ");
  const drifted = db
    .query(
      `SELECT DISTINCT tl.upstream_id AS clause_id
         FROM drift_event de
         JOIN trace_link tl ON tl.repo = de.repo AND tl.downstream_id = de.artifact_id
        WHERE de.repo = ? AND de.resolution = 'open' AND tl.upstream_id IN (${marks})
       UNION
       SELECT artifact_id FROM drift_event
        WHERE repo = ? AND resolution = 'open' AND artifact_id IN (${marks})`,
    )
    .all(repo, ...clauseIds, repo, ...clauseIds) as { clause_id: string }[];
  const staleSet = new Set([
    ...drifted.map((r) => r.clause_id),
    ...staleDownstream(db, repo).filter((id) => clauseIds.includes(id)),
  ]);
  const stale: StaleClause[] = [...staleSet].sort().map((id) => {
    const row = db
      .query(
        "SELECT authority, tier FROM artifact WHERE repo = ? AND logical_id = ?",
      )
      .get(repo, id) as { authority: string; tier: string } | null;
    return {
      clause_id: id,
      authority: row?.authority ?? "authored",
      tier: row?.tier ?? "T0",
    };
  });

  const alerts = stale
    .filter((s) => s.authority === "inferred")
    .map((s) => `inferred clause ${s.clause_id} is stale (alert only, SPEC-7)`);
  const blocking = stale.filter(
    (s) => s.authority !== "inferred" && s.tier !== "T0",
  );
  const warning = stale.filter(
    (s) => s.authority !== "inferred" && s.tier === "T0",
  );

  if (blocking.length && override) {
    const now = new Date().toISOString();
    for (const s of [...blocking, ...warning])
      db.query(
        `UPDATE drift_event
            SET resolution = 'overridden', resolved_at = ?, resolved_by = ?, resolution_reason = ?
          WHERE repo = ? AND resolution = 'open' AND artifact_id IN (
            SELECT downstream_id FROM trace_link WHERE repo = ? AND upstream_id = ?
            UNION SELECT ?)`,
      ).run(
        now,
        override.by,
        override.reason,
        repo,
        repo,
        s.clause_id,
        s.clause_id,
      );
    return { action: "proceed", stale, alerts, overridden: true };
  }
  if (blocking.length)
    return { action: "block", stale, alerts, overridden: false };
  if (warning.length)
    return { action: "warn", stale, alerts, overridden: false };
  return { action: "proceed", stale, alerts, overridden: false };
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
