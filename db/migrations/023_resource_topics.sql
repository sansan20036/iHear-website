-- Checkpoint 1: additive schema expansion. No guide content is imported here.
-- The migration runner wraps this entire file in a transaction.
CREATE OR REPLACE FUNCTION public.resource_localized_valid(value JSONB, maximum INTEGER, required_en BOOLEAN)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object'
    AND jsonb_typeof(value->'en') = 'string'
    AND jsonb_typeof(value->'zhHant') = 'string'
    AND jsonb_typeof(value->'zhHans') = 'string'
    AND char_length(value->>'en') <= maximum
    AND char_length(value->>'zhHant') <= maximum
    AND char_length(value->>'zhHans') <= maximum
    AND (NOT required_en OR char_length(btrim(value->>'en')) > 0), FALSE);
$$;

CREATE TABLE IF NOT EXISTS public.resource_topics (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9-]{1,80}$'),
  title JSONB NOT NULL CHECK (public.resource_localized_valid(title, 200, TRUE)),
  description JSONB NOT NULL DEFAULT '{"en":"","zhHant":"","zhHans":""}'::jsonb
    CHECK (public.resource_localized_valid(description, 2000, FALSE)),
  slug TEXT NOT NULL CONSTRAINT resource_topics_slug_key UNIQUE
    CHECK (char_length(slug) BETWEEN 1 AND 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL CHECK (char_length(btrim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (char_length(btrim(updated_by)) BETWEEN 1 AND 320),
  archived_from_status TEXT CHECK (archived_from_status IN ('draft','published'))
);
ALTER TABLE public.resource_topics ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS resource_topics_public_order ON public.resource_topics (status, sort_order, id);

-- Conflict on ID preserves all administrator edits. A conflicting slug belonging
-- to a different ID fails the transaction rather than silently misassigning links.
WITH inserted AS (
  INSERT INTO public.resource_topics (id, title, slug, sort_order, status, created_by, updated_by) VALUES
    ('forms', '{"en":"Forms & useful links","zhHant":"表單／常用連結","zhHans":"表单／常用链接"}', 'resource-links', 10, 'published', 'migration-023', 'migration-023'),
    ('guides', '{"en":"Guides for families & educators","zhHant":"家庭與教育工作者指南","zhHans":"家庭与教育工作者指南"}', 'resource-guides', 20, 'draft', 'migration-023', 'migration-023'),
    ('articles', '{"en":"Articles","zhHant":"文章","zhHans":"文章"}', 'resource-articles', 30, 'published', 'migration-023', 'migration-023'),
    ('journal-club', '{"en":"Journal Club","zhHant":"文獻研讀會","zhHans":"文献研读会"}', 'journal-club', 40, 'draft', 'migration-023', 'migration-023'),
    ('guest-speakers', '{"en":"Guest Speakers","zhHant":"受邀講者","zhHans":"受邀讲者"}', 'guest-speakers', 50, 'draft', 'migration-023', 'migration-023'),
    ('calendar', '{"en":"Calendar","zhHant":"行事曆","zhHans":"日历"}', 'calendar', 60, 'draft', 'migration-023', 'migration-023'),
    ('announcements', '{"en":"Announcements","zhHant":"公告","zhHans":"公告"}', 'announcements', 70, 'draft', 'migration-023', 'migration-023')
  ON CONFLICT (id) DO NOTHING RETURNING id
)
INSERT INTO public.localized_translation_states
  (resource_type, resource_scope, resource_id, field_key, locale, source_hash, origin, glossary_version, updated_by)
SELECT 'resource', 'topic', id, 'title', locale, NULL, 'manual', 'ihear-2026-08-v1', 'migration-023'
FROM inserted CROSS JOIN (VALUES ('zhHant'), ('zhHans')) AS locales(locale)
ON CONFLICT DO NOTHING;

ALTER TABLE public.resource_links ADD COLUMN IF NOT EXISTS topic_id TEXT;
ALTER TABLE public.resource_links ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'external_link';
-- Only the new reference is populated; names, translations, URLs, statuses,
-- versions, ordering and historical authors/timestamps are left untouched.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.resource_links WHERE topic_id IS NULL) THEN
    UPDATE public.resource_links SET topic_id = CASE WHEN category = 'article' THEN 'articles' ELSE 'forms' END
    WHERE topic_id IS NULL;
  END IF;
END $$;
ALTER TABLE public.resource_links ALTER COLUMN topic_id SET NOT NULL;
ALTER TABLE public.resource_links ALTER COLUMN url SET DEFAULT '';
ALTER TABLE public.resource_links DROP CONSTRAINT IF EXISTS resource_links_url_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.resource_links'::regclass AND conname = 'resource_links_topic_fk') THEN
    ALTER TABLE public.resource_links ADD CONSTRAINT resource_links_topic_fk
      FOREIGN KEY (topic_id) REFERENCES public.resource_topics(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.resource_links'::regclass AND conname = 'resource_links_type_check') THEN
    ALTER TABLE public.resource_links ADD CONSTRAINT resource_links_type_check
      CHECK (type IN ('external_link','email_request','text'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.resource_links'::regclass AND conname = 'resource_links_typed_url_check') THEN
    ALTER TABLE public.resource_links ADD CONSTRAINT resource_links_typed_url_check CHECK (
      (type = 'external_link' AND url ~ '^https://[^/?#@[:space:]\\]+([/?#][^[:space:]\\]*)?$' AND char_length(url) <= 2048)
      OR (type IN ('email_request','text') AND url = '')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.resource_links'::regclass AND conname = 'resource_links_localized_check') THEN
    ALTER TABLE public.resource_links ADD CONSTRAINT resource_links_localized_check
      CHECK (public.resource_localized_valid(title, 200, TRUE) AND public.resource_localized_valid(description, 2000, FALSE));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.resource_links'::regclass AND conname = 'resource_links_actor_check') THEN
    ALTER TABLE public.resource_links ADD CONSTRAINT resource_links_actor_check
      CHECK (char_length(btrim(created_by)) BETWEEN 1 AND 320 AND char_length(btrim(updated_by)) BETWEEN 1 AND 320);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS resource_links_topic_order ON public.resource_links (topic_id, status, sort_order, id);

-- Old INSERT/UPSERT statements omit topic_id and type. Preserve them on updates;
-- only legacy form/article recategorization follows its matching built-in topic.
CREATE OR REPLACE FUNCTION public.resource_link_topic_compatibility()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE target_status TEXT;
BEGIN
  IF NEW.topic_id IS NULL THEN
    NEW.topic_id := CASE WHEN NEW.category = 'article' THEN 'articles' ELSE 'forms' END;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.category IS DISTINCT FROM OLD.category AND NEW.topic_id = OLD.topic_id
      AND OLD.topic_id = (CASE WHEN OLD.category = 'article' THEN 'articles' ELSE 'forms' END) THEN
      NEW.topic_id := CASE WHEN NEW.category = 'article' THEN 'articles' ELSE 'forms' END;
    END IF;
  END IF;
  -- Serialize new references against archival of the parent topic.
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO target_status FROM public.resource_topics WHERE id = NEW.topic_id FOR UPDATE;
  ELSIF NEW.topic_id IS DISTINCT FROM OLD.topic_id THEN
    SELECT status INTO target_status FROM public.resource_topics WHERE id = NEW.topic_id FOR UPDATE;
  END IF;
  IF target_status = 'archived' THEN
    RAISE EXCEPTION 'Restore the topic before assigning resources' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resource_links_topic_compatibility ON public.resource_links;
CREATE TRIGGER resource_links_topic_compatibility BEFORE INSERT OR UPDATE ON public.resource_links
FOR EACH ROW EXECUTE FUNCTION public.resource_link_topic_compatibility();

CREATE OR REPLACE FUNCTION public.resource_archive_metadata()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status = 'archived' AND OLD.status <> 'archived' THEN
      NEW.archived_from_status := OLD.status;
    ELSIF NEW.status <> 'archived' THEN
      NEW.archived_from_status := NULL;
    END IF;
  ELSIF NEW.status <> 'archived' THEN
    NEW.archived_from_status := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resource_topics_archive_metadata ON public.resource_topics;
CREATE TRIGGER resource_topics_archive_metadata BEFORE INSERT OR UPDATE ON public.resource_topics
FOR EACH ROW EXECUTE FUNCTION public.resource_archive_metadata();
DROP TRIGGER IF EXISTS resource_links_archive_metadata ON public.resource_links;
CREATE TRIGGER resource_links_archive_metadata BEFORE INSERT OR UPDATE ON public.resource_links
FOR EACH ROW EXECUTE FUNCTION public.resource_archive_metadata();

CREATE OR REPLACE FUNCTION public.resource_topic_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'Topic slugs are permanent' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'archived' AND OLD.status <> 'archived'
    AND EXISTS (SELECT 1 FROM public.resource_links WHERE topic_id = NEW.id) THEN
    RAISE EXCEPTION 'Move all resources, including archived resources, before archiving this topic' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resource_topics_guard ON public.resource_topics;
CREATE TRIGGER resource_topics_guard BEFORE UPDATE ON public.resource_topics
FOR EACH ROW EXECUTE FUNCTION public.resource_topic_guard();
DROP TRIGGER IF EXISTS resource_topics_live_revision ON public.resource_topics;
CREATE TRIGGER resource_topics_live_revision AFTER INSERT OR UPDATE OR DELETE ON public.resource_topics
FOR EACH ROW EXECUTE FUNCTION public.bump_site_content_revision('content');

COMMENT ON COLUMN public.resource_links.category IS 'Legacy form/article compatibility field; new grouping uses topic_id.';
COMMENT ON COLUMN public.resource_links.type IS 'Explicit action type. Email/text use an empty URL, never an inferred action.';
COMMENT ON TABLE public.resource_topics IS 'Generic resource groups. Translation provenance uses resource_type=resource, resource_scope=topic.';
