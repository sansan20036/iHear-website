-- P3-Multi (2026-11-09) DRAFT: programs (教學計畫) and courses (課程) above the blocks of 029, and
-- where an imported block came from. NOT a migration yet: like 029 it lives outside
-- db/migrations, so the project's migration runner never applies it anywhere; only the local
-- tests apply it, to a disposable PostgreSQL. Whether and when it is applied is decided with M-8.
--
-- Program 1 - n Course 1 - n block (classroom_blocks.course_id, optional: a block made by hand may
-- belong to no course). One-to-one lessons (028) are unchanged. Names here are of programs and
-- courses, never of people. A course states the time zone its schedule is written in, so imported
-- times are never guessed.

CREATE TABLE IF NOT EXISTS public.classroom_programs (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9-]{1,36}$'),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9-]{1,30}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 320),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.classroom_courses (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9-]{1,36}$'),
  program_id TEXT NOT NULL REFERENCES public.classroom_programs (id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9-]{1,30}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- The IANA time zone the course's schedule is written in (for example America/New_York).
  time_zone TEXT NOT NULL CHECK (time_zone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$'),
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 320),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS classroom_courses_program_idx ON public.classroom_courses (program_id);

ALTER TABLE public.classroom_blocks
  ADD COLUMN IF NOT EXISTS course_id TEXT REFERENCES public.classroom_courses (id) ON DELETE RESTRICT,
  -- An imported block's place in its course's schedule (course, source date and start), so the
  -- same schedule imported again finds it instead of adding a second one.
  ADD COLUMN IF NOT EXISTS source_key TEXT CHECK (source_key ~ '^[A-Za-z0-9:._-]{1,120}$');
ALTER TABLE public.classroom_blocks DROP CONSTRAINT IF EXISTS classroom_blocks_source_needs_course;
ALTER TABLE public.classroom_blocks ADD CONSTRAINT classroom_blocks_source_needs_course CHECK (source_key IS NULL OR course_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_blocks_course_source ON public.classroom_blocks (course_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS classroom_blocks_course_idx ON public.classroom_blocks (course_id) WHERE course_id IS NOT NULL;

-- As in 028 and 029: row level security on, no policies, so only the server's own connection reads them.
ALTER TABLE public.classroom_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_courses ENABLE ROW LEVEL SECURITY;
