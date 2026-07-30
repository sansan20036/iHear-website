ALTER TABLE impact_milestones
  DROP CONSTRAINT IF EXISTS impact_milestones_kind_check,
  DROP CONSTRAINT IF EXISTS impact_milestones_status_check,
  DROP CONSTRAINT IF EXISTS impact_milestones_volunteers_check,
  DROP CONSTRAINT IF EXISTS impact_milestones_students_check,
  DROP CONSTRAINT IF EXISTS impact_milestones_sessions_check;

ALTER TABLE impact_milestones
  ADD CONSTRAINT impact_milestones_kind_allowed
    CHECK (kind IN ('event', 'metrics')) NOT VALID,
  ADD CONSTRAINT impact_milestones_status_allowed
    CHECK (status IN ('draft', 'published', 'archived')) NOT VALID,
  ADD CONSTRAINT impact_milestones_period_format
    CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') NOT VALID,
  ADD CONSTRAINT impact_milestones_volunteers_nonnegative
    CHECK (volunteers >= 0) NOT VALID,
  ADD CONSTRAINT impact_milestones_students_nonnegative
    CHECK (students >= 0) NOT VALID,
  ADD CONSTRAINT impact_milestones_sessions_nonnegative
    CHECK (sessions >= 0) NOT VALID,
  ADD CONSTRAINT impact_milestones_sort_order_range
    CHECK (sort_order BETWEEN 0 AND 99999999) NOT VALID,
  ADD CONSTRAINT impact_milestones_version_positive
    CHECK (version >= 1) NOT VALID,
  ADD CONSTRAINT impact_milestones_id_length
    CHECK (char_length(id) BETWEEN 1 AND 200) NOT VALID,
  ADD CONSTRAINT impact_milestones_title_length
    CHECK (
      char_length(title_zh_hant) <= 200
      AND char_length(title_zh_hans) <= 200
      AND char_length(title_en) <= 200
    ) NOT VALID,
  ADD CONSTRAINT impact_milestones_description_length
    CHECK (
      char_length(description_zh_hant) <= 2000
      AND char_length(description_zh_hans) <= 2000
      AND char_length(description_en) <= 2000
    ) NOT VALID,
  ADD CONSTRAINT impact_milestones_actor_length
    CHECK (
      char_length(created_by) BETWEEN 1 AND 320
      AND char_length(updated_by) BETWEEN 1 AND 320
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
      )
    ) NOT VALID,
  ADD CONSTRAINT impact_milestones_metrics_title_shape
    CHECK (
      kind <> 'metrics'
      OR (
        title_zh_hant = ''
        AND title_zh_hans = ''
        AND title_en = ''
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
      )
    ) NOT VALID,
  ADD CONSTRAINT impact_milestones_archive_state
    CHECK ((status = 'archived') = (archived_at IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT impact_milestones_timestamp_order
    CHECK (updated_at >= created_at) NOT VALID;

ALTER TABLE impact_milestones
  VALIDATE CONSTRAINT impact_milestones_kind_allowed,
  VALIDATE CONSTRAINT impact_milestones_status_allowed,
  VALIDATE CONSTRAINT impact_milestones_period_format,
  VALIDATE CONSTRAINT impact_milestones_volunteers_nonnegative,
  VALIDATE CONSTRAINT impact_milestones_students_nonnegative,
  VALIDATE CONSTRAINT impact_milestones_sessions_nonnegative,
  VALIDATE CONSTRAINT impact_milestones_sort_order_range,
  VALIDATE CONSTRAINT impact_milestones_version_positive,
  VALIDATE CONSTRAINT impact_milestones_id_length,
  VALIDATE CONSTRAINT impact_milestones_title_length,
  VALIDATE CONSTRAINT impact_milestones_description_length,
  VALIDATE CONSTRAINT impact_milestones_actor_length,
  VALIDATE CONSTRAINT impact_milestones_event_metrics_shape,
  VALIDATE CONSTRAINT impact_milestones_metrics_title_shape,
  VALIDATE CONSTRAINT impact_milestones_published_locales_complete,
  VALIDATE CONSTRAINT impact_milestones_archive_state,
  VALIDATE CONSTRAINT impact_milestones_timestamp_order;

ALTER TABLE content_overrides
  ADD CONSTRAINT content_overrides_page_path
    CHECK (left(page, 1) = '/') NOT VALID;

ALTER TABLE content_overrides
  VALIDATE CONSTRAINT content_overrides_page_path;
