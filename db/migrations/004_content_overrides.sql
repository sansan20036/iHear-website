CREATE TABLE IF NOT EXISTS content_overrides (
  page TEXT NOT NULL CHECK (char_length(page) BETWEEN 1 AND 500),
  key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 5000),
  value TEXT NOT NULL CHECK (char_length(value) <= 5000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 320),
  PRIMARY KEY (page, key)
);

CREATE INDEX IF NOT EXISTS content_overrides_updated_at_idx
  ON content_overrides (updated_at DESC);

ALTER TABLE content_overrides ENABLE ROW LEVEL SECURITY;
