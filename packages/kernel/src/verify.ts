import type { Database } from "bun:sqlite";
import {
  type CheckStatus,
  type FailureClass,
  VerificationReport,
} from "@kelson/schemas";
import { detectDrift, detectStaleness, type HashSource } from "./artifacts.ts";
import { ulid } from "./ulid.ts";

export interface ObligationCheck {
  clause_id: string;
  run: () => boolean | { ok: boolean; detail?: string };
}

export interface VerifyOptions {
  repo: string;
  task_id: string;
  obligations: ObligationCheck[];
  runTests: () => { status: CheckStatus; detail: string | null };
  // Drift checks are skipped (not passed) without a hash source — a verify
  // that can't see the working tree must say so, not report green.
  hashSource?: HashSource;
  // PIPE-9 classification. Absent (PIPE-8 callers) => failure_class stays
  // null; AGT-9 opts in to classify obligation- vs code-defects.
  classify?: (results: VerificationReport["results"]) => FailureClass | null;
}

// PIPE-8: obligations for touched clauses, conventional tests, drift checks,
// budget conformance — one structured report row per run. Budget conformance
// is emitted as "skipped" until routed budgets exist (Phase 3).
export const runVerify = (
  db: Database,
  opts: VerifyOptions,
): VerificationReport => {
  const obligations = opts.obligations.map((o) => {
    try {
      const out = o.run();
      const ok = typeof out === "boolean" ? out : out.ok;
      const detail = typeof out === "boolean" ? null : (out.detail ?? null);
      return {
        clause_id: o.clause_id,
        status: (ok ? "passed" : "failed") as CheckStatus,
        detail,
      };
    } catch (e) {
      return {
        clause_id: o.clause_id,
        status: "failed" as CheckStatus,
        detail: (e as Error).message,
      };
    }
  });

  let tests: { status: CheckStatus; detail: string | null };
  try {
    tests = opts.runTests();
  } catch (e) {
    tests = { status: "failed", detail: (e as Error).message };
  }

  let drift: { status: CheckStatus; open_events: number };
  if (opts.hashSource) {
    detectStaleness(db, opts.repo);
    detectDrift(db, opts.repo, opts.hashSource);
    const open = (
      db
        .query(
          "SELECT COUNT(*) AS n FROM drift_event WHERE repo = ? AND resolution = 'open'",
        )
        .get(opts.repo) as { n: number }
    ).n;
    drift = { status: open > 0 ? "failed" : "passed", open_events: open };
  } else {
    drift = { status: "skipped", open_events: 0 };
  }

  const results = {
    obligations,
    tests,
    drift,
    budget: {
      status: "skipped" as CheckStatus,
      detail: "routed budgets land in Phase 3",
    },
  };
  const report = VerificationReport.parse({
    id: ulid(),
    task_id: opts.task_id,
    results,
    failure_class: opts.classify ? opts.classify(results) : null,
    at: new Date().toISOString(),
    schema_version: 1,
  });
  db.query(
    "INSERT INTO verification_report (id, task_id, results, failure_class, at, schema_version) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    report.id,
    report.task_id,
    JSON.stringify(report.results),
    report.failure_class,
    report.at,
    report.schema_version,
  );
  return report;
};

export const verifyPassed = (report: VerificationReport): boolean =>
  report.results.obligations.every((o) => o.status !== "failed") &&
  report.results.tests.status !== "failed" &&
  report.results.drift.status !== "failed" &&
  report.results.budget.status !== "failed";
