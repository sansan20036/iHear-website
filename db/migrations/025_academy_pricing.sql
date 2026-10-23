-- Migration 024 is reserved for the separate homepage CP7 release.
-- Widen only this dedicated settings value; every existing key keeps its limit.
ALTER TABLE public.site_settings DROP CONSTRAINT IF EXISTS site_settings_value_length;
ALTER TABLE public.site_settings ADD CONSTRAINT site_settings_value_length CHECK (
  char_length(value) BETWEEN 1 AND CASE WHEN key = 'academy_pricing_v1' THEN 8000 ELSE 500 END
);

ALTER TABLE public.admin_activity_log DROP CONSTRAINT IF EXISTS admin_activity_log_entity_type_check;
ALTER TABLE public.admin_activity_log ADD CONSTRAINT admin_activity_log_entity_type_check
  CHECK (entity_type IN ('team', 'impact', 'admin', 'resource', 'academy'));

-- Do not overwrite an administrator's prices or increment a record's version.
-- The outer existence guard also avoids firing the statement-level revision
-- trigger for an ordinary repeated migration whose seed already exists.
DO $academy_seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.site_settings WHERE key = 'academy_pricing_v1') THEN
    INSERT INTO public.site_settings (key, value, record_version, updated_by)
    VALUES (
      'academy_pricing_v1',
      '{"schemaVersion":1,"lessonMinutes":60,"packageLessons":10,"en":{"currency":"USD","intro":"Choose a single lesson or a package of ten lessons with a college student tutor.","serviceDescription":"This rate includes college essay advising and academic support across all subjects.","tiers":[{"id":"college","name":"College Student Tutors","singlePrice":45,"packagePrice":425}]},"zhHant":{"currency":"TWD","intro":"依照學習需求選擇導師，並選擇單堂課程或十堂套裝。","serviceDescription":"本頁各項英文學習服務皆適用所選導師的費率。","tiers":[{"id":"highschool","name":"高中生導師","singlePrice":800,"packagePrice":7200},{"id":"college","name":"大學生或成人導師","singlePrice":1200,"packagePrice":10800}]}}',
      1,
      'migration-025'
    )
    ON CONFLICT (key) DO NOTHING;
  END IF;
END;
$academy_seed$;
