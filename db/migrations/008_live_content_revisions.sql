CREATE TABLE IF NOT EXISTS site_content_revisions (
  scope TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_content_revisions_scope CHECK (scope IN ('content', 'impact', 'team')),
  CONSTRAINT site_content_revisions_revision CHECK (revision >= 1)
);

INSERT INTO site_content_revisions (scope, revision)
VALUES ('content', 1), ('impact', 1), ('team', 1)
ON CONFLICT (scope) DO NOTHING;

CREATE OR REPLACE FUNCTION public.bump_site_content_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.site_content_revisions (scope, revision, updated_at)
  VALUES (TG_ARGV[0], 1, clock_timestamp())
  ON CONFLICT (scope) DO UPDATE SET
    revision = public.site_content_revisions.revision + 1,
    updated_at = clock_timestamp();
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_site_content_revision() FROM PUBLIC;

DROP TRIGGER IF EXISTS content_overrides_live_revision ON content_overrides;
CREATE TRIGGER content_overrides_live_revision
AFTER INSERT OR UPDATE OR DELETE ON content_overrides
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('content');

DROP TRIGGER IF EXISTS impact_milestones_live_revision ON impact_milestones;
CREATE TRIGGER impact_milestones_live_revision
AFTER INSERT OR UPDATE OR DELETE ON impact_milestones
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('impact');

DROP TRIGGER IF EXISTS impact_milestone_settings_live_revision ON impact_milestone_settings;
CREATE TRIGGER impact_milestone_settings_live_revision
AFTER INSERT OR UPDATE OR DELETE ON impact_milestone_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('impact');

DROP TRIGGER IF EXISTS team_people_live_revision ON team_people;
CREATE TRIGGER team_people_live_revision
AFTER INSERT OR UPDATE OR DELETE ON team_people
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('team');

DROP TRIGGER IF EXISTS team_profiles_live_revision ON team_profiles;
CREATE TRIGGER team_profiles_live_revision
AFTER INSERT OR UPDATE OR DELETE ON team_profiles
FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('team');

ALTER TABLE site_content_revisions ENABLE ROW LEVEL SECURITY;
