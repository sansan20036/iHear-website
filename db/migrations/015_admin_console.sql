CREATE TABLE IF NOT EXISTS public.admin_accounts (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'editor',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  invited_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL,
  CONSTRAINT admin_accounts_email_format CHECK (
    char_length(email) BETWEEN 3 AND 320
    AND email = lower(email)
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CONSTRAINT admin_accounts_role_allowed CHECK (role = 'editor'),
  CONSTRAINT admin_accounts_version_positive CHECK (version >= 1),
  CONSTRAINT admin_accounts_actor_length CHECK (
    char_length(invited_by) BETWEEN 1 AND 320
    AND char_length(updated_by) BETWEEN 1 AND 320
  ),
  CONSTRAINT admin_accounts_timestamp_order CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS admin_accounts_enabled_idx
  ON public.admin_accounts (enabled, email);

CREATE TABLE IF NOT EXISTS public.admin_activity_log (
  id UUID PRIMARY KEY,
  actor_email TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'editor')),
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('team', 'impact', 'admin')),
  entity_id TEXT NOT NULL CHECK (char_length(entity_id) BETWEEN 1 AND 320),
  changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  entity_status TEXT,
  entity_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_activity_log_actor_length CHECK (char_length(actor_email) BETWEEN 1 AND 320),
  CONSTRAINT admin_activity_log_version_positive CHECK (entity_version IS NULL OR entity_version >= 1),
  CONSTRAINT admin_activity_log_changed_fields_bounded CHECK (cardinality(changed_fields) <= 80)
);

CREATE INDEX IF NOT EXISTS admin_activity_log_created_at_idx
  ON public.admin_activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_activity_log_entity_idx
  ON public.admin_activity_log (entity_type, entity_id, created_at DESC);

ALTER TABLE public.team_profiles
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE public.team_profiles DROP CONSTRAINT IF EXISTS team_profiles_deleted_state;
ALTER TABLE public.team_profiles ADD CONSTRAINT team_profiles_deleted_state CHECK (
  (deleted_at IS NULL AND deleted_by IS NULL)
  OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND char_length(deleted_by) BETWEEN 1 AND 320)
);

CREATE INDEX IF NOT EXISTS team_profiles_deleted_at_idx
  ON public.team_profiles (deleted_at, section, sort_order);

ALTER TABLE public.impact_milestones
  ADD COLUMN IF NOT EXISTS archived_by TEXT,
  ADD COLUMN IF NOT EXISTS archived_from_status TEXT;

UPDATE public.impact_milestones
SET archived_by = COALESCE(updated_by, 'migration-015')
WHERE status = 'archived' AND archived_by IS NULL;

UPDATE public.impact_milestones
SET archived_from_status = 'draft'
WHERE status = 'archived' AND archived_from_status IS NULL;

ALTER TABLE public.impact_milestones DROP CONSTRAINT IF EXISTS impact_milestones_archived_actor_state;
ALTER TABLE public.impact_milestones ADD CONSTRAINT impact_milestones_archived_actor_state CHECK (
  (status = 'archived' AND archived_at IS NOT NULL AND archived_by IS NOT NULL
    AND archived_from_status IN ('draft', 'published'))
  OR (status <> 'archived' AND archived_at IS NULL AND archived_by IS NULL AND archived_from_status IS NULL)
);

ALTER TABLE public.admin_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_activity_log ENABLE ROW LEVEL SECURITY;

-- A Team mutation always finishes by changing team_profiles. Keeping a second
-- statement trigger on team_people caused one logical save to emit two revisions.
DROP TRIGGER IF EXISTS team_people_live_revision ON public.team_people;

COMMENT ON TABLE public.admin_accounts IS
  'Server-managed editor allowlist. Environment owners are intentionally not stored here.';
COMMENT ON TABLE public.admin_activity_log IS
  'Append-only administrative audit trail containing field names but no copied profile content.';
