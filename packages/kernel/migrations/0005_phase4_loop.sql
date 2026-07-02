-- Phase 4 loop domain (ERD §4, PRD §9).
-- proposal is insert-then-transition (state/updated_at/quarantine_reason
-- mutate as the state machine advances); every transition is also an
-- append-only loop_event row, so the audit trail is monotone (I5).
CREATE TABLE proposal (
  id TEXT PRIMARY KEY,
  target_pack TEXT NOT NULL,
  diff TEXT NOT NULL,
  diff_hash TEXT NOT NULL,
  evidence TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('loop', 'human')),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'gated', 'approved', 'rejected', 'applied', 'monitoring', 'stable', 'reverted', 'quarantined')),
  quarantine_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE replay_record (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  snapshot_ref TEXT NOT NULL,
  config TEXT NOT NULL,
  run_id TEXT,
  outcome TEXT NOT NULL,
  validity TEXT NOT NULL CHECK (validity IN ('valid', 'advisory')),
  advisory_reason TEXT,
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE monitor_record (
  proposal_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  lockfile_after TEXT NOT NULL,
  baseline_session_ids TEXT NOT NULL,
  baseline_insufficient INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'cleared', 'reverted', 'abandoned')),
  check_seq INTEGER NOT NULL DEFAULT 0,
  stalled_notified INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  schema_version INTEGER NOT NULL
);

CREATE TABLE loop_event (
  id TEXT PRIMARY KEY,
  proposal_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('proposal_created', 'evidence_check', 'acl_rejected', 'state_transition', 'monitor_opened', 'monitor_check', 'monitor_check_skipped', 'regression_detected', 'monitor_stalled', 'monitor_closed', 'quarantine_release')),
  payload TEXT NOT NULL,
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TRIGGER loop_event_append_only BEFORE UPDATE ON loop_event
BEGIN SELECT RAISE(ABORT, 'loop_event is append-only'); END;
CREATE TRIGGER loop_event_no_delete BEFORE DELETE ON loop_event
BEGIN SELECT RAISE(ABORT, 'loop_event is append-only'); END;
CREATE TRIGGER replay_record_append_only BEFORE UPDATE ON replay_record
BEGIN SELECT RAISE(ABORT, 'replay_record is append-only'); END;
CREATE TRIGGER replay_record_no_delete BEFORE DELETE ON replay_record
BEGIN SELECT RAISE(ABORT, 'replay_record is append-only'); END;
