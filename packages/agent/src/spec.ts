import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildGate, hashContent, runVerify } from "@kelson/kernel";
import type { SessionEvent, VerificationReport } from "@kelson/schemas";

// AGT-7/8: the loop's view of which files a spec clause governs and where its
// obligation test lives. Built once per session from the kernel artifact
// store (trace links) + the repo's obligation-test convention. When the
// store has no trace links, the context is `empty` and every spec-native
// guard is inert (Phases 6–7 behavior).
export interface SpecContext {
  repo: string;
  empty: boolean;
  // absolute governed path -> governing clause ids
  clausesByFile: Map<string, string[]>;
  // clause id -> its governed absolute paths, sorted (cache-key input)
  filesByClause: Map<string, string[]>;
  // clause id -> obligation-test absolute path, or null if unresolved
  obligationPath: Map<string, string | null>;
  // absolute path -> artifact tier (for the spec-less-T1 gate), or null
  tierByFile: Map<string, string>;
  // clause id -> authority (authored|inferred|confirmed)
  authorityByClause: Map<string, string>;
}

// Conventional obligation-test location (obligation-test skill): the first
// packages/*/test/obligations/<CLAUSE-ID>.test.ts that exists.
const resolveObligation = (repo: string, clauseId: string): string | null => {
  const glob = new Bun.Glob(`packages/*/test/obligations/${clauseId}.test.ts`);
  for (const rel of glob.scanSync({ cwd: repo })) return join(repo, rel);
  return null;
};

export const loadSpecContext = (db: Database, repo: string): SpecContext => {
  // downstream_id = governed code path; upstream_id = clause id.
  const links = db
    .query(
      "SELECT upstream_id AS clause, downstream_id AS path FROM trace_link WHERE repo = ?",
    )
    .all(repo) as { clause: string; path: string }[];

  const clausesByFile = new Map<string, string[]>();
  const filesByClause = new Map<string, string[]>();
  for (const { clause, path } of links) {
    const abs = join(repo, path);
    (clausesByFile.get(abs) ?? clausesByFile.set(abs, []).get(abs)!).push(
      clause,
    );
    (
      filesByClause.get(clause) ?? filesByClause.set(clause, []).get(clause)!
    ).push(abs);
  }
  for (const paths of filesByClause.values()) paths.sort();

  const obligationPath = new Map<string, string | null>();
  const authorityByClause = new Map<string, string>();
  for (const clause of filesByClause.keys()) {
    obligationPath.set(clause, resolveObligation(repo, clause));
    const row = db
      .query("SELECT authority FROM artifact WHERE repo = ? AND logical_id = ?")
      .get(repo, clause) as { authority: string } | null;
    authorityByClause.set(clause, row?.authority ?? "authored");
  }

  const tierByFile = new Map<string, string>();
  for (const abs of clausesByFile.keys()) {
    const rel = relative(repo, abs);
    const row = db
      .query("SELECT tier FROM artifact WHERE repo = ? AND logical_id = ?")
      .get(repo, rel) as { tier: string } | null;
    if (row) tierByFile.set(abs, row.tier);
  }

  return {
    repo,
    empty: links.length === 0,
    clausesByFile,
    filesByClause,
    obligationPath,
    tierByFile,
    authorityByClause,
  };
};

// SHA-256 over the concatenation of a clause's governed files in canonical
// path order (AGT-7 cache key). A missing file contributes "\0" so a delete
// still changes the hash.
export const governedFilesHash = (
  spec: SpecContext,
  clauseId: string,
): string => {
  const paths = spec.filesByClause.get(clauseId) ?? [];
  const parts = paths.map((p) =>
    existsSync(p) ? readFileSync(p, "utf8") : "\0",
  );
  return hashContent(`${clauseId}\n${parts.join("\0")}`);
};

// The clauses governing any of the given absolute paths (this step's touched
// set).
export const touchedClauses = (
  spec: SpecContext,
  modifiedPaths: string[],
): string[] => {
  const out = new Set<string>();
  for (const p of modifiedPaths)
    for (const clause of spec.clausesByFile.get(p) ?? []) out.add(clause);
  return [...out];
};

export interface ObligationResult {
  clause_id: string;
  files_hash: string;
  status: "pass" | "fail";
  obligation_path: string | null;
}

// AGT-7: read the session chain's obligation_check payloads. The cache and
// the accumulated touched set both derive from these events — nothing in
// memory (append-only-store native).
export const obligationChecks = (chain: SessionEvent[]): ObligationResult[] =>
  chain
    .filter((e) => e.kind === "session_meta" && e.payload.obligation_check)
    .map((e) => e.payload.obligation_check as unknown as ObligationResult);

// Cache lookup: has this exact (clause, files-hash) already been recorded?
export const cachedStatus = (
  checks: ObligationResult[],
  clauseId: string,
  filesHash: string,
): "pass" | "fail" | null => {
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i];
    if (c && c.clause_id === clauseId && c.files_hash === filesHash)
      return c.status;
  }
  return null;
};

// AGT-7 done-gate: the session-accumulated touched clauses whose obligation
// at the CURRENT governed-file hash is failing. Evaluated on every step; the
// lookup is always a hit because a governed file only changes via a tool call
// that ran the obligation.
export const failingClauses = (
  spec: SpecContext,
  chain: SessionEvent[],
): string[] => {
  const checks = obligationChecks(chain);
  const accumulated = new Set(checks.map((c) => c.clause_id));
  const failing: string[] = [];
  for (const clause of accumulated) {
    const status = cachedStatus(
      checks,
      clause,
      governedFilesHash(spec, clause),
    );
    if (status === "fail") failing.push(clause);
  }
  return failing.sort();
};

// AGT-9: at session end, project the chain's obligation results into a
// VerificationReport (deterministic — no re-run, no LLM auditor). Obligations
// report their current-hash status; tests/drift/budget are skipped in the
// native loop (the obligations ARE the spec check); failure_class is
// classified per PIPE-9. An empty SpecContext yields an empty obligations
// array and null failure class.
export const emitVerificationReport = (
  db: Database,
  spec: SpecContext,
  taskId: string,
  chain: SessionEvent[],
): VerificationReport => {
  const checks = obligationChecks(chain);
  const accumulated = [...new Set(checks.map((c) => c.clause_id))].sort();
  const failing = new Set(failingClauses(spec, chain));
  return runVerify(db, {
    repo: spec.repo,
    task_id: taskId,
    obligations: accumulated.map((clause) => ({
      clause_id: clause,
      run: () => ({
        ok: !failing.has(clause),
        detail: failing.has(clause) ? "obligation failing at current hash" : "",
      }),
    })),
    // The obligations are the native loop's spec check; the full repo suite is
    // not re-run at session end (deferred — noted).
    runTests: () => ({
      status: "skipped",
      detail: "native loop uses per-clause obligations",
    }),
    classify: (results) => {
      const obligationFailed = results.obligations.some(
        (o) => o.status === "failed",
      );
      const testsFailed = results.tests.status === "failed";
      if (!obligationFailed && !testsFailed) return null;
      // AGT-9: obligation_defect only when *only* obligations failed; if tests
      // also failed it's a code_defect.
      return obligationFailed && !testsFailed
        ? "obligation_defect"
        : "code_defect";
    },
  });
};

export interface GateDecision {
  action: "block" | "warn" | "proceed";
  reason: string | null;
}

// AGT-8: the ART-4 write gate. Governing non-inferred clauses go through the
// kernel buildGate (stale => block at T1+, warn at T0, inferred alert-only);
// a governed file at T1+ with no non-inferred clause blocks (spec-first).
export const gateWrite = (
  db: Database,
  spec: SpecContext,
  absPath: string,
  override?: { by: string; reason: string },
): GateDecision => {
  if (spec.empty) return { action: "proceed", reason: null };
  const governing = spec.clausesByFile.get(absPath) ?? [];
  const nonInferred = governing.filter(
    (c) => spec.authorityByClause.get(c) !== "inferred",
  );

  if (nonInferred.length > 0) {
    const gate = buildGate(db, spec.repo, nonInferred, override);
    if (gate.action === "block")
      return {
        action: "block",
        reason: `stale governing clause(s) ${gate.stale
          .map((s) => s.clause_id)
          .join(", ")} — route to spec repair (ART-4)`,
      };
    return {
      action: gate.action === "warn" ? "warn" : "proceed",
      reason: null,
    };
  }

  // Governed area (has a trace link) but no non-inferred clause: spec-first
  // blocks a behavior edit at T1+ unless overridden.
  const tier = spec.tierByFile.get(absPath);
  if ((tier === "T1" || tier === "T2") && !override)
    return {
      action: "block",
      reason: `${relative(spec.repo, absPath)} is a T1+ governed file with no non-inferred clause — write a clause first (spec-first, ART-4)`,
    };
  return { action: "proceed", reason: null };
};
