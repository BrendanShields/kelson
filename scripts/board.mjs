#!/usr/bin/env bun
// Owns .kelson/tasks.json and .kelson/findings.json edits: validates shape,
// stamps timestamps, auto-numbers finding IDs. Hand-editing these files is
// how keys drift (postmortem lesson: 6 ad-hoc heredocs in one session).
//
//   bun scripts/board.mjs task <id> <open|in_progress|completed> [--note "..."] [--clauses TEL-1,ART-2]
//   bun scripts/board.mjs finding '<json>'     # id/status/fix_commit optional; id auto-numbers
import { readFileSync, writeFileSync } from "node:fs";

const TASKS = ".kelson/tasks.json";
const FINDINGS = ".kelson/findings.json";
const TASK_STATES = ["open", "in_progress", "completed"];
const FINDING_KEYS = [
  "id",
  "task",
  "source",
  "severity",
  "clauses",
  "summary",
  "root_cause",
  "fix",
  "fix_commit",
  "status",
];

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const save = (p, d) => writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
const die = (msg) => {
  console.error(`board: ${msg}`);
  process.exit(1);
};

const [mode, ...rest] = process.argv.slice(2);

if (mode === "task") {
  const [id, state] = rest;
  if (!TASK_STATES.includes(state))
    die(`state must be one of ${TASK_STATES.join("|")}`);
  const d = load(TASKS);
  const task = d.tasks.find((t) => t.id === id);
  if (!task) die(`unknown task ${id} (have: ${d.tasks.map((t) => t.id).join(", ")})`);
  task.state = state;
  task.completed_at =
    state === "completed"
      ? `${new Date().toISOString().slice(0, 19)}Z`
      : null;
  const noteIdx = rest.indexOf("--note");
  if (noteIdx !== -1) task.notes = rest[noteIdx + 1];
  const clausesIdx = rest.indexOf("--clauses");
  if (clausesIdx !== -1) task.clauses = rest[clausesIdx + 1].split(",");
  save(TASKS, d);
  console.log(`${id} -> ${state}`);
} else if (mode === "finding") {
  const d = load(FINDINGS);
  const row = JSON.parse(rest[0] ?? die("finding requires a JSON argument"));
  const taxonomy = d.root_cause_taxonomy ?? [];
  if (taxonomy.length && !taxonomy.includes(row.root_cause))
    die(`root_cause must be one of: ${taxonomy.join(", ")}`);
  if (!["violation", "warning"].includes(row.severity))
    die("severity must be violation|warning");
  const next =
    Math.max(...d.findings.map((f) => Number(f.id.slice(2)) || 0)) + 1;
  row.id ??= `F-${String(next).padStart(3, "0")}`;
  row.status ??= "fixed";
  row.clauses ??= [];
  const unknown = Object.keys(row).filter((k) => !FINDING_KEYS.includes(k));
  const missing = FINDING_KEYS.filter((k) => !(k in row));
  if (unknown.length) die(`unknown keys: ${unknown.join(", ")}`);
  if (missing.length) die(`missing keys: ${missing.join(", ")}`);
  d.findings.push(row);
  save(FINDINGS, d);
  console.log(row.id);
} else {
  die("usage: board.mjs task <id> <state> [--note ...] [--clauses a,b] | board.mjs finding '<json>'");
}
