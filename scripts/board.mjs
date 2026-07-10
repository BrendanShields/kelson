#!/usr/bin/env bun
// Owns .kelson/tasks.json and .kelson/findings.json edits: validates shape,
// stamps timestamps, auto-numbers finding IDs. Hand-editing these files is
// how keys drift (postmortem lesson: 6 ad-hoc heredocs in one session).
//
//   bun scripts/board.mjs task <id> <open|in_progress|completed> [--note "..."] [--clauses TEL-1,ART-2]
//   bun scripts/board.mjs finding '<json>'     # id/status/fix_commit optional; id auto-numbers
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const TASKS = ".kelson/tasks.json";
const FINDINGS = ".kelson/findings.json";
const TASKS_ARCHIVE = ".kelson/archive/tasks.json";
const FINDINGS_ARCHIVE = ".kelson/archive/findings.json";
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
  let task = d.tasks.find((t) => t.id === id);
  // create-collision guard (2026-07-10: an archived-era completed C1-11 got
  // silently revived by a create attempt): --title means "new task", so an
  // existing id — active OR archived — is an error, and the archive must be
  // consulted since ids are hand-assigned against the full history.
  const titleIdx = rest.indexOf("--title");
  if (titleIdx !== -1) {
    const archivedTask =
      !task && existsSync(TASKS_ARCHIVE)
        ? load(TASKS_ARCHIVE).tasks.find((t) => t.id === id)
        : null;
    if (task || archivedTask)
      die(
        `task ${id} already exists${archivedTask ? " (archived)" : ""}: "${(task ?? archivedTask).title}" — pick a free id or drop --title to update it`,
      );
  }
  if (!task) {
    if (titleIdx === -1)
      die(`unknown task ${id} (have: ${d.tasks.map((t) => t.id).join(", ")}); pass --title to create`);
    task = { id, title: rest[titleIdx + 1], state, clauses: [], completed_at: null };
    d.tasks.push(task);
  }
  task.state = state;
  // re-marking an already-completed task must not falsify its history
  task.completed_at =
    state === "completed"
      ? (task.completed_at ?? `${new Date().toISOString().slice(0, 19)}Z`)
      : null;
  const noteIdx = rest.indexOf("--note");
  if (noteIdx !== -1) task.notes = rest[noteIdx + 1];
  const clausesIdx = rest.indexOf("--clauses");
  // "" means no clauses -> [], never [""] (F-audit 2026-07-05)
  if (clausesIdx !== -1)
    task.clauses = rest[clausesIdx + 1] ? rest[clausesIdx + 1].split(",") : [];
  save(TASKS, d);
  console.log(`${id} -> ${state}`);
} else if (mode === "finding") {
  const d = load(FINDINGS);
  // Flag form (postmortem 2026-07-05: inline JSON in shell is an escaping
  // hazard — apostrophes bit three times in one session):
  //   board.mjs finding --task C1-1 --severity warning --clauses A,B \
  //     --root-cause design_bug --summary "..." --fix "..." [--source s]
  let row;
  if ((rest[0] ?? "").startsWith("--")) {
    row = {};
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i]?.slice(2).replaceAll("-", "_");
      const val = rest[i + 1];
      if (!key || val === undefined) die(`flag ${rest[i]} needs a value`);
      row[key] = key === "clauses" ? (val ? val.split(",") : []) : val;
    }
    row.source ??= "clause-auditor";
  } else {
    row = JSON.parse(rest[0] ?? die("finding requires a JSON argument or flags"));
  }
  // taxonomy is an object (slug -> description); Object.keys, not .length/.includes
  const taxonomy = Object.keys(d.root_cause_taxonomy ?? {});
  if (taxonomy.length && !taxonomy.includes(row.root_cause))
    die(`root_cause must be one of: ${taxonomy.join(", ")}`);
  if (!["violation", "warning"].includes(row.severity))
    die("severity must be violation|warning");
  // numbering spans active + archive — archiving must never recycle an id
  const archived = existsSync(FINDINGS_ARCHIVE)
    ? load(FINDINGS_ARCHIVE).findings
    : [];
  const next =
    Math.max(
      0,
      ...[...d.findings, ...archived].map((f) => Number(f.id.slice(2)) || 0),
    ) + 1;
  row.id ??= `F-${String(next).padStart(3, "0")}`;
  row.status ??= "fixed";
  row.clauses ??= [];
  row.fix_commit ??= null; // not-yet-committed findings are stamped later
  const unknown = Object.keys(row).filter((k) => !FINDING_KEYS.includes(k));
  const missing = FINDING_KEYS.filter((k) => !(k in row));
  if (unknown.length) die(`unknown keys: ${unknown.join(", ")}`);
  if (missing.length) die(`missing keys: ${missing.join(", ")}`);
  d.findings.push(row);
  save(FINDINGS, d);
  console.log(row.id);
} else if (mode === "stamp") {
  const [sha, ...ids] = rest;
  if (!sha || ids.length === 0) die("usage: board.mjs stamp <sha> <F-ID...>");
  const d = load(FINDINGS);
  const missing = ids.filter((id) => !d.findings.some((f) => f.id === id));
  if (missing.length) die(`unknown finding ids: ${missing.join(", ")}`);
  for (const f of d.findings)
    if (ids.includes(f.id) && f.fix_commit === null) f.fix_commit = sha;
  save(FINDINGS, d);
  console.log(`stamped ${ids.join(", ")} -> ${sha}`);
} else if (mode === "stamp-head") {
  // Post-commit auto-stamp (postmortem 2026-07-09: 25 rows shipped fix_commit
  // null because the manual stamp step was always forgotten). Stamps rows
  // ADDED in HEAD; the stamped file rides along in the next commit — never
  // amends, so no hook recursion and no sha invalidation.
  let sha;
  let diff;
  try {
    sha = execSync("git rev-parse HEAD").toString().trim();
    diff = execSync(`git diff HEAD~1 HEAD -- ${FINDINGS}`).toString();
  } catch {
    process.exit(0); // initial commit or no git — nothing to stamp
  }
  const added = [...diff.matchAll(/^\+\s*"id": "(F-\d+)"/gm)].map((m) => m[1]);
  const d = load(FINDINGS);
  const stamped = d.findings.filter(
    (f) => added.includes(f.id) && f.fix_commit === null,
  );
  if (stamped.length === 0) process.exit(0);
  for (const f of stamped) f.fix_commit = sha;
  save(FINDINGS, d);
  console.log(
    `stamped ${stamped.map((f) => f.id).join(", ")} -> ${sha} (findings.json modified; include in next commit)`,
  );
} else if (mode === "archive") {
  // Closed rows dominate the active files (98% at 2026-07-10: ~30k tokens per
  // full read) — move them under .kelson/archive/. fixed-but-unstamped
  // findings stay active (stamp/stamp-head only see the active file);
  // open/deferred stay by definition. Miners read both files.
  mkdirSync(".kelson/archive", { recursive: true });
  const loadOr = (p, empty) => (existsSync(p) ? load(p) : empty);

  const t = load(TASKS);
  const ta = loadOr(TASKS_ARCHIVE, {
    schema_version: t.schema_version,
    tasks: [],
  });
  const doneTasks = t.tasks.filter((x) => x.state === "completed");
  ta.tasks.push(...doneTasks);
  t.tasks = t.tasks.filter((x) => x.state !== "completed");
  save(TASKS_ARCHIVE, ta);
  save(TASKS, t);

  const f = load(FINDINGS);
  const fa = loadOr(FINDINGS_ARCHIVE, {
    schema_version: f.schema_version,
    findings: [],
  });
  const closed = f.findings.filter(
    (x) =>
      x.status === "resolved" ||
      (x.status === "fixed" && x.fix_commit !== null),
  );
  fa.findings.push(...closed);
  f.findings = f.findings.filter((x) => !closed.includes(x));
  save(FINDINGS_ARCHIVE, fa);
  save(FINDINGS, f);
  console.log(
    `archived ${doneTasks.length} tasks, ${closed.length} findings -> .kelson/archive/`,
  );
} else {
  die("usage: board.mjs task <id> <state> [--note ...] [--clauses a,b] | board.mjs finding '<json>' | board.mjs stamp <sha> <F-ID...> | board.mjs stamp-head | board.mjs archive");
}
