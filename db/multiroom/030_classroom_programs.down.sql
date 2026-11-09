-- P3-Multi (2026-11-09) DRAFT rollback of 030: back to 029. Not applied by any project tool; only
-- tests/classroom-migration-029.test.mjs runs it, on a disposable local PostgreSQL.
--
-- It never deletes a program, a course or a block's link to one by itself: while any exists it
-- stops with an error and changes nothing (one transaction). Blocks themselves are untouched.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.classroom_programs') IS NOT NULL
     AND (EXISTS (SELECT 1 FROM public.classroom_programs) OR EXISTS (SELECT 1 FROM public.classroom_courses)) THEN
    RAISE EXCEPTION 'classroom programs or courses exist: take and verify a backup and decide what happens to them before rolling back 030';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.classroom_blocks_course_idx;
DROP INDEX IF EXISTS public.classroom_blocks_course_source;
ALTER TABLE public.classroom_blocks DROP CONSTRAINT IF EXISTS classroom_blocks_source_needs_course;
ALTER TABLE public.classroom_blocks
  DROP COLUMN IF EXISTS source_key,
  DROP COLUMN IF EXISTS course_id;
DROP TABLE IF EXISTS public.classroom_courses;
DROP TABLE IF EXISTS public.classroom_programs;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '030';
  END IF;
END
$$;

COMMIT;
