-- Room channel (2026-11-23) DRAFT: the fixed rooms' own whiteboard, public chat and share turn,
-- kept on our server for a short time (lib/room-channel). Of the existing tables it names only
-- classroom_lessons (migration 028); production stands at 030 (the integrator's read-only schema
-- check of 2026-11-23), so 031 is the next number.
--
-- NOT a migration yet. It lives outside db/migrations on purpose: the project's runner
-- (scripts/migrate-database.mjs) applies EVERY file it finds in db/migrations that a database has
-- not recorded, so a file placed there would ride into the next run against any database,
-- production included. Only tests/room-channel/postgres.test.mjs and the local measurement apply
-- this file, to a disposable local PostgreSQL. It becomes migration 031 (moved into db/migrations,
-- applied by the reviewed route for production SQL) only when the user approves the tables.
--
-- What is stored, and for how long (lib/room-channel/retention.mjs):
--   whiteboard lines and their points   until 24 hours after the lesson's end (48 hours after the
--                                       last stroke if the end was never recorded)
--   chat messages                       until the lesson's end (6 hours after the last message if
--                                       the end was never recorded)
--   the share turn                      who holds it now; no content
-- People appear only as the code the room shows for them. No name a person typed, no e-mail
-- address, no link, key or token is stored here.
-- These tables must stay OUT of the database backups: a backup would keep their rows past the
-- times above.

-- One small row per lesson and part: the part's own state (for the board: its header only), and
-- the moment after which the part must be gone.
CREATE TABLE IF NOT EXISTS public.classroom_room_channel (
  lesson_id TEXT NOT NULL REFERENCES public.classroom_lessons (id) ON DELETE CASCADE,
  part TEXT NOT NULL CHECK (part IN ('board', 'chat', 'turn')),
  seq BIGINT NOT NULL CHECK (seq >= 0),
  state JSONB NOT NULL,
  ended_at TIMESTAMPTZ,
  last_at TIMESTAMPTZ NOT NULL,
  delete_after TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lesson_id, part),
  CONSTRAINT classroom_room_channel_state_bounded CHECK (octet_length(state::text) <= 600000)
);

CREATE INDEX IF NOT EXISTS classroom_room_channel_delete_after_idx ON public.classroom_room_channel (delete_after);

-- A whiteboard's lines: one row per line, its points in the parts below. cleared_by: the clear
-- that took the line (kept only while that clear can be undone).
CREATE TABLE IF NOT EXISTS public.classroom_room_board_lines (
  lesson_id TEXT NOT NULL REFERENCES public.classroom_lessons (id) ON DELETE CASCADE,
  line TEXT NOT NULL CHECK (char_length(line) BETWEEN 3 AND 97),
  sender TEXT NOT NULL CHECK (char_length(sender) BETWEEN 1 AND 64),
  color SMALLINT NOT NULL CHECK (color BETWEEN 0 AND 7),
  width SMALLINT NOT NULL CHECK (width IN (1, 2, 4, 8)),
  parts INTEGER NOT NULL CHECK (parts BETWEEN 1 AND 400),
  points INTEGER NOT NULL CHECK (points >= 1),
  done BOOLEAN NOT NULL,
  began_seq BIGINT NOT NULL CHECK (began_seq >= 1),
  cleared_by BIGINT,
  PRIMARY KEY (lesson_id, line)
);

CREATE INDEX IF NOT EXISTS classroom_room_board_lines_cleared_idx ON public.classroom_room_board_lines (lesson_id, cleared_by);

CREATE TABLE IF NOT EXISTS public.classroom_room_board_parts (
  lesson_id TEXT NOT NULL,
  line TEXT NOT NULL,
  part INTEGER NOT NULL CHECK (part BETWEEN 0 AND 399),
  points JSONB NOT NULL CHECK (jsonb_typeof(points) = 'array' AND octet_length(points::text) <= 8192),
  PRIMARY KEY (lesson_id, line, part),
  FOREIGN KEY (lesson_id, line) REFERENCES public.classroom_room_board_lines (lesson_id, line) ON DELETE CASCADE
);

-- A whiteboard's recent operations, for people who were away for a moment, and so that a request
-- sent twice counts once (sender and the sender's own name for the request).
CREATE TABLE IF NOT EXISTS public.classroom_room_board_ops (
  lesson_id TEXT NOT NULL REFERENCES public.classroom_lessons (id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq >= 1),
  sender TEXT NOT NULL CHECK (char_length(sender) BETWEEN 1 AND 64),
  op TEXT NOT NULL CHECK (char_length(op) BETWEEN 1 AND 32),
  entry JSONB NOT NULL CHECK (octet_length(entry::text) <= 10000),
  PRIMARY KEY (lesson_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS classroom_room_board_ops_name_idx ON public.classroom_room_board_ops (lesson_id, sender, op);

-- As the other classroom tables: reachable by the server's own connection only.
ALTER TABLE public.classroom_room_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_room_board_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_room_board_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_room_board_ops ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.classroom_room_channel IS
  'Fixed rooms: whiteboard header, public chat and share turn per lesson. Short-lived; never in backups.';
COMMENT ON TABLE public.classroom_room_board_lines IS
  'Fixed rooms: whiteboard lines. Deleted within 24 hours after the lesson''s end; never in backups.';
