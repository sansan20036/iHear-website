import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The backup policy for classroom data (H8, 2026-11-07): one switch, data/backup-policy.json, read
// by the weekly backup, the monthly restore drill and the manual encrypted backup
// (restorable-backup/snapshot.ps1, from main). With excludeClassroomData true (H8 option 2) those
// three backups keep the nine classroom tables' structure, constraints, indexes and row level
// security but none of their rows: classroom data is then NOT protected by any of them, and the
// daily backup leaves it out too unless BACKUP_INCLUDE_CLASSROOM=1. It stays false until iHear
// approves option 2, and is changed only by a reviewed commit.
//   node scripts/backup-policy.mjs                    the policy, as JSON
//   node scripts/backup-policy.mjs --pg-dump-option   the pg_dump option it adds, or nothing
//   ... --file <path>                                 another policy file (tests only)
export const BACKUP_POLICY_FILE = "data/backup-policy.json";
export const CLASSROOM_EXCLUSION_OPTION = "--exclude-table-data=public.classroom_*";

export function parseBackupPolicy(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${BACKUP_POLICY_FILE} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "excludeClassroomData" || typeof value.excludeClassroomData !== "boolean") {
    throw new Error(`${BACKUP_POLICY_FILE} must be exactly { "excludeClassroomData": true } or { "excludeClassroomData": false }`);
  }
  return value;
}

export function readBackupPolicy(file = path.join(process.cwd(), BACKUP_POLICY_FILE)) {
  return parseBackupPolicy(readFileSync(file, "utf8"));
}

export const pgDumpOptionFor = (policy) => (policy.excludeClassroomData ? CLASSROOM_EXCLUSION_OPTION : "");

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--file");
  try {
    const policy = readBackupPolicy(at >= 0 ? path.resolve(args[at + 1]) : undefined);
    if (args.includes("--pg-dump-option")) process.stdout.write(pgDumpOptionFor(policy));
    else console.log(JSON.stringify({ ...policy, classroomRows: policy.excludeClassroomData ? "left out of the weekly, monthly and manual backups, which then do not protect them" : "included in the weekly, monthly and manual backups" }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
