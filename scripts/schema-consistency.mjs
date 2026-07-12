#!/usr/bin/env node
// Two mechanically-checkable schema invariants, promoted from CLAUDE.md
// gotcha prose to a gate (2026-07-10):
//
// 1. Pairing — every `export const X = z…` in packages/schemas/src has
//    `export type X = z.infer<typeof X>` in the same file (TS2749 postmortem:
//    a value export without its type export is incomplete).
//
// 2. Enum↔CHECK — a Zod enum that mirrors a SQL `CHECK (col IN (...))` has a
//    second home the typechecker can't see (F-118: Executor gained 'api',
//    migration 0003's CHECK rejected it at runtime). The MANIFEST below pins
//    each effective CHECK column to its schema-side vocabulary; the gate
//    fails on any value-set mismatch, on an unmapped new CHECK, and on stale
//    manifest entries — so the mapping can't rot in either direction.
import { readFileSync, readdirSync } from "node:fs";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const errors = [];

// table.col -> exported enum name, or "ExportBlock.prop" for inline
// enums/literal-unions defined inside an object schema.
const MANIFEST = {
  "session.status": "SessionStatus",
  "task.state": "TaskState",
  "task.acceptance_signal": "AcceptanceSignal",
  "intervention_event.class": "InterventionClass",
  "artifact.type": "ArtifactType",
  "artifact.authority": "Authority",
  "artifact.tier": "Tier",
  "drift_event.direction": "DriftDirection",
  "drift_event.resolution": "DriftResolution",
  "verification_report.failure_class": "FailureClass",
  "eval_suite.role": "SuiteRole",
  "eval_task_result.side": "Side",
  "verdict.decision": "VerdictDecision",
  "proposal.state": "ProposalState",
  "proposal.created_by": "Proposal.created_by",
  "replay_record.validity": "ReplayValidity",
  "monitor_record.status": "MonitorStatus",
  "loop_event.kind": "LoopEvent.kind",
  "session_event.kind": "SessionEventKind",
  "step_event.sdlc_step": "SdlcStep",
  "step_event.effort": "Effort",
  "step_event.overrun": "BudgetOverrun",
  "eval_run.kind": "EvalRunKind",
  "eval_run.executor": "Executor",
  "bench_run.executor_candidate": "Executor",
  "bench_run.executor_baseline": "Executor",
  "routing_decision.kind": "RoutingDecision.kind",
  "routing_decision.matched_by": "RoutingDecision.matched_by",
  "budget_event.kind": "BudgetEvent.kind",
};
// CHECK columns with no schema-side vocabulary to compare against.
const IGNORE = {
  "benchmark_task.origin": "BenchmarkTask has no origin field in Zod; CHECK is the only home",
  "bench_task_result.agent": "runner writes literal strings; no Zod enum",
  "routing_outcome.outcome": "integer 0|1, not a string enum",
};

// ---- parse schemas: exports, exported enums, inline enum/literal props ----
const srcDir = `${root}/packages/schemas/src`;
const exportedEnums = new Map(); // name -> Set(values)
const inlineProps = new Map(); // "Block.prop" -> Set(values)
const splitValues = (s) =>
  s.split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

for (const f of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
  const ts = readFileSync(`${srcDir}/${f}`, "utf8");

  // invariant 1: value export <-> type export pairing.
  // INFER_EXEMPT: schemas whose type cannot be z.infer'd — a hand-written
  // `export type X = ...` is still REQUIRED, only the z.infer spelling is
  // waived, and each entry records why (the CHECK-exemption pattern above).
  const INFER_EXEMPT = {
    ChatWidget:
      "zod4 cannot z.infer a recursive discriminated union (TS2615) — hand-written type pinned by UX-28",
  };
  for (const m of ts.matchAll(/^export const (\w+) = z[.(]/gm)) {
    if (INFER_EXEMPT[m[1]]) {
      if (!new RegExp(`^export type ${m[1]} =`, "m").test(ts))
        errors.push(
          `${f}: INFER_EXEMPT ${m[1]} still requires a hand-written \`export type ${m[1]} = ...\``,
        );
    } else if (!ts.includes(`export type ${m[1]} = z.infer<typeof ${m[1]}>`))
      errors.push(
        `${f}: export const ${m[1]} has no paired \`export type ${m[1]} = z.infer<typeof ${m[1]}>\``,
      );
  }

  for (const m of ts.matchAll(/export const (\w+) = z\.enum\(\[([^\]]+)\]/g))
    exportedEnums.set(m[1], new Set(splitValues(m[2])));

  // inline vocab, keyed by enclosing export block
  const blocks = ts.split(/^(?=export const )/m);
  for (const block of blocks) {
    const name = block.match(/^export const (\w+)/)?.[1];
    if (!name) continue;
    for (const m of block.matchAll(/^\s+(\w+): z\.enum\(\[([^\]]+)\]/gm)) {
      const key = `${name}.${m[1]}`;
      inlineProps.set(key, new Set([...(inlineProps.get(key) ?? []), ...splitValues(m[2])]));
    }
    for (const m of block.matchAll(/^\s+(\w+): z\.literal\(["']([^"']+)["']\)/gm)) {
      const key = `${name}.${m[1]}`;
      inlineProps.set(key, new Set([...(inlineProps.get(key) ?? []), m[2]]));
    }
  }
}

// ---- parse migrations: effective CHECK sets per table.col ----
const migDir = `${root}/packages/kernel/migrations`;
const tables = new Map(); // table -> Map(col -> Set(values))
for (const f of readdirSync(migDir).sort()) {
  const sql = readFileSync(`${migDir}/${f}`, "utf8");
  for (const m of sql.matchAll(/^CREATE TABLE (\w+) \(([\s\S]*?)^\);/gm)) {
    const cols = new Map();
    for (const c of m[2].matchAll(/CHECK ?\((\w+) IN \(([^)]+)\)\)/g))
      cols.set(c[1], new Set(splitValues(c[2])));
    tables.set(m[1], cols);
  }
  for (const m of sql.matchAll(/^DROP TABLE (\w+);/gm)) tables.delete(m[1]);
  for (const m of sql.matchAll(/^ALTER TABLE (\w+) RENAME TO (\w+);/gm)) {
    tables.set(m[2], tables.get(m[1]) ?? new Map());
    tables.delete(m[1]);
  }
}

// ---- compare ----
const resolve = (target) =>
  exportedEnums.get(target) ?? inlineProps.get(target) ?? null;
const seen = new Set();
for (const [table, cols] of tables) {
  for (const [col, checkSet] of cols) {
    const key = `${table}.${col}`;
    seen.add(key);
    if (key in IGNORE) continue;
    const target = MANIFEST[key];
    if (!target) {
      errors.push(
        `unmapped CHECK ${key} [${[...checkSet].join(", ")}] — add it to MANIFEST (or IGNORE with a reason) in scripts/schema-consistency.mjs`,
      );
      continue;
    }
    const enumSet = resolve(target);
    if (!enumSet) {
      errors.push(`MANIFEST target ${target} for ${key} not found in packages/schemas/src`);
      continue;
    }
    if (enumSet.size !== checkSet.size || ![...enumSet].every((v) => checkSet.has(v))) {
      const onlyEnum = [...enumSet].filter((v) => !checkSet.has(v));
      const onlyCheck = [...checkSet].filter((v) => !enumSet.has(v));
      errors.push(
        `${key} != ${target}:${onlyEnum.length ? ` schema-only [${onlyEnum.join(", ")}] (widened enum needs a rebuild migration — F-118)` : ""}${onlyCheck.length ? ` CHECK-only [${onlyCheck.join(", ")}]` : ""}`,
      );
    }
  }
}
for (const key of [...Object.keys(MANIFEST), ...Object.keys(IGNORE)])
  if (!seen.has(key)) errors.push(`stale entry ${key} — no such CHECK in effective migrations`);

if (errors.length) {
  for (const e of errors) console.error(`schema-consistency: ${e}`);
  process.exit(1);
}
console.log(
  `schema-consistency: ok (${Object.keys(MANIFEST).length} enum/CHECK pairs, pairing checked)`,
);
