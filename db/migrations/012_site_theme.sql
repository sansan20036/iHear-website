ALTER TABLE public.site_content_revisions
  DROP CONSTRAINT IF EXISTS site_content_revisions_scope;

ALTER TABLE public.site_content_revisions
  ADD CONSTRAINT site_content_revisions_scope
  CHECK (scope IN ('content', 'impact', 'team', 'theme'));

INSERT INTO public.site_content_revisions (scope, revision)
VALUES ('theme', 1)
ON CONFLICT (scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  record_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL,
  CONSTRAINT site_settings_key_length CHECK (char_length(key) BETWEEN 1 AND 100),
  CONSTRAINT site_settings_value_length CHECK (char_length(value) BETWEEN 1 AND 500),
  CONSTRAINT site_settings_version_positive CHECK (record_version >= 1),
  CONSTRAINT site_settings_actor_length CHECK (char_length(updated_by) BETWEEN 1 AND 320),
  CONSTRAINT site_settings_theme_allowed CHECK (
    key <> 'site_theme' OR value IN ('warm', 'ocean', 'sage', 'lavender', 'slate')
  )
);

INSERT INTO public.site_settings (key, value, record_version, updated_by)
VALUES ('site_theme', 'warm', 1, 'migration-012')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS site_settings_updated_at_idx
  ON public.site_settings (updated_at DESC);

ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS site_settings_live_revision ON public.site_settings;
CREATE TRIGGER site_settings_live_revision
AFTER INSERT OR UPDATE OR DELETE ON public.site_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('theme');
