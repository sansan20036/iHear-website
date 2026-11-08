-- P3-Multi (2026-11-09) DRAFT: blocks (班次) with one Lobby and several teaching rooms, on top of
-- migration 028. NOT a migration yet: it lives outside db/migrations on purpose, so the project's
-- migration runner never applies it anywhere. Only tests/classroom-multi-postgres.test.mjs applies
-- it, to a disposable local PostgreSQL. Whether it is folded into 028 before 028 is first applied
-- (recommended) or stays a separate 029 is decision M-8; 028 itself is still not applied to the
-- production database (H8).
--
-- Every teaching room and the Lobby is a classroom_lessons row (its own Zoom session, consent
-- decision, recording and filing). A member's place in a room is a classroom_participants row
-- with member_id set; who the member is (e-mail, link hash, English name) lives only on
-- classroom_block_members.

CREATE TABLE IF NOT EXISTS public.classroom_blocks (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9-]{1,36}$'),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9-]{1,30}$'),
  lesson_date DATE NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Goes up by one with every change; a manager's change names the version it was made on.
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 320),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT classroom_blocks_time_order CHECK (ends_at > starts_at AND ends_at - starts_at <= INTERVAL '4 hours')
);

CREATE TABLE IF NOT EXISTS public.classroom_block_members (
  block_id TEXT NOT NULL REFERENCES public.classroom_blocks (id) ON DELETE CASCADE,
  member_id TEXT NOT NULL CHECK (member_id ~ '^[A-Za-z0-9-]{1,36}$'),
  code TEXT NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,20}$'),
  role TEXT NOT NULL CHECK (role IN ('manager', 'lead_tutor', 'co_tutor', 'observer', 'student')),
  -- The confirmed display name for Drive's file names (M-6); never guessed from an e-mail.
  english_name TEXT NOT NULL CHECK (char_length(english_name) BETWEEN 1 AND 80),
  staff_email TEXT,
  join_key_hash CHAR(64),
  PRIMARY KEY (block_id, member_id),
  UNIQUE (block_id, code),
  CONSTRAINT classroom_block_members_identity CHECK (
    (role <> 'student' AND staff_email IS NOT NULL AND join_key_hash IS NULL
      AND staff_email = lower(staff_email) AND char_length(staff_email) BETWEEN 3 AND 320)
    OR (role = 'student' AND staff_email IS NULL AND join_key_hash IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_block_members_member_idx ON public.classroom_block_members (member_id);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_block_members_join_key_idx
  ON public.classroom_block_members (join_key_hash) WHERE join_key_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS classroom_block_members_one_manager
  ON public.classroom_block_members (block_id) WHERE role = 'manager';
CREATE UNIQUE INDEX IF NOT EXISTS classroom_block_members_staff_once
  ON public.classroom_block_members (block_id, staff_email) WHERE staff_email IS NOT NULL;

ALTER TABLE public.classroom_lessons
  ADD COLUMN IF NOT EXISTS block_id TEXT REFERENCES public.classroom_blocks (id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS room_kind TEXT CHECK (room_kind IN ('lobby', 'room')),
  ADD COLUMN IF NOT EXISTS room_label TEXT CHECK (room_label ~ '^[A-Za-z0-9-]{1,8}$');
ALTER TABLE public.classroom_lessons DROP CONSTRAINT IF EXISTS classroom_lessons_room_shape;
ALTER TABLE public.classroom_lessons ADD CONSTRAINT classroom_lessons_room_shape CHECK (
  (block_id IS NULL AND room_kind IS NULL AND room_label IS NULL)
  OR (block_id IS NOT NULL AND room_kind IS NOT NULL AND room_label IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_lessons_one_lobby ON public.classroom_lessons (block_id) WHERE room_kind = 'lobby';
CREATE UNIQUE INDEX IF NOT EXISTS classroom_lessons_room_label ON public.classroom_lessons (block_id, room_label) WHERE block_id IS NOT NULL;

ALTER TABLE public.classroom_participants
  ADD COLUMN IF NOT EXISTS member_id TEXT,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS seat TEXT CHECK (seat IN ('lobby', 'assigned', 'visit'));
ALTER TABLE public.classroom_participants DROP CONSTRAINT IF EXISTS classroom_participants_role_check;
ALTER TABLE public.classroom_participants ADD CONSTRAINT classroom_participants_role_check CHECK (role IN ('tutor', 'student', 'observer'));
-- A one-to-one lesson's rows keep 028's identity rule; a block's room rows carry neither an
-- e-mail nor a key (the member does).
ALTER TABLE public.classroom_participants DROP CONSTRAINT IF EXISTS classroom_participants_identity;
ALTER TABLE public.classroom_participants ADD CONSTRAINT classroom_participants_identity CHECK (
  (member_id IS NULL AND role <> 'observer' AND (
    (role = 'tutor' AND staff_email IS NOT NULL AND join_key_hash IS NULL
      AND staff_email = lower(staff_email) AND char_length(staff_email) BETWEEN 3 AND 320)
    OR (role = 'student' AND staff_email IS NULL AND join_key_hash IS NOT NULL)))
  OR (member_id IS NOT NULL AND staff_email IS NULL AND join_key_hash IS NULL AND seat IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS classroom_participants_member_room ON public.classroom_participants (lesson_id, member_id) WHERE member_id IS NOT NULL;
-- At most one active assigned seat and one active visiting seat per member, whatever runs at once.
CREATE UNIQUE INDEX IF NOT EXISTS classroom_participants_one_assigned ON public.classroom_participants (member_id) WHERE member_id IS NOT NULL AND active AND seat = 'assigned';
CREATE UNIQUE INDEX IF NOT EXISTS classroom_participants_one_visit ON public.classroom_participants (member_id) WHERE member_id IS NOT NULL AND active AND seat = 'visit';

-- As in 028: row level security on, no policies, so only the server's own connection reads them.
ALTER TABLE public.classroom_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_block_members ENABLE ROW LEVEL SECURITY;
