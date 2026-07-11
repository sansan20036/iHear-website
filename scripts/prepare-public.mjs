import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const publicDir = path.join(root, "public");

const htmlFiles = [
  "index.html",
  "about.html",
  "programs.html",
  "impact.html",
  "team.html",
  "submit-bio.html",
  "stories.html",
  "get-involved.html",
  "academy.html",
  "donate.html",
  "resources.html",
  "faq.html",
  "contact.html",
];

const passthroughFiles = ["robots.txt", "sitemap.xml", "CNAME"];

async function copyDir(source, target) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

function withClientScripts(html) {
  const withoutExisting = html.replace(
    /\s*<script\s+src=["']\/?assets\/(?:auth|inline-edit)\.js["']\s+defer><\/script>\s*/g,
    "\n"
  );

  return withoutExisting.replace(
    "</body>",
    [
      '  <script src="/assets/auth.js" defer></script>',
      '  <script src="/assets/inline-edit.js" defer></script>',
      "</body>",
    ].join("\n")
  );
}

await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
await copyDir(path.join(root, "assets"), path.join(publicDir, "assets"));

for (const file of htmlFiles) {
  const sourcePath = path.join(root, file);
  const targetPath = path.join(publicDir, file);
  const html = await readFile(sourcePath, "utf8");
  await writeFile(targetPath, withClientScripts(html), "utf8");
}

for (const file of passthroughFiles) {
  const sourcePath = path.join(root, file);
  try {
    const info = await stat(sourcePath);
    if (info.isFile()) {
      await copyFile(sourcePath, path.join(publicDir, file));
    }
  } catch {
    // Optional deployment files may not exist in every environment.
  }
}

console.log(`Prepared ${htmlFiles.length} HTML pages in public/.`);
