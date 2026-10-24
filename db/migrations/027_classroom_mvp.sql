-- P3 classroom MVP: one-to-one lessons, the event log the live overview is derived from,
-- server jobs with leases, recording files handed to P1's Drive filing, and persisted anomaly
-- records for manual handling. Only codes are stored for people; no names, e-mail addresses
-- of students, Zoom display names, IP addresses, download links or tokens.
-- Not applied to production until the P3 release is approved.

CREATE TABLE IF NOT EXISTS public.classroom_lessons (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9-]{1,36}$'),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9-]{1,40}$'),
  lesson_date DATE NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 320),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT classroom_lessons_time_order CHECK (ends_at > starts_at AND ends_at - starts_at <= INTERVAL '4 hours')
);

CREATE INDEX IF NOT EXISTS classroom_lessons_starts_at_idx ON public.classroom_lessons (starts_at);

-- One row per person per lesson. Students enter with a personal link (only its hash is kept);
-- tutors sign in, and staff_email is the account their sign-in must match.
CREATE TABLE IF NOT EXISTS public.classroom_participants (
  lesson_id TEXT NOT NULL REFERENCES public.classroom_lessons (id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL CHECK (participant_id ~ '^[A-Za-z0-9-]{1,36}$'),
  code TEXT NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,20}$'),
  role TEXT NOT NULL CHECK (role IN ('tutor', 'student')),
  staff_email TEXT,
  join_key_hash CHAR(64),
  PRIMARY KEY (lesson_id, participant_id),
  UNIQUE (lesson_id, code),
  CONSTRAINT classroom_participants_identity CHECK (
    (role = 'tutor' AND staff_email IS NOT NULL AND join_key_hash IS NULL
      AND staff_email = lower(staff_email) AND char_length(staff_email) BETWEEN 3 AND 320)
    OR (role = 'student' AND staff_email IS NULL AND join_key_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS classroom_participants_join_key_idx
  ON public.classroom_participants (join_key_hash) WHERE join_key_hash IS NOT NULL;

-- Recording consent per person code. The consent policy is still Justine's to decide; until
-- then only synthetic records are entered, and the table stays deliberately generic.
CREATE TABLE IF NOT EXISTS public.classroom_consents (
  person_code TEXT PRIMARY KEY CHECK (person_code ~ '^[A-Za-z0-9-]{1,20}$'),
  status TEXT NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  version TEXT NOT NULL CHECK (char_length(version) BETWEEN 1 AND 40),
  granted_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  synthetic BOOLEAN NOT NULL DEFAULT TRUE,
  recorded_by TEXT NOT NULL CHECK (char_length(recorded_by) BETWEEN 1 AND 320),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT classroom_consents_state CHECK (
    (status = 'granted' AND granted_at IS NOT NULL AND withdrawn_at IS NULL)
    OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.classroom_staff_notices (
  person_code TEXT PRIMARY KEY CHECK (person_code ~ '^[A-Za-z0-9-]{1,20}$'),
  version TEXT NOT NULL CHECK (char_length(version) BETWEEN 1 AND 40),
  acknowledged_at TIMESTAMPTZ NOT NULL,
  recorded_by TEXT NOT NULL CHECK (char_length(recorded_by) BETWEEN 1 AND 320)
);

-- Only the hash and expiry of each issued classroom token, never the token.
CREATE TABLE IF NOT EXISTS public.classroom_join_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  lesson_id TEXT NOT NULL REFERENCES public.classroom_lessons (id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT classroom_join_tokens_order CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS classroom_join_tokens_lesson_idx ON public.classroom_join_tokens (lesson_id, participant_id);

-- Append-only facts, keyed by meaning so retries and reconciliations land on one row. The
-- tutor's heartbeat is the one exception: a single row per lesson, kept at its latest value.
CREATE TABLE IF NOT EXISTS public.classroom_events (
  key TEXT PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 600),
  lesson_id TEXT,
  type TEXT NOT NULL CHECK (char_length(type) BETWEEN 1 AND 80),
  source TEXT NOT NULL CHECK (source IN ('zoom_webhook', 'zoom_api', 'host_sdk', 'server', 'p1')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  CONSTRAINT classroom_events_data_bounded CHECK (octet_length(data::text) <= 20000)
);

CREATE INDEX IF NOT EXISTS classroom_events_lesson_idx ON public.classroom_events (lesson_id, occurred_at);

CREATE TABLE IF NOT EXISTS public.classroom_jobs (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 200),
  type TEXT NOT NULL CHECK (type IN ('file_recording', 'delete_vendor_copy')),
  lesson_id TEXT,
  provider_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error TEXT CHECK (error IS NULL OR char_length(error) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS classroom_jobs_due_idx ON public.classroom_jobs (status, available_at);

CREATE TABLE IF NOT EXISTS public.classroom_recording_files (
  provider_file_id TEXT PRIMARY KEY CHECK (char_length(provider_file_id) BETWEEN 1 AND 200),
  provider TEXT NOT NULL CHECK (provider IN ('zoom', 'synthetic')),
  lesson_id TEXT,
  provider_session_id TEXT,
  kind TEXT,
  extension TEXT NOT NULL DEFAULT '',
  size BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
  md5 TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SKIPPED', 'HOLD', 'STORED', 'QUARANTINED', 'FAILED')),
  hold TEXT CHECK (hold IS NULL OR hold IN ('NO_CONSENT', 'AFTER_WITHDRAWAL', 'UNKNOWN_PARTICIPANT', 'UNKNOWN_SESSION', 'CONSENT_WITHDRAWN')),
  recording_start TIMESTAMPTZ,
  recording_end TIMESTAMPTZ,
  planned_name TEXT,
  upload_session_uri TEXT,
  drive_file_id TEXT,
  filed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS classroom_recording_files_lesson_idx ON public.classroom_recording_files (lesson_id);

-- Problems the overview found, kept even after they clear, with who handled them and how.
CREATE TABLE IF NOT EXISTS public.classroom_anomalies (
  lesson_id TEXT NOT NULL REFERENCES public.classroom_lessons (id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code ~ '^[A-Z_]{3,60}$'),
  severity TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
  first_seen_at TIMESTAMPTZ NOT NULL,
  -- When the current occurrence began. A problem that comes back, or a warning that becomes an
  -- error, starts a new occurrence: handling recorded before it no longer counts.
  opened_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  PRIMARY KEY (lesson_id, code),
  CONSTRAINT classroom_anomalies_seen_order CHECK (opened_at >= first_seen_at AND last_seen_at >= opened_at),
  CONSTRAINT classroom_anomalies_acknowledged CHECK (
    (acknowledged_by IS NULL AND acknowledged_at IS NULL)
    OR (acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL AND char_length(acknowledged_by) BETWEEN 1 AND 320)
  )
);

ALTER TABLE public.admin_activity_log DROP CONSTRAINT IF EXISTS admin_activity_log_entity_type_check;
ALTER TABLE public.admin_activity_log ADD CONSTRAINT admin_activity_log_entity_type_check
  CHECK (entity_type IN ('team', 'impact', 'admin', 'resource', 'academy', 'classroom'));

ALTER TABLE public.classroom_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_staff_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_join_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_recording_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classroom_anomalies ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.classroom_events IS
  'Minimized classroom facts (codes only). The live overview is derived from these rows.';
COMMENT ON TABLE public.classroom_consents IS
  'Recording consent by person code. Policy pending; synthetic rows only until it is approved.';
