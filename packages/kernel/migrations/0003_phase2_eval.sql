-- Phase 2 eval domain (ERD §6).
CREATE TABLE eval_suite (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('gating', 'staging')),
  PRIMARY KEY (id, version)
);

CREATE TABLE benchmark_task (
  id TEXT NOT NULL,
  suite_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  snapshot_ref TEXT NOT NULL,
  statement TEXT NOT NULL,
  checks TEXT NOT NULL,
  budget_ceiling INTEGER NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL CHECK (origin IN ('seed', 'loop', 'human')),
  PRIMARY KEY (id, suite_id, suite_version)
);

CREATE TABLE eval_run (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ablate', 'compare', 'replay')),
  suite_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  config_a TEXT NOT NULL,
  config_b TEXT,
  seed INTEGER NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('claude', 'command')),
  model_versions TEXT NOT NULL,
  sandbox_profile TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE eval_task_result (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  bench_task_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('A', 'B')),
  repeat_index INTEGER NOT NULL,
  fpar_pass INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  check_results TEXT NOT NULL,
  raw_ref TEXT,
  schema_version INTEGER NOT NULL
);

CREATE TABLE verdict (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('helps', 'hurts', 'no_effect', 'underpowered')),
  deltas TEXT NOT NULL,
  n INTEGER NOT NULL,
  alpha REAL NOT NULL
);

-- ERD §2: eval_task_result is append-only.
CREATE TRIGGER eval_task_result_append_only BEFORE UPDATE ON eval_task_result
BEGIN SELECT RAISE(ABORT, 'eval_task_result is append-only'); END;
CREATE TRIGGER eval_task_result_no_delete BEFORE DELETE ON eval_task_result
BEGIN SELECT RAISE(ABORT, 'eval_task_result is append-only'); END;
