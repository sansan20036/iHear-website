CREATE TABLE IF NOT EXISTS impact_milestone_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO impact_milestone_settings (key, value)
VALUES ('initial_seed_v2', 'complete')
ON CONFLICT (key) DO NOTHING;
