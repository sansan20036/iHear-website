import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// P3-Auth (2026-11-08): the Zoom session token is signed by the server only, and the SDK secret
// never reaches a browser. A source check: every file marked "use client", and everything it
// imports (type-only imports are erased at build time and do not count), must stay clear of the
// modules that hold or use the secrets, of the server's own identity and storage modules, and of
// the environment variables that carry the secrets. A built bundle is not inspected here.
const root = process.cwd();
const SOURCE = /\.(?:ts|tsx|js|mjs)$/;
const SERVER_ONLY = [
  "lib/classroom-vendors/", "lib/classroom-provider.ts", "lib/classroom-service.ts", "lib/classroom-store.ts",
  "lib/classroom-drive.ts", "lib/admins.ts", "lib/admin-auth.ts", "lib/rate-limit.ts", "auth.js",
  "tools/recording-pathway/classroom/eligibility.mjs",
];
const SECRET_NAMES = /ZOOM_VIDEO_SDK_(?:SECRET|API_SECRET|WEBHOOK_SECRET)|CLASSROOM_SYNTHETIC_SECRET|CLASSROOM_WEBHOOK_SECRET|TENCENTCLOUD_SECRET_KEY|LCIC_CALLBACK_KEY|AUTH_SECRET|signSessionToken|createHmac/;

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? files(full) : SOURCE.test(name) ? [full] : [];
  });
}

const relative = (file) => path.relative(root, file).split(path.sep).join("/");

// Imports that bring code along: `import … from`, `export … from`, `import "…"` and `import("…")`,
// except `import type` and `export type`.
function importsOf(file) {
  const source = readFileSync(file, "utf8");
  const found = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']/g)) {
    if (!match[2]) found.push(match[3]);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) found.push(match[1]);
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]);
  return found.filter((specifier) => specifier.startsWith("."));
}

function resolve(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function reachable(entry) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    for (const specifier of importsOf(file)) {
      const target = resolve(file, specifier);
      if (target && !seen.has(target) && SOURCE.test(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen];
}

const clientFiles = [...files(path.join(root, "app")), ...files(path.join(root, "lib"))]
  .filter((file) => /^\s*["']use client["']/.test(readFileSync(file, "utf8")));

describe("the browser never gets the classroom secrets", () => {
  test("the classroom's browser pages are among the files checked", () => {
    const names = clientFiles.map(relative);
    for (const page of ["app/classroom/[lessonId]/classroom-entry.tsx", "app/classroom/classroom-home.tsx", "app/admin/classrooms/page.tsx"]) {
      expect(names).toContain(page);
    }
  });

  test("no browser code imports a module that holds, signs with or stores behind a secret", () => {
    const problems = [];
    for (const entry of clientFiles) {
      for (const file of reachable(entry).map(relative)) {
        if (SERVER_ONLY.some((name) => file === name || file.startsWith(name))) problems.push(`${relative(entry)} -> ${file}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("no browser code names a secret, signs anything or reads a secret's environment variable", () => {
    const problems = [];
    for (const entry of clientFiles) {
      for (const file of reachable(entry)) {
        const source = readFileSync(file, "utf8");
        if (SECRET_NAMES.test(source)) problems.push(relative(file));
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  test("no secret is ever given a NEXT_PUBLIC_ name, which would put it in the browser bundle", () => {
    const offenders = [...files(path.join(root, "app")), ...files(path.join(root, "lib")), ...files(path.join(root, "tools", "classroom-trial"))]
      .filter((file) => /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|ZOOM|LCIC|TENCENT|WEBHOOK|CRON|AUTH)/.test(readFileSync(file, "utf8")))
      .map(relative);
    expect(offenders).toEqual([]);
  });
});
