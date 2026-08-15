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

const passthroughFiles = ["robots.txt", "sitemap.xml", "CNAME", "favicon.ico"];
const clientAssetVersion = "20260816-site-media-v1";

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

function withClientScripts(html, file) {
  const withoutCloudflareBeacon = html.replace(
    /\s*<script\b[^>]*\bsrc=["']https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js[^"']*["'][^>]*><\/script>\s*/gi,
    "\n"
  );
  const withoutExisting = withoutCloudflareBeacon.replace(
    /\s*<script\s+src=["']\/?assets\/(?:site|auth|live-content|inline-edit|impact-milestones|site-metrics|site-media|team-profiles|vendor\/browser-image-compression)\.js(?:\?[^"']*)?["']\s+defer><\/script>\s*/g,
    "\n"
  );

  const withoutManagedStyles = withoutExisting.replace(
    /\s*<link\s+rel=["']stylesheet["']\s+href=["']\/?assets\/(?:site|impact-milestones|team-profiles)\.css(?:\?[^"']*)?["']\s*\/?>\s*/g,
    "\n",
  );
  const managedStyles = [
    `  <link rel="stylesheet" href="/assets/site.css?v=${clientAssetVersion}">`,
  ];
  if (html.includes("data-impact-milestones")) {
    managedStyles.push(`  <link rel="stylesheet" href="/assets/impact-milestones.css?v=${clientAssetVersion}">`);
  }
  if (html.includes("data-team-")) {
    managedStyles.push(`  <link rel="stylesheet" href="/assets/team-profiles.css?v=${clientAssetVersion}">`);
  }

  const withFavicon = withoutManagedStyles.replace(
    "</head>",
    `  <link rel="icon" href="/favicon.ico" sizes="any">\n${managedStyles.join("\n")}\n</head>`
  );

  const scripts = [
    `  <script src="/assets/site.js?v=${clientAssetVersion}" defer></script>`,
    `  <script src="/assets/auth.js?v=${clientAssetVersion}" defer></script>`,
    `  <script src="/assets/live-content.js?v=${clientAssetVersion}" defer></script>`,
  ];
  if (html.includes("data-site-media-slot")) {
    scripts.push(`  <script src="/assets/vendor/browser-image-compression.js?v=${clientAssetVersion}" defer></script>`);
    scripts.push(`  <script src="/assets/site-media.js?v=${clientAssetVersion}" defer></script>`);
  }
  if (html.includes("data-impact-milestones")) {
    scripts.push(`  <script src="/assets/impact-milestones.js?v=${clientAssetVersion}" defer></script>`);
  }
  if (file === "index.html") {
    scripts.push(`  <script src="/assets/site-metrics.js?v=${clientAssetVersion}" defer></script>`);
  }
  if (html.includes("data-team-")) {
    scripts.push(`  <script src="/assets/team-profiles.js?v=${clientAssetVersion}" defer></script>`);
  }
  scripts.push(`  <script src="/assets/inline-edit.js?v=${clientAssetVersion}" defer></script>`);

  return withFavicon.replace(
    "</body>",
    [
      ...scripts,
      "</body>",
    ].join("\n")
  );
}

await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
await copyDir(path.join(root, "assets"), path.join(publicDir, "assets"));
await mkdir(path.join(publicDir, "assets", "vendor"), { recursive: true });
await copyFile(
  path.join(root, "node_modules", "browser-image-compression", "dist", "browser-image-compression.js"),
  path.join(publicDir, "assets", "vendor", "browser-image-compression.js"),
);

for (const file of htmlFiles) {
  const sourcePath = path.join(root, file);
  const targetPath = path.join(publicDir, file);
  const html = await readFile(sourcePath, "utf8");
  await writeFile(targetPath, withClientScripts(html, file), "utf8");
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
