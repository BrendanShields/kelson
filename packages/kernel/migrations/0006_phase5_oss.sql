-- Phase 5: bandit outcomes (append-only bookkeeping — RTR-5 keeps weight as
-- the bandit's only mutable field), weight-column write restriction, and
-- divergence reports (SPEC-4/5).
CREATE TABLE routing_outcome (
  id TEXT PRIMARY KEY,
  policy_version TEXT NOT NULL,
  arm TEXT NOT NULL,
  outcome INTEGER NOT NULL CHECK (outcome IN (0, 1)),
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE divergence_report (
  id TEXT PRIMARY KEY,
  spec_hash TEXT NOT NULL,
  clause_ids TEXT NOT NULL,
  entries TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TRIGGER routing_outcome_append_only BEFORE UPDATE ON routing_outcome
BEGIN SELECT RAISE(ABORT, 'routing_outcome is append-only'); END;
CREATE TRIGGER routing_outcome_no_delete BEFORE DELETE ON routing_outcome
BEGIN SELECT RAISE(ABORT, 'routing_outcome is append-only'); END;
-- RTR-5: weight (and its timestamp) are the only mutable columns.
CREATE TRIGGER routing_weight_write_surface BEFORE UPDATE ON routing_weight
WHEN OLD.policy_version != NEW.policy_version OR OLD.arm != NEW.arm
BEGIN SELECT RAISE(ABORT, 'routing_weight: only weight/updated_at may change (RTR-5)'); END;
