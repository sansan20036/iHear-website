// Migration 028's nine classroom tables as the backup, its checks and the audit treat them
// (D1, 2026-11-07). Columns in the migration's order; key = the primary key; json = JSONB columns.
// The names are constants used to build SQL: never take them from a backup file.

export const CLASSROOM_MIGRATION = "028";
export const CLASSROOM_BACKUP_VERSION = 11;

export const CLASSROOM_TABLES = [
  { name: "classroom_lessons", key: ["id"], unique: [["code"]], columns: ["id", "code", "lesson_date", "starts_at", "ends_at", "cancelled", "created_by", "created_at", "updated_at"] },
  { name: "classroom_participants", key: ["lesson_id", "participant_id"], unique: [["lesson_id", "code"]], columns: ["lesson_id", "participant_id", "code", "role", "staff_email", "join_key_hash"] },
  { name: "classroom_consents", key: ["person_code"], columns: ["person_code", "status", "version", "granted_at", "withdrawn_at", "expires_at", "synthetic", "recorded_by", "updated_at"] },
  { name: "classroom_staff_notices", key: ["person_code"], columns: ["person_code", "version", "acknowledged_at", "recorded_by"] },
  { name: "classroom_join_tokens", key: ["token_hash"], columns: ["token_hash", "lesson_id", "participant_id", "issued_at", "expires_at"] },
  { name: "classroom_events", key: ["key"], json: ["data"], columns: ["key", "lesson_id", "type", "source", "occurred_at", "received_at", "data"] },
  { name: "classroom_jobs", key: ["id"], columns: ["id", "type", "lesson_id", "provider_file_id", "status", "attempts", "lease_owner", "lease_until", "lease_version", "available_at", "error", "blocked_reason", "created_at", "updated_at"] },
  { name: "classroom_recording_files", key: ["provider_file_id"], columns: ["provider_file_id", "provider", "lesson_id", "provider_session_id", "kind", "extension", "size", "md5", "status", "hold", "recording_start", "recording_end", "planned_name", "upload_session_uri", "uploaded_bytes", "drive_file_id", "filed_at", "created_at", "updated_at"] },
  { name: "classroom_anomalies", key: ["lesson_id", "code"], columns: ["lesson_id", "code", "severity", "first_seen_at", "opened_at", "last_seen_at", "resolved_at", "acknowledged_by", "acknowledged_at", "note"] },
];
export const CLASSROOM_TABLE_NAMES = CLASSROOM_TABLES.map((table) => table.name);

// What the audit expects once 028 is recorded.
export const CLASSROOM_CONSTRAINTS = [
  "classroom_lessons_pkey", "classroom_lessons_code_key", "classroom_lessons_time_order",
  "classroom_participants_pkey", "classroom_participants_lesson_id_code_key", "classroom_participants_identity", "classroom_participants_lesson_id_fkey",
  "classroom_consents_pkey", "classroom_consents_state",
  "classroom_staff_notices_pkey",
  "classroom_join_tokens_pkey", "classroom_join_tokens_order", "classroom_join_tokens_lesson_id_fkey",
  "classroom_events_pkey", "classroom_events_data_bounded",
  "classroom_jobs_pkey",
  "classroom_recording_files_pkey",
  "classroom_anomalies_pkey", "classroom_anomalies_seen_order", "classroom_anomalies_acknowledged", "classroom_anomalies_lesson_id_fkey",
];
export const CLASSROOM_INDEXES = [
  "classroom_lessons_starts_at_idx", "classroom_participants_join_key_idx", "classroom_join_tokens_lesson_idx",
  "classroom_events_lesson_idx", "classroom_jobs_due_idx", "classroom_recording_files_lesson_idx",
];

const HASH = /^[0-9a-f]{64}$/;
const trimmed = (value) => (typeof value === "string" ? value.trim() : value);

// The classroom part of a backup's tables: every table, and in each row exactly the table's
// columns; unique keys; participants, tokens and anomalies of a lesson in the backup; a 64-character
// hash for each student link and none for a tutor (no personal key is ever stored). Throws with the
// first problem found.
export function validateClassroomBackup(tables) {
  for (const table of CLASSROOM_TABLES) {
    const rows = tables[table.name];
    if (!Array.isArray(rows)) throw new Error(`Backup is missing ${table.name}.`);
    const expected = [...table.columns].sort().join(",");
    for (const row of rows) {
      if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== expected) {
        throw new Error(`Backup table ${table.name} has a row with unexpected columns.`);
      }
    }
    for (const columns of [table.key, ...(table.unique || [])]) {
      const seen = new Set();
      for (const row of rows) {
        const value = columns.map((column) => String(trimmed(row[column]))).join("\u0000");
        if (seen.has(value)) throw new Error(`Duplicate key in backup table ${table.name}: ${columns.join(", ")}`);
        seen.add(value);
      }
    }
  }
  const lessonIds = new Set(tables.classroom_lessons.map((row) => row.id));
  for (const name of ["classroom_participants", "classroom_join_tokens", "classroom_anomalies"]) {
    if (tables[name].some((row) => !lessonIds.has(row.lesson_id))) throw new Error(`Backup table ${name} refers to a lesson that is not in the backup.`);
  }
  const studentHashes = new Set();
  for (const row of tables.classroom_participants) {
    const hash = trimmed(row.join_key_hash);
    if (row.role === "tutor") {
      if (hash != null || !row.staff_email) throw new Error("Backup has a tutor with a key hash or without a sign-in email.");
    } else if (row.role === "student") {
      if (row.staff_email != null || typeof hash !== "string" || !HASH.test(hash)) throw new Error("Backup has a student link that is not a 64-character hash.");
      if (studentHashes.has(hash)) throw new Error("Duplicate key in backup table classroom_participants: join_key_hash");
      studentHashes.add(hash);
    } else {
      throw new Error("Backup has a participant with an unknown role.");
    }
  }
  if (tables.classroom_join_tokens.some((row) => !HASH.test(String(trimmed(row.token_hash))))) {
    throw new Error("Backup has a join token that is not a 64-character hash.");
  }
}

export function classroomRowCounts(tables) {
  return Object.fromEntries(CLASSROOM_TABLE_NAMES.map((name) => [name, tables[name].length]));
}
