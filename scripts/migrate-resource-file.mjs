import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrateResourceDocument } from "../lib/resource-topic-model.ts";

// Offline only. No .env loading, database connection, implicit data directory,
// in-place rewrite, or overwrite of an existing destination is permitted.
const args = process.argv.slice(2);
try {
  if (![2, 4].includes(args.length) || args[0] !== "--input" || (args.length === 4 && args[2] !== "--output")) {
    throw new Error("Usage: node --experimental-strip-types scripts/migrate-resource-file.mjs --input source.json [--output new-file.json]");
  }
  const input = path.resolve(args[1]), output = args[3] ? path.resolve(args[3]) : null;
  if (output && input.toLowerCase() === output.toLowerCase()) throw new Error("In-place migration is not allowed; choose a new destination");
  const original = JSON.parse(await readFile(input, "utf8"));
  const document = migrateResourceDocument(original);
  if (output) await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ validated: true, dryRun: !output, schemaVersion: document.schemaVersion, topics: document.topics.length, items: document.items.length, sourceUnchanged: true }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
