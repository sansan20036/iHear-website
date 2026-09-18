CREATE TABLE IF NOT EXISTS public.resource_links (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9-]{1,80}$'),
  title JSONB NOT NULL CHECK (jsonb_typeof(title) = 'object' AND length(title->>'en') BETWEEN 1 AND 200),
  description JSONB NOT NULL CHECK (jsonb_typeof(description) = 'object'),
  url TEXT NOT NULL CHECK (url ~ '^https://' AND length(url) <= 2048),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  archived_from_status TEXT CHECK (archived_from_status IN ('draft','published'))
);
ALTER TABLE public.resource_links ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS resource_links_public_order ON public.resource_links (status, sort_order, id);

ALTER TABLE public.localized_translation_states DROP CONSTRAINT IF EXISTS localized_translation_states_resource_type_check;
ALTER TABLE public.localized_translation_states ADD CONSTRAINT localized_translation_states_resource_type_check
  CHECK (resource_type IN ('content','team','impact','media','resource'));

DROP TRIGGER IF EXISTS resource_links_live_revision ON public.resource_links;
CREATE TRIGGER resource_links_live_revision AFTER INSERT OR UPDATE OR DELETE ON public.resource_links
  FOR EACH STATEMENT EXECUTE FUNCTION public.bump_site_content_revision('content');

INSERT INTO public.resource_links (id,title,description,url,sort_order,status,created_by,updated_by) VALUES
('tutor-registration-2026-2027', '{"en":"2026–2027 Tutor Registration","zhHant":"2026–2027 小老師報名表","zhHans":"2026–2027 小老师报名表"}', '{"en":"Apply to join the iHear tutoring team.","zhHant":"申請加入 iHear 小老師團隊。","zhHans":"申请加入 iHear 小老师团队。"}', 'https://forms.gle/ouDos4WbYS6X2C3y6', 10, 'published', 'migration-020', 'migration-020'),
('tutor-reflection', '{"en":"Tutor Reflection","zhHant":"小老師課後反思表","zhHans":"小老师课后反思表"}', '{"en":"Record observations and reflections after tutoring sessions.","zhHant":"記錄課後觀察與教學反思。","zhHans":"记录课后观察与教学反思。"}', 'https://forms.gle/FzayZzgAEiGHsA1b9', 20, 'published', 'migration-020', 'migration-020'),
('tutor-availability-2026-2027', '{"en":"2026–2027 Teaching Time Availability","zhHant":"2026–2027 可授課時間登記表","zhHans":"2026–2027 可授课时间登记表"}', '{"en":"Share available teaching times to help schedule sessions.","zhHant":"提供可授課時段，協助安排課程。","zhHans":"提供可授课时段，协助安排课程。"}', 'https://forms.gle/r4XamySbXCDWHvAA8', 30, 'published', 'migration-020', 'migration-020')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.localized_translation_states (resource_type,resource_scope,resource_id,field_key,locale,source_hash,origin,glossary_version,updated_by)
SELECT 'resource','',id,field,locale,NULL,'manual','ihear-2026-08-v1','migration-020'
FROM public.resource_links
CROSS JOIN (VALUES ('title'),('description')) AS fields(field)
CROSS JOIN (VALUES ('zhHant'),('zhHans')) AS locales(locale)
WHERE created_by='migration-020'
ON CONFLICT DO NOTHING;

ALTER TABLE public.admin_activity_log DROP CONSTRAINT IF EXISTS admin_activity_log_entity_type_check;
ALTER TABLE public.admin_activity_log ADD CONSTRAINT admin_activity_log_entity_type_check CHECK (entity_type IN ('team','impact','admin','resource'));
