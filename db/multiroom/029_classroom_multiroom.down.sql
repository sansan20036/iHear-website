-- P3-Multi (2026-11-09) DRAFT rollback of 029: puts the database back to 028's classroom schema.
-- Not a migration and not applied anywhere by the project's tools; only
-- tests/classroom-migration-029.test.mjs runs it, on a disposable local PostgreSQL. Whether and
-- when 029 is applied to production is decision M-8 (with H8 for 028) and is not approved.
--
-- It never deletes classroom data by itself: while any block exists it stops with an error, and
-- nothing is changed (the whole file runs in one transaction). Blocks are removed only after a
-- verified backup and an explicit, separate decision. One-to-one lessons (028) are kept as they are.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.classroom_blocks') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.classroom_blocks) THEN
    RAISE EXCEPTION 'classroom blocks exist: take and verify a backup, decide what happens to them, then remove them before rolling back 029';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'classroom_participants' AND column_name = 'member_id')
     AND EXISTS (SELECT 1 FROM public.classroom_participants WHERE member_id IS NOT NULL OR role = 'observer') THEN
    RAISE EXCEPTION 'participant rows of blocks exist: remove the blocks first';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.classroom_participants_one_visit;
DROP INDEX IF EXISTS public.classroom_participants_one_assigned;
DROP INDEX IF EXISTS public.classroom_participants_member_room;
ALTER TABLE public.classroom_participants DROP CONSTRAINT IF EXISTS classroom_participants_identity;
ALTER TABLE public.classroom_participants DROP CONSTRAINT IF EXISTS classroom_participants_role_check;
ALTER TABLE public.classroom_participants
  DROP COLUMN IF EXISTS seat,
  DROP COLUMN IF EXISTS active,
  DROP COLUMN IF EXISTS member_id;
-- 028's own rules, exactly as 028 wrote them.
ALTER TABLE public.classroom_participants ADD CONSTRAINT classroom_participants_role_check CHECK (role IN ('tutor', 'student'));
ALTER TABLE public.classroom_participants ADD CONSTRAINT classroom_participants_identity CHECK (
  (role = 'tutor' AND staff_email IS NOT NULL AND join_key_hash IS NULL
    AND staff_email = lower(staff_email) AND char_length(staff_email) BETWEEN 3 AND 320)
  OR (role = 'student' AND staff_email IS NULL AND join_key_hash IS NOT NULL)
);

DROP INDEX IF EXISTS public.classroom_lessons_room_label;
DROP INDEX IF EXISTS public.classroom_lessons_one_lobby;
ALTER TABLE public.classroom_lessons DROP CONSTRAINT IF EXISTS classroom_lessons_room_shape;
ALTER TABLE public.classroom_lessons
  DROP COLUMN IF EXISTS room_label,
  DROP COLUMN IF EXISTS room_kind,
  DROP COLUMN IF EXISTS block_id;

DROP TABLE IF EXISTS public.classroom_block_members;
DROP TABLE IF EXISTS public.classroom_blocks;

-- The runner's record of 029, if 029 was applied through it, so a later run applies it again.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '029';
  END IF;
END
$$;

COMMIT;
