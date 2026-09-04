CREATE TABLE IF NOT EXISTS public.localized_translation_states (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('content','team','impact','media')),
  resource_scope TEXT NOT NULL DEFAULT '' CHECK (char_length(resource_scope) <= 500),
  resource_id TEXT NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 5000),
  field_key TEXT NOT NULL CHECK (char_length(field_key) BETWEEN 1 AND 100),
  locale TEXT NOT NULL CHECK (locale IN ('zhHant','zhHans')),
  source_hash TEXT CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$'),
  origin TEXT NOT NULL CHECK (origin IN ('machine','manual','protected_legacy')),
  glossary_version TEXT NOT NULL CHECK (char_length(glossary_version) BETWEEN 1 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 320),
  PRIMARY KEY (resource_type, resource_scope, resource_id, field_key, locale)
);

CREATE INDEX IF NOT EXISTS localized_translation_states_updated_at_idx
  ON public.localized_translation_states (updated_at DESC);

ALTER TABLE public.localized_translation_states ENABLE ROW LEVEL SECURITY;

INSERT INTO public.localized_translation_states (
  resource_type, resource_scope, resource_id, field_key, locale,
  source_hash, origin, glossary_version, updated_by
)
SELECT 'content', page, key, 'value', locale, NULL, 'protected_legacy', 'ihear-2026-08-v1', 'migration-017'
FROM public.localized_content_overrides
WHERE locale IN ('zhHant','zhHans') AND char_length(value) > 0
ON CONFLICT DO NOTHING;

INSERT INTO public.localized_translation_states (
  resource_type, resource_scope, resource_id, field_key, locale,
  source_hash, origin, glossary_version, updated_by
)
SELECT 'team', '', profile.id, field.field_key, field.locale, NULL,
  'protected_legacy', 'ihear-2026-08-v1', 'migration-017'
FROM public.team_profiles profile
CROSS JOIN LATERAL (VALUES
  ('role','zhHant',profile.role_zh_hant), ('role','zhHans',profile.role_zh_hans),
  ('schoolDisplay','zhHant',profile.school_display_zh_hant), ('schoolDisplay','zhHans',profile.school_display_zh_hans),
  ('languages','zhHant',profile.languages_zh_hant), ('languages','zhHans',profile.languages_zh_hans),
  ('strengths','zhHant',profile.strengths_zh_hant), ('strengths','zhHans',profile.strengths_zh_hans),
  ('summary','zhHant',profile.summary_zh_hant), ('summary','zhHans',profile.summary_zh_hans),
  ('bio','zhHant',profile.bio_zh_hant), ('bio','zhHans',profile.bio_zh_hans),
  ('hobbies','zhHant',profile.hobbies_zh_hant), ('hobbies','zhHans',profile.hobbies_zh_hans)
) AS field(field_key, locale, value)
WHERE char_length(field.value) > 0
ON CONFLICT DO NOTHING;

INSERT INTO public.localized_translation_states (
  resource_type, resource_scope, resource_id, field_key, locale,
  source_hash, origin, glossary_version, updated_by
)
SELECT 'impact', '', item.id, field.field_key, field.locale, NULL,
  'protected_legacy', 'ihear-2026-08-v1', 'migration-017'
FROM public.impact_milestones item
CROSS JOIN LATERAL (VALUES
  ('title','zhHant',item.title_zh_hant), ('title','zhHans',item.title_zh_hans),
  ('description','zhHant',item.description_zh_hant), ('description','zhHans',item.description_zh_hans),
  ('countryNames','zhHant',item.country_names_zh_hant), ('countryNames','zhHans',item.country_names_zh_hans)
) AS field(field_key, locale, value)
WHERE char_length(field.value) > 0
ON CONFLICT DO NOTHING;

INSERT INTO public.localized_translation_states (
  resource_type, resource_scope, resource_id, field_key, locale,
  source_hash, origin, glossary_version, updated_by
)
SELECT 'media', '', asset.slot, 'alt', field.locale, NULL,
  'protected_legacy', 'ihear-2026-08-v1', 'migration-017'
FROM public.site_media_assets asset
CROSS JOIN LATERAL (VALUES
  ('zhHant',asset.alt_zh_hant), ('zhHans',asset.alt_zh_hans)
) AS field(locale, value)
WHERE char_length(field.value) > 0
ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.localized_translation_states IS
  'Per-field translation provenance. Text remains in its owning content, team, impact, or media table.';
