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
const clientAssetVersion = "20260817-site-theme-cache-v2";
const themeInitScript = `<script data-site-theme-init>(function(){var a={warm:1,ocean:1,sage:1,lavender:1,slate:1},t="warm";try{var s=localStorage.getItem("ihear:site-theme");if(a[s])t=s}catch(e){}document.documentElement.setAttribute("data-theme",t)})()</script>`;
const themeBootstrapScript = `<script src="/api/site-theme/bootstrap" data-site-theme-bootstrap></script>`;

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
    /\s*<script\s+src=["']\/?assets\/(?:site|auth|live-content|site-theme|inline-edit|impact-milestones|site-metrics|site-media|team-profiles|vendor\/browser-image-compression)\.js(?:\?[^"']*)?["']\s+defer><\/script>\s*/g,
    "\n"
  );
  const withoutThemeHead = withoutExisting
    .replace(/\s*<script\s+data-site-theme-init>[\s\S]*?<\/script>\s*/g, "\n")
    .replace(/\s*<script\s+src=["']\/api\/site-theme\/bootstrap["']\s+data-site-theme-bootstrap><\/script>\s*/g, "\n");

  const withoutManagedStyles = withoutThemeHead.replace(
    /\s*<link\s+rel=["']stylesheet["']\s+href=["']\/?assets\/(?:theme|site|impact-milestones|team-profiles)\.css(?:\?[^"']*)?["']\s*\/?>\s*/g,
    "\n",
  );
  const managedStyles = [
    `  <link rel="stylesheet" href="/assets/theme.css?v=${clientAssetVersion}">`,
    `  <link rel="stylesheet" href="/assets/site.css?v=${clientAssetVersion}">`,
  ];
  if (html.includes("data-impact-milestones")) {
    managedStyles.push(`  <link rel="stylesheet" href="/assets/impact-milestones.css?v=${clientAssetVersion}">`);
  }
  if (html.includes("data-team-")) {
    managedStyles.push(`  <link rel="stylesheet" href="/assets/team-profiles.css?v=${clientAssetVersion}">`);
  }

  const withThemeDefault = withoutManagedStyles.replace(/<html(?![^>]*\bdata-theme=)/i, '<html data-theme="warm"');
  const withThemeHead = withThemeDefault.replace(
    /<head([^>]*)>/i,
    (opening) => `${opening}\n  ${themeInitScript}\n  ${themeBootstrapScript}`,
  );
  const withFavicon = withThemeHead.replace(
    "</head>",
    `  <link rel="icon" href="/favicon.ico" sizes="any">\n${managedStyles.join("\n")}\n</head>`
  );

  const scripts = [
    `  <script src="/assets/site.js?v=${clientAssetVersion}" defer></script>`,
    `  <script src="/assets/auth.js?v=${clientAssetVersion}" defer></script>`,
    `  <script src="/assets/live-content.js?v=${clientAssetVersion}" defer></script>`,
    `  <script src="/assets/site-theme.js?v=${clientAssetVersion}" defer></script>`,
  ];
  if (html.includes("data-site-media-slot") || html.includes("data-site-media-dynamic")) {
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

function occurrences(value, fragment) {
  return value.split(fragment).length - 1;
}

function verifyThemeBuild(html, file) {
  const init = '<script data-site-theme-init>';
  const bootstrap = '<script src="/api/site-theme/bootstrap" data-site-theme-bootstrap></script>';
  const themeCss = '<link rel="stylesheet" href="/assets/theme.css';
  const siteCss = '<link rel="stylesheet" href="/assets/site.css';
  const client = '<script src="/assets/site-theme.js';
  for (const marker of [init, bootstrap, themeCss, siteCss, client]) {
    if (occurrences(html, marker) !== 1) throw new Error(`${file} must contain exactly one ${marker}`);
  }
  if (!/<html\b[^>]*\bdata-theme=["']warm["']/i.test(html)) {
    throw new Error(`${file} is missing the warm no-JavaScript fallback`);
  }
  const positions = [html.indexOf(init), html.indexOf(bootstrap), html.indexOf(themeCss), html.indexOf(siteCss)];
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    throw new Error(`${file} has an invalid theme head order`);
  }
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

for (const file of htmlFiles) {
  verifyThemeBuild(await readFile(path.join(publicDir, file), "utf8"), file);
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
