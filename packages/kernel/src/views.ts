import type { Database } from "bun:sqlite";
import type {
  UiEvalView,
  UiLoopView,
  UiTelemetryView,
  UiTraceView,
} from "@kelson/schemas";
import { readChangelog } from "./loop.ts";

// UX §8 view queries — the single data spine for `kelson ui`. Every function
// returns the shape of its Ui*View schema; the server validates (UX-11).
// UX-12: empty stores yield well-formed empty views with their verb.

export const telemetryView = (db: Database): UiTelemetryView => {
  const tiles = db
    .query(
      `SELECT COUNT(DISTINCT session_id) AS sessions_count,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd
       FROM step_event`,
    )
    .get() as {
    sessions_count: number;
    tokens_in: number;
    tokens_out: number;
    cost_micro_usd: number;
  };
  const models = db
    .query(
      "SELECT model, COUNT(*) AS steps FROM step_event GROUP BY model ORDER BY steps DESC",
    )
    .all() as { model: string; steps: number }[];
  const series = db
    .query(
      `SELECT substr(s.started_at, 1, 10) AS day,
              SUM(e.tokens_in + e.tokens_out) AS tokens,
              COALESCE(SUM(e.cost_micro_usd), 0) AS cost_micro_usd
       FROM step_event e JOIN session s ON s.id = e.session_id
       GROUP BY day ORDER BY day`,
    )
    .all() as { day: string; tokens: number; cost_micro_usd: number }[];
  const sessions = db
    .query(
      `SELECT s.id, s.repo, s.status, s.started_at, s.ended_at,
              COUNT(e.id) AS steps,
              COALESCE(SUM(e.tokens_in + e.tokens_out), 0) AS tokens,
              COALESCE(SUM(e.cost_micro_usd), 0) AS cost_micro_usd
       FROM session s LEFT JOIN step_event e ON e.session_id = s.id
       GROUP BY s.id ORDER BY s.rowid DESC LIMIT 100`,
    )
    .all() as UiTelemetryView["sessions"];
  return { empty_verb: "kelson init", ...tiles, models, series, sessions };
};

export const evalView = (db: Database): UiEvalView => {
  const rows = db
    .query(
      `SELECT r.id, r.kind, r.suite_id, r.suite_version, r.started_at,
              r.finished_at, v.decision, v.deltas, v.n
       FROM eval_run r LEFT JOIN verdict v ON v.run_id = r.id
       ORDER BY r.rowid DESC LIMIT 200`,
    )
    .all() as (Record<string, string | number | null> & {
    deltas: string | null;
  })[];
  return {
    empty_verb: "kelson eval ablate <pack> --suite <dir>",
    runs: rows.map((r) => {
      const deltas = r.deltas
        ? (JSON.parse(r.deltas) as {
            fpar: UiEvalView["runs"][number]["fpar_delta"];
            cost_pct: UiEvalView["runs"][number]["cost_delta_pct"];
          })
        : null;
      return {
        id: r.id as string,
        kind: r.kind as "ablate" | "compare" | "replay",
        suite_id: r.suite_id as string,
        suite_version: r.suite_version as string,
        started_at: r.started_at as string,
        finished_at: (r.finished_at as string | null) ?? null,
        decision:
          (r.decision as UiEvalView["runs"][number]["decision"]) ?? null,
        fpar_delta: deltas?.fpar ?? null,
        cost_delta_pct: deltas?.cost_pct ?? null,
        n: (r.n as number | null) ?? null,
      };
    }),
  };
};

export const loopView = (db: Database, changelogPath: string): UiLoopView => {
  const proposals = db
    .query(
      `SELECT id, target_pack, state, created_by, rationale, created_at, updated_at
       FROM proposal ORDER BY rowid`,
    )
    .all() as UiLoopView["proposals"];
  let changelog: UiLoopView["changelog"] = [];
  try {
    changelog = readChangelog(changelogPath);
  } catch {
    // missing changelog is the empty state, not an error (UX-12)
  }
  return { empty_verb: "kelson loop propose", proposals, changelog };
};

export const traceView = (db: Database): UiTraceView => {
  const nodes = db
    .query(
      `SELECT a.logical_id, a.type, a.authority, a.tier, a.content_hash,
              EXISTS(
                SELECT 1 FROM drift_event d
                WHERE d.artifact_id = a.logical_id AND d.resolution = 'open'
              ) AS drift_open
       FROM artifact a ORDER BY a.rowid`,
    )
    .all() as (Omit<UiTraceView["nodes"][number], "drift_open"> & {
    drift_open: 0 | 1;
  })[];
  const edges = db
    .query("SELECT upstream_id, downstream_id FROM trace_link ORDER BY rowid")
    .all() as UiTraceView["edges"];
  return {
    // `kelson index rebuild` (UX §3) is not dispatchable yet — point the
    // verb at onboarding, which installs the hooks that register artifacts
    empty_verb: "kelson init",
    nodes: nodes.map((n) => ({ ...n, drift_open: n.drift_open === 1 })),
    edges,
  };
};
