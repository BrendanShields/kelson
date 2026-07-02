import type { Database } from "bun:sqlite";

export interface InferredClauseDraft {
  id: string;
  ears: "ubiquitous" | "event" | "state" | "unwanted" | "optional";
  trigger?: string;
  text: string;
  inputs?: Record<string, string>;
  observe?: string[];
  check: string;
  evidence: string[]; // code paths the clause was inferred from (SPEC-7)
}

// SPEC-7: excavation emits kelspec with authority: inferred — drift
// detectors, never build blockers, until a human promotes them. Evidence
// paths ride as prose next to each block (prose is never load-bearing,
// DSL-1), and as registered trace-link upstreams at ingest.
export const inferredSpecMarkdown = (args: {
  componentId: string;
  events: string[];
  clauses: InferredClauseDraft[];
}): string => {
  const blocks = args.clauses
    .map((c) => {
      const clause: Record<string, unknown> = {
        kind: "clause",
        id: c.id,
        ears: c.ears,
        ...(c.trigger ? { trigger: c.trigger } : {}),
        text: c.text,
        ...(c.inputs ? { inputs: c.inputs } : {}),
        ...(c.observe ? { observe: c.observe } : {}),
        check: c.check,
      };
      return `Inferred from: ${c.evidence.map((e) => `\`${e}\``).join(", ")}\n\n\`\`\`kelspec\n${JSON.stringify(clause, null, 2)}\n\`\`\``;
    })
    .join("\n\n");
  const component = {
    kind: "component",
    id: args.componentId,
    tier: "T0",
    authority: "inferred",
    events: args.events,
  };
  return `# Kelspec: ${args.componentId} (excavated)\n\nEmitted by excavation with \`authority: inferred\` (SPEC-7): every clause below is a drift detector, not a build blocker, until a human promotes it.\n\n\`\`\`kelspec\n${JSON.stringify(component, null, 2)}\n\`\`\`\n\n${blocks}\n`;
};

export interface PromotionCandidate {
  logical_id: string;
  sessions_survived: number;
}

// SPEC-8: an inferred clause that survives N sessions (default 20) without
// violation or human edit queues for one-click batched promotion.
export const promotionQueue = (
  db: Database,
  repo: string,
  minSessions = 20,
): PromotionCandidate[] => {
  const inferred = db
    .query(
      "SELECT logical_id, updated_at FROM artifact WHERE repo = ? AND authority = 'inferred' AND type = 'spec'",
    )
    .all(repo) as { logical_id: string; updated_at: string }[];
  const candidates: PromotionCandidate[] = [];
  for (const artifact of inferred) {
    // "Without human edit": the artifact hash is untouched since ingestion —
    // updated_at moves on any re-registration with different content.
    const survived = (
      db
        .query(
          "SELECT COUNT(*) AS n FROM session WHERE repo = ? AND status = 'complete' AND started_at > ?",
        )
        .get(repo, artifact.updated_at) as { n: number }
    ).n;
    // "Without violation": no drift event (open or resolved) anchored on the
    // clause's downstream links since ingestion.
    const violations = (
      db
        .query(
          `SELECT COUNT(*) AS n FROM drift_event de
             JOIN trace_link tl ON tl.repo = de.repo AND tl.downstream_id = de.artifact_id
            WHERE de.repo = ? AND tl.upstream_id = ? AND de.detected_at > ?`,
        )
        .get(repo, artifact.logical_id, artifact.updated_at) as { n: number }
    ).n;
    if (survived >= minSessions && violations === 0)
      candidates.push({
        logical_id: artifact.logical_id,
        sessions_survived: survived,
      });
  }
  return candidates.sort((a, b) => b.sessions_survived - a.sessions_survived);
};

// One-click batched promotion: inferred → confirmed (a human action; the
// promoted clauses start blocking per ART-4 from the next build gate).
export const promoteInferred = (
  db: Database,
  repo: string,
  logicalIds: string[],
): void => {
  const now = new Date().toISOString();
  for (const id of logicalIds)
    db.query(
      "UPDATE artifact SET authority = 'confirmed', updated_at = ? WHERE repo = ? AND logical_id = ? AND authority = 'inferred'",
    ).run(now, repo, id);
};
