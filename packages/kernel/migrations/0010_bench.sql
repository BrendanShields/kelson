-- EVP-11: cross-agent bench runs live in their own tables — never eval_run /
-- eval_task_result — so a single-config two-agent run cannot pollute the
-- flakiness windows (pooled per (task, config), EVP-5) and cannot reach the
-- ledger (EVP-6/7 read only eval_run). Widening the Executor enum must also
-- widen BOTH CHECKs below (F-118 reflex: grep migrations for the CHECK).
CREATE TABLE bench_run (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  executor_candidate TEXT NOT NULL CHECK (executor_candidate IN ('claude', 'command', 'api')),
  executor_baseline TEXT NOT NULL CHECK (executor_baseline IN ('claude', 'command', 'api')),
  config TEXT NOT NULL,
  seed INTEGER NOT NULL,
  repeats INTEGER NOT NULL,
  model_versions TEXT NOT NULL,
  sandbox_profile TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  -- verdict JSON set by the single terminal finalization write (EVP-11);
  -- the verdict table pairs with eval_run and is not used here (ERD §6).
  verdict TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE bench_task_result (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  bench_task_id TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('candidate', 'baseline')),
  repeat_index INTEGER NOT NULL,
  fpar_pass INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  check_results TEXT NOT NULL,
  raw_ref TEXT,
  schema_version INTEGER NOT NULL
);

-- ERD §2: bench_task_result is append-only.
CREATE TRIGGER bench_task_result_append_only BEFORE UPDATE ON bench_task_result
BEGIN SELECT RAISE(ABORT, 'bench_task_result is append-only'); END;
CREATE TRIGGER bench_task_result_no_delete BEFORE DELETE ON bench_task_result
BEGIN SELECT RAISE(ABORT, 'bench_task_result is append-only'); END;
