import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// Compare complete, checksummed snapshots; never connect to or modify the database.
const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("Pass the before and after backup paths.");
async function snapshot(file) {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.checksumAlgorithm !== "sha256" || value.checksum !== createHash("sha256").update(JSON.stringify(value.payload)).digest("hex")) throw new Error("Backup checksum failed");
  return value.payload.tables;
}
const before = await snapshot(beforePath), after = await snapshot(afterPath);
if (!isDeepStrictEqual(Object.keys(before).sort(), Object.keys(after).sort())) throw new Error("Table inventory changed");
const verified = [];
for (const [name, rows] of Object.entries(before)) {
  let current = after[name];
  if (name === "team_profiles") {
    current = current.map(row => {
      const prior = rows.find(item => item.id === row.id);
      if (!prior) throw new Error("Unexpected new team profile");
      if (typeof row.is_hidden !== "boolean" || row.is_hidden !== (prior.is_hidden ?? false)) throw new Error("Team visibility unexpectedly changed");
      if (Object.hasOwn(prior, "is_hidden")) return row;
      return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "is_hidden"));
    });
  }
  if (name === "schema_migrations") {
    const added = current.filter(row => !rows.some(prior => prior.version === row.version));
    if (added.some(row => row.version !== "022" || row.name !== "022_team_profile_visibility.sql") || added.length > 1) throw new Error("Unexpected migration");
    current = current.filter(row => rows.some(prior => prior.version === row.version));
  }
  if (!isDeepStrictEqual(rows, current)) throw new Error(`${name}: existing data changed`);
  verified.push({ table: name, rows: rows.length });
}
console.log(JSON.stringify({ preserved: true, onlyAllowedChanges: ["team_profiles.is_hidden default false", "migration 022"], verified }, null, 2));
