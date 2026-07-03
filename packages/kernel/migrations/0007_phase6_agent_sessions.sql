-- SES-1: append-only native-runtime session history (ERD §5). No UPDATE or
-- DELETE ever touches this table; head is derived from head_moved by rowid
-- (SES-3), so there is deliberately no head column anywhere.
CREATE TABLE session_event (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('user_message', 'assistant_message', 'tool_call', 'tool_result', 'permission_request', 'permission_decision', 'compaction', 'head_moved', 'session_meta')),
  payload TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE INDEX idx_session_event_session ON session_event (session_id);
CREATE INDEX idx_session_event_parent ON session_event (parent_id);

-- PROV-3: cost is NULL when the model has no registry price — never estimated.
-- SQLite cannot drop NOT NULL in place; rebuild step_event preserving rowid
-- order (rowid is the load-bearing event order, F-060/F-067).
CREATE TABLE step_event_new (
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
  cost_micro_usd INTEGER,
  budget_tokens INTEGER NOT NULL,
  overrun TEXT NOT NULL CHECK (overrun IN ('none', 'soft', 'paused')),
  span_id TEXT,
  schema_version INTEGER NOT NULL
);
INSERT INTO step_event_new
  SELECT id, task_id, session_id, sdlc_step, model, effort, agent_id,
         tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
         unit_prices, cost_micro_usd, budget_tokens, overrun, span_id, schema_version
  FROM step_event ORDER BY rowid;
DROP TABLE step_event;
ALTER TABLE step_event_new RENAME TO step_event;
CREATE INDEX idx_step_event_task ON step_event (task_id);
CREATE INDEX idx_step_event_session ON step_event (session_id);

-- DROP TABLE removed the append-only triggers; recreate them (ERD §2).
CREATE TRIGGER step_event_append_only BEFORE UPDATE ON step_event
BEGIN SELECT RAISE(ABORT, 'step_event is append-only'); END;
CREATE TRIGGER step_event_no_delete BEFORE DELETE ON step_event
BEGIN SELECT RAISE(ABORT, 'step_event is append-only'); END;

-- session_event is append-only for the same reason (SES-1).
CREATE TRIGGER session_event_append_only BEFORE UPDATE ON session_event
BEGIN SELECT RAISE(ABORT, 'session_event is append-only'); END;
CREATE TRIGGER session_event_no_delete BEFORE DELETE ON session_event
BEGIN SELECT RAISE(ABORT, 'session_event is append-only'); END;
