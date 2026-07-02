import type { Database } from "bun:sqlite";
import type { ChangelogEntry, MonitorRecord } from "@kelson/schemas";
import { hashContent } from "./artifacts.ts";
import {
  type ApplyContext,
  lockfileContains,
  loopEvent,
  revertProposal,
  transition,
} from "./loop.ts";
import { mulberry32 } from "./stats.ts";

// LOOP-9 defaults; both divergence readers independently invented min 8.
export const MONITOR_DEFAULTS = {
  windowDays: 14,
  windowSessions: 30,
  minSessions: 8,
  fparDropPp: 0.05,
  tpacRisePct: 0.1,
  alpha: 0.05,
  resamples: 10_000,
} as const;

export interface SessionMetrics {
  fpar: number | null;
  tpac: number | null;
}

export type MetricsProvider = (sessionId: string) => SessionMetrics;

interface SessionRow {
  id: string;
  lockfile_hash: string;
  started_at: string;
}

const completeSessions = (db: Database): SessionRow[] =>
  db
    .query(
      "SELECT id, lockfile_hash, started_at FROM session WHERE status = 'complete' ORDER BY rowid",
    )
    .all() as SessionRow[];

const readMonitor = (db: Database, proposalId: string): MonitorRecord => {
  const row = db
    .query("SELECT * FROM monitor_record WHERE proposal_id = ?")
    .get(proposalId) as Record<string, unknown> | null;
  if (!row) throw new Error(`no monitor for proposal ${proposalId}`);
  return {
    ...(row as object),
    baseline_session_ids: JSON.parse(row.baseline_session_ids as string),
    baseline_insufficient: row.baseline_insufficient === 1,
    stalled_notified: row.stalled_notified === 1,
  } as MonitorRecord;
};

// LOOP-9: baseline = last 30 pre-apply sessions whose lockfile neither
// contains this diff nor any then-quarantined diff; frozen by id at apply.
export const openMonitor = (
  db: Database,
  proposalId: string,
  args: {
    appliedAt: string;
    lockfileAfter: string;
    changelog: ChangelogEntry[];
  },
): MonitorRecord => {
  const quarantinedIds = (
    db.query("SELECT id FROM proposal WHERE state = 'quarantined'").all() as {
      id: string;
    }[]
  ).map((r) => r.id);
  const baseline = completeSessions(db)
    .filter(
      (s) =>
        s.started_at < args.appliedAt &&
        !lockfileContains(args.changelog, s.lockfile_hash, proposalId) &&
        !quarantinedIds.some((q) =>
          lockfileContains(args.changelog, s.lockfile_hash, q),
        ),
    )
    .slice(-MONITOR_DEFAULTS.windowSessions);
  // I2 checked BEFORE any write; insert + transition are atomic so a refusal
  // never orphans an open monitor row or a mutated state.
  const open = db
    .query(
      "SELECT COUNT(*) AS n FROM monitor_record WHERE status = 'open' AND proposal_id != ?",
    )
    .get(proposalId) as { n: number };
  if (open.n >= 3)
    throw new Error(
      "monitoring cap 3 reached (I2) — close a window before applying more",
    );
  const record: MonitorRecord = {
    proposal_id: proposalId,
    applied_at: args.appliedAt,
    lockfile_after: args.lockfileAfter,
    baseline_session_ids: baseline.map((s) => s.id),
    baseline_insufficient: baseline.length < MONITOR_DEFAULTS.minSessions,
    status: "open",
    check_seq: 0,
    stalled_notified: false,
    closed_at: null,
    schema_version: 1,
  };
  db.transaction(() => {
    db.query(
      `INSERT INTO monitor_record (proposal_id, applied_at, lockfile_after, baseline_session_ids, baseline_insufficient, status, check_seq, stalled_notified, closed_at, schema_version)
       VALUES (?, ?, ?, ?, ?, 'open', 0, 0, NULL, 1)`,
    ).run(
      record.proposal_id,
      record.applied_at,
      record.lockfile_after,
      JSON.stringify(record.baseline_session_ids),
      record.baseline_insufficient ? 1 : 0,
    );
    loopEvent(db, "monitor_opened", proposalId, {
      baseline_n: baseline.length,
      baseline_insufficient: record.baseline_insufficient,
    });
    transition(db, proposalId, "monitoring", { actor: "auto" });
  })();
  return record;
};

// LOOP-9: unpaired pooled-null bootstrap — resample both groups from the
// pooled data at the original sizes; one-sided p; seeded so checks replay.
export const pooledNullBootstrap = (
  post: number[],
  base: number[],
  direction: "decrease" | "increase",
  seed: number,
  resamples: number = MONITOR_DEFAULTS.resamples,
): { delta: number; p: number } => {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const observed = mean(post) - mean(base);
  const pool = [...post, ...base];
  const rand = mulberry32(seed);
  const draw = (n: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++)
      sum += pool[Math.floor(rand() * pool.length)] as number;
    return sum / n;
  };
  let extreme = 0;
  for (let b = 0; b < resamples; b++) {
    const d = draw(post.length) - draw(base.length);
    if (direction === "decrease" ? d <= observed : d >= observed) extreme++;
  }
  return { delta: observed, p: (1 + extreme) / (resamples + 1) };
};

const checkSeed = (proposalId: string, checkSeq: number): number =>
  Number.parseInt(hashContent(`${proposalId}:${checkSeq}`).slice(7, 15), 16);

export interface CheckOutcome {
  status: "skipped" | "clean" | "regression" | "closed" | "stalled";
  detail?: Record<string, unknown>;
}

export interface CheckContext {
  now: string;
  changelog: ChangelogEntry[];
  metrics: MetricsProvider;
}

const postSessionsFor = (
  db: Database,
  monitor: MonitorRecord,
  changelog: ChangelogEntry[],
): SessionRow[] => {
  // Fresh re-measure after a co-monitored revert: only sessions started after
  // the latest revert that postdates this monitor's apply count (LOOP-9).
  const lastRevert = changelog
    .filter((e) => e.action === "revert" && e.at > monitor.applied_at)
    .map((e) => e.at)
    .sort()
    .at(-1);
  const floor = lastRevert ?? monitor.applied_at;
  return completeSessions(db).filter(
    (s) =>
      s.started_at >= floor &&
      lockfileContains(changelog, s.lockfile_hash, monitor.proposal_id) &&
      !monitor.baseline_session_ids.includes(s.id),
  );
};

export const checkMonitor = (
  db: Database,
  proposalId: string,
  ctx: CheckContext,
): CheckOutcome => {
  const monitor = readMonitor(db, proposalId);
  if (monitor.status !== "open") return { status: "closed" };
  const post = postSessionsFor(db, monitor, ctx.changelog);
  const elapsedDays =
    (Date.parse(ctx.now) - Date.parse(monitor.applied_at)) / 86_400_000;

  if (post.length === 0 && elapsedDays >= MONITOR_DEFAULTS.windowDays) {
    if (!monitor.stalled_notified) {
      db.query(
        "UPDATE monitor_record SET stalled_notified = 1 WHERE proposal_id = ?",
      ).run(proposalId);
      loopEvent(db, "monitor_stalled", proposalId, { post_n: 0, elapsedDays });
    }
    return { status: "stalled" };
  }

  const gather = (ids: string[], pick: (m: SessionMetrics) => number | null) =>
    ids
      .map((id) => pick(ctx.metrics(id)))
      .filter((v): v is number => v !== null);
  const postF = gather(
    post.map((s) => s.id),
    (m) => m.fpar,
  );
  const baseF = gather(monitor.baseline_session_ids, (m) => m.fpar);
  const postT = gather(
    post.map((s) => s.id),
    (m) => m.tpac,
  );
  const baseT = gather(monitor.baseline_session_ids, (m) => m.tpac);

  const min = MONITOR_DEFAULTS.minSessions;
  if (
    monitor.baseline_insufficient ||
    (postF.length < min && postT.length < min)
  ) {
    loopEvent(db, "monitor_check_skipped", proposalId, {
      post_n: post.length,
      reason: monitor.baseline_insufficient
        ? "insufficient_baseline"
        : "insufficient_post_sessions",
    });
    return { status: "skipped" };
  }

  const checkSeq = monitor.check_seq + 1;
  db.query("UPDATE monitor_record SET check_seq = ? WHERE proposal_id = ?").run(
    checkSeq,
    proposalId,
  );
  const seed = checkSeed(proposalId, checkSeq);

  let regression: Record<string, unknown> | null = null;
  let fparResult: { delta: number; p: number } | null = null;
  let tpacResult: { delta: number; p: number } | null = null;
  if (postF.length >= min && baseF.length >= min) {
    fparResult = pooledNullBootstrap(postF, baseF, "decrease", seed);
    if (
      fparResult.delta <= -MONITOR_DEFAULTS.fparDropPp &&
      fparResult.p < MONITOR_DEFAULTS.alpha
    )
      regression = { metric: "fpar", ...fparResult };
  }
  if (!regression && postT.length >= min && baseT.length >= min) {
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    tpacResult = pooledNullBootstrap(postT, baseT, "increase", seed + 1);
    const rel = mean(baseT) === 0 ? 0 : tpacResult.delta / mean(baseT);
    if (
      rel >= MONITOR_DEFAULTS.tpacRisePct &&
      tpacResult.p < MONITOR_DEFAULTS.alpha
    )
      regression = { metric: "tpac", relative: rel, ...tpacResult };
  }

  loopEvent(db, "monitor_check", proposalId, {
    check_seq: checkSeq,
    seed,
    post_n: post.length,
    fpar: fparResult,
    tpac: tpacResult,
  });

  if (regression) {
    loopEvent(db, "regression_detected", proposalId, {
      ...regression,
      check_seq: checkSeq,
      post_n: post.length,
    });
    return { status: "regression", detail: regression };
  }

  // Conjunctive closure: both arms met, the bound-meeting session included.
  if (
    elapsedDays >= MONITOR_DEFAULTS.windowDays &&
    post.length >= MONITOR_DEFAULTS.windowSessions
  ) {
    db.query(
      "UPDATE monitor_record SET status = 'cleared', closed_at = ? WHERE proposal_id = ?",
    ).run(ctx.now, proposalId);
    loopEvent(db, "monitor_closed", proposalId, {
      disposition: "cleared",
      post_n: post.length,
      elapsedDays,
    });
    transition(db, proposalId, "stable", { actor: "auto" });
    return { status: "closed" };
  }
  return { status: "clean" };
};

// LOOP-9 attribution: inter-apply stratum isolation; exactly one implicated
// diff is reverted; both/neither/starved → indistinguishable → revert the
// last-applied only. One revert per sweep, never two.
export const monitorSweep = (
  db: Database,
  ctx: CheckContext & { applyCtx: ApplyContext },
): { reverted: string | null } => {
  const open = (
    db
      .query(
        "SELECT proposal_id, applied_at FROM monitor_record WHERE status = 'open' ORDER BY applied_at",
      )
      .all() as { proposal_id: string; applied_at: string }[]
  ).map((r) => r.proposal_id);

  const checkResults = new Map(
    open.map((id) => [id, checkMonitor(db, id, ctx)] as const),
  );
  const triggered = open.filter(
    (id) => checkResults.get(id)?.status === "regression",
  );
  if (triggered.length === 0) return { reverted: null };

  let culprit: string;
  if (triggered.length === 1) culprit = triggered[0] as string;
  else {
    // Two-suspect isolation (A applied before B).
    const [a, b] = triggered.slice(-2) as [string, string];
    const monA = readMonitor(db, a);
    const monB = readMonitor(db, b);
    const stratum = completeSessions(db).filter(
      (s) =>
        lockfileContains(ctx.changelog, s.lockfile_hash, a) &&
        !lockfileContains(ctx.changelog, s.lockfile_hash, b) &&
        !monA.baseline_session_ids.includes(s.id),
    );
    // §9.2.1: isolate on the metric family that triggered.
    const bOutcome = checkResults.get(b);
    const metric = (bOutcome?.detail?.metric as "fpar" | "tpac") ?? "fpar";
    const direction = "decrease" as const;
    const gather = (ids: string[]) =>
      ids
        .map((id) => ctx.metrics(id)[metric])
        .filter((v): v is number => v !== null);
    const stratumF = gather(stratum.map((s) => s.id));
    if (stratumF.length < MONITOR_DEFAULTS.minSessions) {
      culprit = b; // starved stratum → indistinguishable → last-applied
    } else {
      const baseF = gather(monA.baseline_session_ids);
      const postB = gather(
        postSessionsFor(db, monB, ctx.changelog).map((s) => s.id),
      );
      const seed = checkSeed(`${a}|${b}`, 1);
      const isoDirection = metric === "tpac" ? "increase" : direction;
      const aIso = pooledNullBootstrap(stratumF, baseF, isoDirection, seed);
      const bIso = pooledNullBootstrap(postB, stratumF, isoDirection, seed + 1);
      const implicated = (r: { delta: number; p: number }) =>
        metric === "tpac"
          ? r.delta > 0 && r.p < MONITOR_DEFAULTS.alpha
          : r.delta <= -MONITOR_DEFAULTS.fparDropPp &&
            r.p < MONITOR_DEFAULTS.alpha;
      const aImplicated = implicated(aIso);
      const bImplicated = implicated(bIso);
      culprit = aImplicated && !bImplicated ? a : b;
    }
  }

  revertProposal(db, culprit, ctx.applyCtx, {
    actor: "auto",
    reason: "LOOP-3 regression auto-revert",
  });
  db.query(
    "UPDATE monitor_record SET status = 'reverted', closed_at = ? WHERE proposal_id = ?",
  ).run(ctx.now, culprit);
  loopEvent(db, "monitor_closed", culprit, { disposition: "reverted" });
  return { reverted: culprit };
};
