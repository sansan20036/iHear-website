import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

function checksum(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertUnique(rows, makeKey, tableName) {
  const values = new Set();
  for (const row of rows) {
    const key = makeKey(row);
    if (!key || values.has(key)) {
      throw new Error(`Invalid or duplicate key in ${tableName}: ${String(key)}`);
    }
    values.add(key);
  }
}

async function resolveBackupPath() {
  if (process.argv[2]) return path.resolve(process.cwd(), process.argv[2]);

  const backupDirectory = path.join(process.cwd(), "backups");
  const files = (await readdir(backupDirectory))
    .filter((fileName) => /^ihear-baseline-.*\.json$/i.test(fileName))
    .sort((left, right) => right.localeCompare(left));
  if (!files[0]) throw new Error("No application backup was found.");
  return path.join(backupDirectory, files[0]);
}

try {
  const backupPath = await resolveBackupPath();
  const backup = JSON.parse(await readFile(backupPath, "utf8"));

  if (backup.checksumAlgorithm !== "sha256") {
    throw new Error("Unsupported checksum algorithm.");
  }
  if (
    backup.payload?.format !== "ihear-postgres-backup" ||
    ![1, 2, 3].includes(backup.payload?.version)
  ) {
    throw new Error("Unsupported backup format.");
  }
  if (backup.checksum !== checksum(backup.payload)) {
    throw new Error("Backup checksum does not match.");
  }

  const tables = backup.payload.tables || {};
  const required = [
    "impact_milestones",
    "impact_milestone_settings",
    "content_overrides",
    "schema_migrations",
  ];
  if (backup.payload.version >= 2) required.push("team_people", "team_profiles");
  if (backup.payload.version >= 3) required.push("localized_content_overrides");
  for (const tableName of required) {
    if (!Array.isArray(tables[tableName])) {
      throw new Error(`Backup is missing ${tableName}.`);
    }
  }

  assertUnique(tables.impact_milestones, (row) => row.id, "impact_milestones");
  assertUnique(tables.impact_milestone_settings, (row) => row.key, "impact_milestone_settings");
  assertUnique(tables.content_overrides, (row) => `${row.page}\u0000${row.key}`, "content_overrides");
  if (backup.payload.version >= 3) {
    assertUnique(
      tables.localized_content_overrides,
      (row) => `${row.page}\u0000${row.key}\u0000${row.locale}`,
      "localized_content_overrides",
    );
  }
  assertUnique(tables.schema_migrations, (row) => row.version, "schema_migrations");
  if (backup.payload.version >= 2) {
    assertUnique(tables.team_people, (row) => row.id, "team_people");
    assertUnique(tables.team_profiles, (row) => row.id, "team_profiles");
  }

  const requiredMigration = backup.payload.version >= 3 ? "010" : "009";
  if (!tables.schema_migrations.some((row) => String(row.version) === requiredMigration)) {
    throw new Error(`Backup does not include migration ${requiredMigration}.`);
  }

  console.log(
    JSON.stringify({
      verified: true,
      path: path.relative(process.cwd(), backupPath),
      version: backup.payload.version,
      checksum: backup.checksum,
      createdAt: backup.payload.createdAt,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      verified: false,
      message: error instanceof Error ? error.message : "Backup verification failed",
    }),
  );
  process.exitCode = 1;
}
