CREATE TABLE IF NOT EXISTS impact_milestones (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'metrics' CHECK (kind IN ('event', 'metrics')),
  period CHAR(7) NOT NULL,
  volunteers INTEGER NOT NULL CHECK (volunteers >= 0),
  volunteers_plus BOOLEAN NOT NULL DEFAULT FALSE,
  students INTEGER NOT NULL CHECK (students >= 0),
  students_plus BOOLEAN NOT NULL DEFAULT FALSE,
  sessions INTEGER NOT NULL CHECK (sessions >= 0),
  sessions_plus BOOLEAN NOT NULL DEFAULT FALSE,
  title_zh_hant TEXT NOT NULL DEFAULT '',
  title_zh_hans TEXT NOT NULL DEFAULT '',
  title_en TEXT NOT NULL DEFAULT '',
  description_zh_hant TEXT NOT NULL DEFAULT '',
  description_zh_hans TEXT NOT NULL DEFAULT '',
  description_en TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  sort_order INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS impact_milestones_public_idx
  ON impact_milestones (status, sort_order, period);
