ALTER TABLE public.site_content_revisions DROP CONSTRAINT IF EXISTS site_content_revisions_scope;
ALTER TABLE public.site_content_revisions ADD CONSTRAINT site_content_revisions_scope
  CHECK (scope IN ('content', 'impact', 'team', 'theme', 'layout'));

INSERT INTO public.site_content_revisions (scope, revision)
VALUES ('layout', 1) ON CONFLICT (scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.site_layout_configs (
  page TEXT PRIMARY KEY,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  record_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL,
  CONSTRAINT site_layout_configs_page_path CHECK (left(page, 1) = '/' AND char_length(page) <= 500),
  CONSTRAINT site_layout_configs_object CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT site_layout_configs_version_positive CHECK (record_version >= 1),
  CONSTRAINT site_layout_configs_actor_length CHECK (char_length(updated_by) BETWEEN 1 AND 320)
);

INSERT INTO public.site_layout_configs (page, config, updated_by)
VALUES ('/__global__', '{}'::jsonb, 'migration-014')
ON CONFLICT (page) DO NOTHING;

ALTER TABLE public.site_layout_configs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS site_layout_configs_updated_at_idx ON public.site_layout_configs (updated_at DESC);
DROP TRIGGER IF EXISTS site_layout_configs_live_revision ON public.site_layout_configs;
CREATE TRIGGER site_layout_configs_live_revision
AFTER INSERT OR UPDATE OR DELETE ON public.site_layout_configs
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('layout');
