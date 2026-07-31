CREATE TABLE IF NOT EXISTS public.localized_content_overrides (
  page TEXT NOT NULL CHECK (char_length(page) BETWEEN 1 AND 500),
  key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 5000),
  locale TEXT NOT NULL CHECK (locale IN ('en', 'zhHant', 'zhHans')),
  value TEXT NOT NULL CHECK (char_length(value) <= 5000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 320),
  PRIMARY KEY (page, key, locale)
);

INSERT INTO public.localized_content_overrides (page, key, locale, value, updated_at, updated_by)
SELECT page, key, 'zhHant', value, updated_at, updated_by
FROM public.content_overrides
ON CONFLICT (page, key, locale) DO NOTHING;

CREATE INDEX IF NOT EXISTS localized_content_overrides_updated_at_idx
  ON public.localized_content_overrides (updated_at DESC);

ALTER TABLE public.localized_content_overrides ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS localized_content_overrides_live_revision ON public.localized_content_overrides;
CREATE TRIGGER localized_content_overrides_live_revision
AFTER INSERT OR UPDATE OR DELETE ON public.localized_content_overrides
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('content');
