-- Phase 3 routing + context domain (ERD §7, PRD §11/§12.1).
CREATE TABLE routing_decision (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'escalation')),
  feature_vector TEXT NOT NULL,
  rule_index INTEGER NOT NULL,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('rule', 'capability')),
  target TEXT NOT NULL,
  effort TEXT NOT NULL,
  loadout TEXT NOT NULL,
  budget_tokens INTEGER NOT NULL,
  escalation TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  regret INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

-- RTR-5/RPOL-4 (Phase 5 updater): weight is the bandit's ONLY write surface.
CREATE TABLE routing_weight (
  policy_version TEXT NOT NULL,
  arm TEXT NOT NULL,
  weight REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (policy_version, arm)
);

CREATE TABLE bundle_event (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tokenizer TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE bundle_miss_event (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE budget_event (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('overrun', 'triage_requested', 'triage_resolved')),
  payload TEXT NOT NULL,
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

-- Event tables are append-only (ERD §2).
CREATE TRIGGER routing_decision_append_only BEFORE UPDATE ON routing_decision
BEGIN SELECT RAISE(ABORT, 'routing_decision is append-only'); END;
CREATE TRIGGER routing_decision_no_delete BEFORE DELETE ON routing_decision
BEGIN SELECT RAISE(ABORT, 'routing_decision is append-only'); END;
CREATE TRIGGER bundle_event_append_only BEFORE UPDATE ON bundle_event
BEGIN SELECT RAISE(ABORT, 'bundle_event is append-only'); END;
CREATE TRIGGER bundle_event_no_delete BEFORE DELETE ON bundle_event
BEGIN SELECT RAISE(ABORT, 'bundle_event is append-only'); END;
CREATE TRIGGER bundle_miss_event_append_only BEFORE UPDATE ON bundle_miss_event
BEGIN SELECT RAISE(ABORT, 'bundle_miss_event is append-only'); END;
CREATE TRIGGER bundle_miss_event_no_delete BEFORE DELETE ON bundle_miss_event
BEGIN SELECT RAISE(ABORT, 'bundle_miss_event is append-only'); END;
CREATE TRIGGER budget_event_append_only BEFORE UPDATE ON budget_event
BEGIN SELECT RAISE(ABORT, 'budget_event is append-only'); END;
CREATE TRIGGER budget_event_no_delete BEFORE DELETE ON budget_event
BEGIN SELECT RAISE(ABORT, 'budget_event is append-only'); END;
