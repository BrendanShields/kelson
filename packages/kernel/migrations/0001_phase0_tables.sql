CREATE TABLE session (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  lockfile_hash TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'incomplete', 'degraded')),
  trace_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  spec_clause_refs TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('open', 'in_progress', 'delivered', 'accepted', 'corrected', 'abandoned')),
  acceptance_signal TEXT CHECK (acceptance_signal IN ('approval', 'merge_clean')),
  correction_count INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  delivered_at TEXT,
  closed_at TEXT
);

CREATE TABLE step_event (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sdlc_step TEXT NOT NULL CHECK (sdlc_step IN ('feedback', 'ideation', 'planning', 'spec', 'build', 'verify')),
  model TEXT NOT NULL,
  effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
  agent_id TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  tokens_cache_read INTEGER NOT NULL,
  tokens_cache_write INTEGER NOT NULL,
  unit_prices TEXT NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  budget_tokens INTEGER NOT NULL,
  overrun TEXT NOT NULL CHECK (overrun IN ('none', 'soft', 'paused')),
  span_id TEXT,
  schema_version INTEGER NOT NULL
);
CREATE INDEX idx_step_event_task ON step_event (task_id);
CREATE INDEX idx_step_event_session ON step_event (session_id);

CREATE TABLE intervention_event (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('correction', 'clarification', 'approval')),
  artifact_hash TEXT,
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE artifact (
  repo TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('signal', 'idea', 'prd', 'erd', 'adr', 'spec', 'code_region', 'test')),
  content_hash TEXT NOT NULL,
  authority TEXT NOT NULL CHECK (authority IN ('authored', 'inferred', 'confirmed')),
  tier TEXT NOT NULL CHECK (tier IN ('T0', 'T1', 'T2')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, logical_id)
);

CREATE TABLE trace_link (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  downstream_id TEXT NOT NULL,
  upstream_hash_at_link TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_trace_link_upstream ON trace_link (repo, upstream_id);
CREATE INDEX idx_trace_link_downstream ON trace_link (repo, downstream_id);

CREATE TABLE drift_event (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('code_under_spec', 'spec_over_code', 'upstream_stale')),
  detected_at TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'open' CHECK (resolution IN ('open', 'repaired', 'overridden', 'promoted')),
  resolved_at TEXT,
  schema_version INTEGER NOT NULL
);

-- Append-only event tables (ERD §2): structural enforcement, not convention.
CREATE TRIGGER step_event_append_only BEFORE UPDATE ON step_event
BEGIN SELECT RAISE(ABORT, 'step_event is append-only'); END;
CREATE TRIGGER intervention_event_append_only BEFORE UPDATE ON intervention_event
BEGIN SELECT RAISE(ABORT, 'intervention_event is append-only'); END;
CREATE TRIGGER step_event_no_delete BEFORE DELETE ON step_event
BEGIN SELECT RAISE(ABORT, 'step_event is append-only'); END;
CREATE TRIGGER intervention_event_no_delete BEFORE DELETE ON intervention_event
BEGIN SELECT RAISE(ABORT, 'intervention_event is append-only'); END;
