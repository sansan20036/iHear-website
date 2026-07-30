import { createHash } from "node:crypto";

export function normalizeMigrationContents(contents) {
  return contents.replace(/\r\n?/g, "\n");
}

export function migrationChecksum(contents) {
  return createHash("sha256")
    .update(normalizeMigrationContents(contents))
    .digest("hex");
}
