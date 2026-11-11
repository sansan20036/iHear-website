// After `next build`: what each server function carries, from Next's output file traces
// (.next/server/app/**/*.js.nft.json), which is what Vercel packages for that function.
//
// Fails when a function carries files that only a whole-project trace adds. That happens when a
// file read has a path the build cannot work out (Turbopack: "Dynamic filesystem access causes
// tracing of the whole project"). In P4-B1 one such read in lib/classroom-vendors/tencent-lcic.ts
// made every classroom function, the Zoom webhook among them, carry 27 MB (public/ media, tests,
// docs) instead of about 4 MB. It also fails when a classroom function passes its size budget.
//
//   node scripts/check-function-traces.mjs [site folder]     (exit 1 on any problem)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Project files no server code reads at run time: only a whole-project trace brings them in.
export const NEVER_TRACED = [/^tests\//, /^docs\//, /^postman\//, /^scripts\//, /^planning\//, /^\.github\//, /^package-lock\.json$/, /^README\.md$/];
// The media routes serve files of public/ by name (lib/site-media-storage.ts), so their traces
// carry public/ on purpose. No other function may.
export const PUBLIC_ALLOWED = /^api\/(site-media|media-galleries)\//;
export const CLASSROOM = /^(api\/classroom|api\/admin\/classrooms|api\/recordings|classroom|admin\/classrooms)\//;
// About twice what a classroom function carries today (3.8 to 4.0 MB, 2026-11-11).
export const CLASSROOM_BUDGET_BYTES = 8 * 1024 * 1024;

function* traceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* traceFiles(full);
    else if (entry.name.endsWith(".js.nft.json")) yield full;
  }
}

/** Every function of a built site: its route, the project-relative files it carries, their bytes. */
export function functionTraces(site) {
  const appDir = path.join(site, ".next", "server", "app");
  if (!existsSync(appDir)) throw new Error(`No build found at ${appDir}: run npm run build first`);
  const functions = [];
  for (const traceFile of traceFiles(appDir)) {
    const fnFile = traceFile.slice(0, -".nft.json".length);
    const route = path.relative(appDir, fnFile).split(path.sep).join("/");
    const listed = JSON.parse(readFileSync(traceFile, "utf8")).files || [];
    const files = [];
    let bytes = 0;
    for (const absolute of new Set([fnFile, ...listed.map((file) => path.resolve(path.dirname(traceFile), file))])) {
      if (!existsSync(absolute)) continue;
      const stat = statSync(absolute);
      if (!stat.isFile()) continue;
      bytes += stat.size;
      files.push(path.relative(site, absolute).split(path.sep).join("/"));
    }
    functions.push({ route, files, bytes });
  }
  return functions;
}

/** What is wrong with these functions; an empty list when nothing is. */
export function traceProblems(functions, { classroomBudgetBytes = CLASSROOM_BUDGET_BYTES } = {}) {
  const problems = [];
  for (const fn of functions) {
    const unexpected = fn.files.filter((file) => NEVER_TRACED.some((pattern) => pattern.test(file)) || (file.startsWith("public/") && !PUBLIC_ALLOWED.test(fn.route)));
    if (unexpected.length) problems.push(`${fn.route} carries ${unexpected.length} file(s) no server code reads, a sign of whole-project tracing (first: ${unexpected.slice(0, 3).join(", ")})`);
    if (CLASSROOM.test(fn.route) && fn.bytes > classroomBudgetBytes) problems.push(`${fn.route} carries ${(fn.bytes / 1048576).toFixed(1)} MB, over the classroom budget of ${(classroomBudgetBytes / 1048576).toFixed(1)} MB`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const site = path.resolve(process.argv[2] || process.cwd());
  const functions = functionTraces(site);
  const problems = traceProblems(functions);
  const classroom = functions.filter((fn) => CLASSROOM.test(fn.route));
  const largest = classroom.reduce((top, fn) => (fn.bytes > (top?.bytes ?? -1) ? fn : top), null);
  console.log(`${functions.length} functions checked; ${classroom.length} classroom functions, largest ${largest ? `${largest.route} ${(largest.bytes / 1048576).toFixed(1)} MB` : "none"}`);
  for (const problem of problems) console.error(`FAIL ${problem}`);
  if (!functions.length) console.error("FAIL no function traces found");
  process.exit(problems.length || !functions.length ? 1 : 0);
}
