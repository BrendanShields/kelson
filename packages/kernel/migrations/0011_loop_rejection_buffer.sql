-- LOOP-11: every emitted proposal records the rejection-history watermark
-- shown at its cycle's input assembly. Pre-clause rows read as NULL (no
-- history was shown when they were emitted).
ALTER TABLE proposal ADD COLUMN rejections_seen_through TEXT;
