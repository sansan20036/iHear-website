ALTER TABLE impact_milestones
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'metrics';

ALTER TABLE impact_milestones
  ADD COLUMN IF NOT EXISTS title_zh_hant TEXT NOT NULL DEFAULT '';

ALTER TABLE impact_milestones
  ADD COLUMN IF NOT EXISTS title_zh_hans TEXT NOT NULL DEFAULT '';

ALTER TABLE impact_milestones
  ADD COLUMN IF NOT EXISTS title_en TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS impact_milestones_period_idx;
