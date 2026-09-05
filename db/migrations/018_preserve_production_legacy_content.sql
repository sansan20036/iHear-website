-- Preserve content edited with the legacy inline editor when the semantic slot
-- is still untouched migration-013 seed data. Legacy rows remain in place so
-- rolling back to the old client continues to show the same content.
WITH mappings (
  source_page,
  source_key,
  target_page,
  target_key,
  locale,
  seeded_value
) AS (
  VALUES
    (
      '/',
      'i18n:prog_sub',
      '/__global__',
      'shared.prog.subtitle',
      'en',
      'Direct student support and community education: a global community with local action across Taiwan, China, the US, and Canada.'
    ),
    (
      '/team',
      'i18n:roster_h',
      '/team',
      'team.roster.title',
      'en',
      'Our Tutors'
    ),
    (
      '/team',
      'i18n:roster_sub',
      '/team',
      'team.roster.subtitle',
      'en',
      'Every iHear tutor, with their full profile. Tap a name to read their story.'
    ),
    (
      '/team',
      'i18n:team_intro',
      '/team',
      'team.team.intro',
      'en',
      'iHear is led by a student leadership team committed to building inclusive, high-quality communication support for learners with diverse needs. Together, our leaders shape program vision, instructional quality, and day-to-day execution, ensuring that iHear remains both mission-driven and impact-focused.'
    )
),
candidates AS (
  SELECT
    target.page,
    target.key,
    target.locale,
    legacy.value
  FROM mappings mapping
  JOIN public.localized_content_overrides legacy
    ON legacy.page = mapping.source_page
   AND legacy.key = mapping.source_key
   AND legacy.locale = mapping.locale
  JOIN public.localized_content_overrides target
    ON target.page = mapping.target_page
   AND target.key = mapping.target_key
   AND target.locale = mapping.locale
  WHERE target.value = mapping.seeded_value
    AND target.updated_by = 'migration-013'
)
UPDATE public.localized_content_overrides AS target
SET
  value = candidate.value,
  updated_at = NOW(),
  updated_by = 'migration-018-preserve-legacy-content'
FROM candidates candidate
WHERE target.page = candidate.page
  AND target.key = candidate.key
  AND target.locale = candidate.locale;
