ALTER TABLE impact_milestones
  ADD COLUMN IF NOT EXISTS countries INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS country_names_zh_hant TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS country_names_zh_hans TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS country_names_en TEXT NOT NULL DEFAULT '';

UPDATE impact_milestones
SET
  countries = 4,
  country_names_zh_hant = '臺灣 · 中國 · 美國 · 加拿大',
  country_names_zh_hans = '台湾 · 中国 · 美国 · 加拿大',
  country_names_en = 'Taiwan · China · United States · Canada'
WHERE
  kind = 'metrics'
  AND status = 'published'
  AND countries = 0;

ALTER TABLE impact_milestones
  DROP CONSTRAINT IF EXISTS impact_milestones_event_metrics_shape,
  DROP CONSTRAINT IF EXISTS impact_milestones_published_locales_complete,
  DROP CONSTRAINT IF EXISTS impact_milestones_countries_range,
  DROP CONSTRAINT IF EXISTS impact_milestones_country_names_length;

ALTER TABLE impact_milestones
  ADD CONSTRAINT impact_milestones_countries_range
    CHECK (countries BETWEEN 0 AND 250) NOT VALID,
  ADD CONSTRAINT impact_milestones_country_names_length
    CHECK (
      char_length(country_names_zh_hant) <= 500
      AND char_length(country_names_zh_hans) <= 500
      AND char_length(country_names_en) <= 500
    ) NOT VALID,
  ADD CONSTRAINT impact_milestones_event_metrics_shape
    CHECK (
      kind <> 'event'
      OR (
        volunteers = 0
        AND NOT volunteers_plus
        AND students = 0
        AND NOT students_plus
        AND sessions = 0
        AND NOT sessions_plus
        AND countries = 0
        AND country_names_zh_hant = ''
        AND country_names_zh_hans = ''
        AND country_names_en = ''
      )
    ) NOT VALID,
  ADD CONSTRAINT impact_milestones_published_locales_complete
    CHECK (
      status <> 'published'
      OR (
        description_zh_hant <> ''
        AND description_zh_hans <> ''
        AND description_en <> ''
        AND (
          kind <> 'event'
          OR (
            title_zh_hant <> ''
            AND title_zh_hans <> ''
            AND title_en <> ''
          )
        )
        AND (
          kind <> 'metrics'
          OR (
            countries BETWEEN 1 AND 250
            AND country_names_zh_hant <> ''
            AND country_names_zh_hans <> ''
            AND country_names_en <> ''
          )
        )
      )
    ) NOT VALID;

ALTER TABLE impact_milestones
  VALIDATE CONSTRAINT impact_milestones_countries_range,
  VALIDATE CONSTRAINT impact_milestones_country_names_length,
  VALIDATE CONSTRAINT impact_milestones_event_metrics_shape,
  VALIDATE CONSTRAINT impact_milestones_published_locales_complete;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM impact_milestones
    WHERE kind = 'metrics' AND status = 'published'
    GROUP BY period
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot create unique published metrics index: duplicate published metrics periods exist';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS impact_milestones_unique_published_metrics_period
ON impact_milestones (period)
WHERE kind = 'metrics' AND status = 'published';
