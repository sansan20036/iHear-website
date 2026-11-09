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

// Version 12 (P3-Multi, 2026-11-09): the classroom part follows the classroom structure the
// database has, level by level: 028 (one-to-one lessons, the nine tables above), 029 (blocks: a
// Lobby and teaching rooms; two tables and new columns on lessons and participants) and 030
// (programs and courses; two tables and new columns on blocks). A backup states its levels
// (payload.classroomSchema); version 11 means 028 alone. Nothing unknown is ever passed over: a
// column, a table or a level the tools do not know stops the backup, the check or the restore.
export const CLASSROOM_LEVELS = ["028", "029", "030"];
export const CLASSROOM_BACKUP_VERSION_BLOCKS = 12;
const EXTENSIONS = {
  "029": {
    columns: { classroom_lessons: ["block_id", "room_kind", "room_label"], classroom_participants: ["member_id", "active", "seat"] },
    tables: [
      { name: "classroom_blocks", key: ["id"], unique: [["code"]], columns: ["id", "code", "lesson_date", "starts_at", "ends_at", "cancelled", "version", "created_by", "created_at", "updated_at"] },
      { name: "classroom_block_members", key: ["block_id", "member_id"], unique: [["block_id", "code"], ["member_id"]], columns: ["block_id", "member_id", "code", "role", "english_name", "staff_email", "join_key_hash"] },
    ],
  },
  "030": {
    columns: { classroom_blocks: ["course_id", "source_key"] },
    tables: [
      { name: "classroom_programs", key: ["id"], unique: [["code"]], columns: ["id", "code", "name", "archived", "created_by", "created_at", "updated_at"] },
      { name: "classroom_courses", key: ["id"], unique: [["code"]], columns: ["id", "program_id", "code", "name", "time_zone", "cancelled", "created_by", "created_at", "updated_at"] },
    ],
  },
};
// Restore order: every table after the ones it refers to.
const ORDER = ["classroom_programs", "classroom_courses", "classroom_blocks", "classroom_block_members", ...CLASSROOM_TABLE_NAMES];

/** The levels as stated, checked: 028 first, then 029, then 030, nothing else and nothing skipped. */
export function classroomLevels(levels) {
  const list = levels == null ? ["028"] : levels;
  if (!Array.isArray(list) || !list.length || list.some((level, index) => level !== CLASSROOM_LEVELS[index])) {
    throw new Error("Backup states classroom levels the tools do not know.");
  }
  return list;
}

/** Every classroom table of these levels with its columns, in restore order. */
export function classroomTablesFor(levels = ["028"]) {
  const known = classroomLevels(levels);
  const tables = new Map(CLASSROOM_TABLES.map((table) => [table.name, { ...table, columns: [...table.columns] }]));
  for (const level of known.slice(1)) {
    for (const table of EXTENSIONS[level].tables) tables.set(table.name, { ...table, columns: [...table.columns] });
    for (const [name, columns] of Object.entries(EXTENSIONS[level].columns)) tables.get(name).columns.push(...columns);
  }
  return ORDER.filter((name) => tables.has(name)).map((name) => tables.get(name));
}
export const classroomTableNamesFor = (levels) => classroomTablesFor(levels).map((table) => table.name);

/** The classroom levels a database has, from its tables (029 and 030 are drafts outside the runner). */
export async function classroomLevelsOf(sql) {
  const [row] = await sql`
    SELECT to_regclass('public.classroom_lessons') IS NOT NULL AS lessons,
      to_regclass('public.classroom_blocks') IS NOT NULL AS blocks,
      to_regclass('public.classroom_programs') IS NOT NULL AS programs
  `;
  if (!row.lessons) return [];
  if (!row.blocks) return ["028"];
  return row.programs ? ["028", "029", "030"] : ["028", "029"];
}

/** The backup version for a classroom part of these levels: 11 for 028 alone, 12 once 029 is there. */
export const classroomBackupVersion = (levels) => (classroomLevels(levels).length > 1 ? CLASSROOM_BACKUP_VERSION_BLOCKS : CLASSROOM_BACKUP_VERSION);

const HASH = /^[0-9a-f]{64}$/;
// A personal link with its key (…#k=… or …?k=…) must never be in a backup, whatever the field.
const LINK_WITH_KEY = /[#?&]k=[A-Za-z0-9_-]{20,}/;
const trimmed = (value) => (typeof value === "string" ? value.trim() : value);

// The classroom part of a backup's tables for its levels: every table and no other classroom table;
// in each row exactly the table's columns; unique keys; every reference inside the backup; a
// 64-character hash for each personal link and none for staff (no personal key is ever stored);
// no link with its key anywhere. Throws with the first problem found, naming no value.
export function validateClassroomBackup(tables, levels = ["028"]) {
  const definitions = classroomTablesFor(levels);
  const names = new Set(definitions.map((table) => table.name));
  const unknown = Object.keys(tables).filter((name) => name.startsWith("classroom_") && !names.has(name));
  if (unknown.length) throw new Error(`Backup has a classroom table its levels do not have: ${unknown.sort().join(", ")}.`);
  for (const table of definitions) {
    const rows = tables[table.name];
    if (!Array.isArray(rows)) throw new Error(`Backup is missing ${table.name}.`);
    const expected = [...table.columns].sort().join(",");
    for (const row of rows) {
      if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== expected) {
        throw new Error(`Backup table ${table.name} has a row with unexpected columns.`);
      }
      if (LINK_WITH_KEY.test(JSON.stringify(row))) throw new Error(`Backup table ${table.name} holds a personal link with its key.`);
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
  const blocks = names.has("classroom_blocks");
  const lessonIds = new Set(tables.classroom_lessons.map((row) => row.id));
  for (const name of ["classroom_participants", "classroom_join_tokens", "classroom_anomalies"]) {
    if (tables[name].some((row) => !lessonIds.has(row.lesson_id))) throw new Error(`Backup table ${name} refers to a lesson that is not in the backup.`);
  }
  const studentHashes = new Set();
  const remember = (hash, where) => {
    if (studentHashes.has(hash)) throw new Error(`Duplicate key in backup table ${where}: join_key_hash`);
    studentHashes.add(hash);
  };
  for (const row of tables.classroom_participants) {
    const hash = trimmed(row.join_key_hash);
    // A block's seat (029): who the person is lives on the block's member, never on the seat.
    if (blocks && row.member_id != null) {
      if (hash != null || row.staff_email != null || row.seat == null) throw new Error("Backup has a block seat with a key, an e-mail or no seat.");
      continue;
    }
    if (row.role === "tutor") {
      if (hash != null || !row.staff_email) throw new Error("Backup has a tutor with a key hash or without a sign-in email.");
    } else if (row.role === "student") {
      if (row.staff_email != null || typeof hash !== "string" || !HASH.test(hash)) throw new Error("Backup has a student link that is not a 64-character hash.");
      remember(hash, "classroom_participants");
    } else {
      throw new Error("Backup has a participant with an unknown role.");
    }
  }
  if (tables.classroom_join_tokens.some((row) => !HASH.test(String(trimmed(row.token_hash))))) {
    throw new Error("Backup has a join token that is not a 64-character hash.");
  }
  if (blocks) {
    const blockIds = new Set(tables.classroom_blocks.map((row) => row.id));
    const memberIds = new Set(tables.classroom_block_members.map((row) => row.member_id));
    if (tables.classroom_block_members.some((row) => !blockIds.has(row.block_id))) throw new Error("Backup table classroom_block_members refers to a block that is not in the backup.");
    if (tables.classroom_lessons.some((row) => row.block_id != null && !blockIds.has(row.block_id))) throw new Error("Backup table classroom_lessons refers to a block that is not in the backup.");
    if (tables.classroom_participants.some((row) => row.member_id != null && !memberIds.has(row.member_id))) throw new Error("Backup table classroom_participants refers to a block member that is not in the backup.");
    for (const id of blockIds) {
      if (tables.classroom_lessons.filter((row) => row.block_id === id && row.room_kind === "lobby").length !== 1) throw new Error("Backup has a block without exactly one Lobby.");
    }
    for (const row of tables.classroom_block_members) {
      const hash = trimmed(row.join_key_hash);
      if (row.role === "student") {
        if (row.staff_email != null || typeof hash !== "string" || !HASH.test(hash)) throw new Error("Backup has a block student whose link is not a 64-character hash.");
        remember(hash, "classroom_block_members");
      } else if (hash != null || !row.staff_email) {
        throw new Error("Backup has block staff with a key hash or without a sign-in email.");
      }
    }
  }
  if (names.has("classroom_programs")) {
    const programIds = new Set(tables.classroom_programs.map((row) => row.id));
    const courseIds = new Set(tables.classroom_courses.map((row) => row.id));
    if (tables.classroom_courses.some((row) => !programIds.has(row.program_id))) throw new Error("Backup table classroom_courses refers to a program that is not in the backup.");
    if (tables.classroom_blocks.some((row) => row.course_id != null && !courseIds.has(row.course_id))) throw new Error("Backup table classroom_blocks refers to a course that is not in the backup.");
    if (tables.classroom_blocks.some((row) => row.source_key != null && row.course_id == null)) throw new Error("Backup has an imported block without its course.");
  }
}

export function classroomRowCounts(tables, levels = ["028"]) {
  return Object.fromEntries(classroomTableNamesFor(levels).map((name) => [name, tables[name].length]));
}
