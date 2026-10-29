-- Homepage calendar: one published document of events (site_settings key
-- home_calendar_v1) that administrators manage in /admin/calendar. It starts empty.
-- The P3 classroom prototype also drafted a 027; whichever ships second is renumbered.

ALTER TABLE public.site_settings DROP CONSTRAINT IF EXISTS site_settings_value_length;
ALTER TABLE public.site_settings ADD CONSTRAINT site_settings_value_length CHECK (
  char_length(value) BETWEEN 1 AND CASE
    WHEN key = 'academy_content_v2' THEN 60000
    WHEN key = 'academy_pricing_v1' THEN 8000
    WHEN key = 'home_calendar_v1' THEN 400000
    ELSE 500
  END
);

ALTER TABLE public.admin_activity_log DROP CONSTRAINT IF EXISTS admin_activity_log_entity_type_check;
ALTER TABLE public.admin_activity_log ADD CONSTRAINT admin_activity_log_entity_type_check
  CHECK (entity_type IN ('team', 'impact', 'admin', 'resource', 'academy', 'calendar'));

-- Seed an empty calendar only when absent: saved events are never overwritten and
-- their version is never incremented. The guard also keeps the settings statement
-- trigger from firing on a rerun.
DO $home_calendar_seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.site_settings WHERE key = 'home_calendar_v1') THEN
    INSERT INTO public.site_settings (key, value, record_version, updated_by)
    VALUES ('home_calendar_v1', '{"schemaVersion":1,"timeZone":"Asia/Taipei","events":[]}', 1, 'migration-027')
    ON CONFLICT (key) DO NOTHING;
  END IF;
END;
$home_calendar_seed$;
