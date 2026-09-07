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
const dynamicI18nKeys = new Set(["latest_label", "latest_period", "latest_headline", "latest_description", "latest_link", "stat_asof", "stat_countries_sub"]);
const clientAssetVersion = "20260907-avatar-background-v1";
const themeInitScript = `<script data-site-theme-init>(function(){var a={warm:1,ocean:1,sage:1,lavender:1,slate:1},t="warm";try{var s=localStorage.getItem("ihear:site-theme");if(a[s])t=s}catch(e){}document.documentElement.setAttribute("data-theme",t)})()</script>`;
const themeBootstrapScript = `<script src="/api/site-theme/bootstrap" data-site-theme-bootstrap></script>`;
function layoutBootstrapScript(file) {
  const route = file === "index.html" ? "/" : `/${file.replace(/\.html$/, "")}`;
  return `<script src="/api/site-layout/bootstrap?page=${encodeURIComponent(route)}" data-site-layout-bootstrap></script>`;
}

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
    /\s*<script\s+src=["']\/?assets\/(?:site|auth|live-content|site-theme|site-layout|inline-edit|impact-milestones|site-metrics|site-media|team-profiles|avatar-background-removal|avatar-cropper|vendor\/browser-image-compression)\.js(?:\?[^"']*)?["']\s+defer><\/script>\s*/g,
    "\n"
  );
  const withoutThemeHead = withoutExisting
    .replace(/\s*<script\s+data-site-theme-init>[\s\S]*?<\/script>\s*/g, "\n")
    .replace(/\s*<script\s+src=["']\/api\/site-theme\/bootstrap["']\s+data-site-theme-bootstrap><\/script>\s*/g, "\n");
  const withoutLayoutHead = withoutThemeHead.replace(/\s*<script\s+src=["']\/api\/site-layout\/bootstrap\?page=[^"']+["']\s+data-site-layout-bootstrap><\/script>\s*/g, "\n");

  const withoutManagedStyles = withoutLayoutHead.replace(
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
    (opening) => `${opening}\n  ${themeInitScript}\n  ${themeBootstrapScript}\n  ${layoutBootstrapScript(file)}`,
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
    `  <script src="/assets/site-layout.js?v=${clientAssetVersion}" defer></script>`,
  ];
  if (html.includes("data-site-media-slot") || html.includes("data-site-media-dynamic")) {
    scripts.push(`  <script src="/assets/vendor/browser-image-compression.js?v=${clientAssetVersion}" defer></script>`);
    scripts.push(`  <script src="/assets/avatar-background-removal.js?v=${clientAssetVersion}" defer></script>`);
    scripts.push(`  <script src="/assets/avatar-cropper.js?v=${clientAssetVersion}" defer></script>`);
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
  const layoutBootstrap = '<script src="/api/site-layout/bootstrap?page=';
  const layoutClient = '<script src="/assets/site-layout.js';
  for (const marker of [init, bootstrap, layoutBootstrap, themeCss, siteCss, client, layoutClient]) {
    if (occurrences(html, marker) !== 1) throw new Error(`${file} must contain exactly one ${marker}`);
  }
  if (!/<html\b[^>]*\bdata-theme=["']warm["']/i.test(html)) {
    throw new Error(`${file} is missing the warm no-JavaScript fallback`);
  }
  const positions = [html.indexOf(init), html.indexOf(bootstrap), html.indexOf(layoutBootstrap), html.indexOf(themeCss), html.indexOf(siteCss)];
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    throw new Error(`${file} has an invalid theme head order`);
  }
}

function verifyMediaBuild(html, file) {
  const hasMedia = html.includes("data-site-media-slot") || html.includes("data-site-media-dynamic");
  const markers = [
    '<script src="/assets/avatar-background-removal.js',
    '<script src="/assets/avatar-cropper.js',
    '<script src="/assets/site-media.js',
  ];
  for (const marker of markers) {
    const expected = hasMedia ? 1 : 0;
    if (occurrences(html, marker) !== expected) {
      throw new Error(`${file} must contain exactly ${expected} ${marker}`);
    }
  }
}

function verifyContentBuild(html, file, identities) {
  const page = file === "index.html" ? "/" : `/${file.replace(/\.html$/, "")}`;
  const pattern = /<[^>]+\bdata-i18n=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    if (dynamicI18nKeys.has(match[1])) continue;
    const key = /\bdata-editable-content=["']([^"']+)["']/i.exec(match[0])?.[1];
    const scope = /\bdata-editable-page=["']([^"']+)["']/i.exec(match[0])?.[1] || page;
    if (!key) throw new Error(`${file} has an unmarked public data-i18n slot: ${match[1]}`);
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(key)) throw new Error(`${file} has a non-semantic content key: ${key}`);
    if (!identities.has(`${scope}\u0000${key}`)) throw new Error(`${file} has no three-language catalog seed for ${scope} / ${key}`);
  }
}

const sourceHtmlFiles = (await readdir(root)).filter((file) => file.endsWith(".html")).sort();
if (JSON.stringify(sourceHtmlFiles) !== JSON.stringify([...htmlFiles].sort())) {
  throw new Error(`Expected exactly the 13 managed HTML pages; found: ${sourceHtmlFiles.join(", ")}`);
}

await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
await copyDir(path.join(root, "assets"), path.join(publicDir, "assets"));
await mkdir(path.join(publicDir, "assets", "vendor"), { recursive: true });
await copyFile(
  path.join(root, "node_modules", "browser-image-compression", "dist", "browser-image-compression.js"),
  path.join(publicDir, "assets", "vendor", "browser-image-compression.js"),
);
const avatarSegmentationDir = path.join(publicDir, "assets", "vendor", "avatar-segmentation");
await mkdir(avatarSegmentationDir, { recursive: true });
for (const file of [
  "selfie_segmentation.js",
  "selfie_segmentation.binarypb",
  "selfie_segmentation.tflite",
  "selfie_segmentation_solution_simd_wasm_bin.js",
  "selfie_segmentation_solution_simd_wasm_bin.wasm",
  "selfie_segmentation_solution_wasm_bin.js",
  "selfie_segmentation_solution_wasm_bin.wasm",
]) {
  await copyFile(
    path.join(root, "node_modules", "@mediapipe", "selfie_segmentation", file),
    path.join(avatarSegmentationDir, file),
  );
}
const contentCatalog = JSON.parse(await readFile(path.join(root, "data", "content-slots.json"), "utf8"));
const catalogIdentities = new Set();
for (const slot of contentCatalog.slots || []) {
  if (!slot.page || !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(slot.key || "") || !slot.values?.en || !slot.values?.zhHant || !slot.values?.zhHans) {
    throw new Error(`Invalid content catalog slot: ${slot?.page || "?"} / ${slot?.key || "?"}`);
  }
  const identity = `${slot.page}\u0000${slot.key}`;
  if (catalogIdentities.has(identity)) throw new Error(`Duplicate content catalog slot: ${slot.page} / ${slot.key}`);
  catalogIdentities.add(identity);
}
await writeFile(
  path.join(publicDir, "assets", "content-slots.json"),
  JSON.stringify({ version: 1, slots: contentCatalog.slots.map(({ page, key, mode, maxLength, values }) => ({ page, key, mode, maxLength, values })) }),
  "utf8",
);

const layoutCatalog = JSON.parse(await readFile(path.join(root, "data", "layout-slots.json"), "utf8"));
if (layoutCatalog.version !== 2 || !Array.isArray(layoutCatalog.pages)) {
  throw new Error("Layout metadata must use version 2 and include localized page names");
}
const localizedFields = ["en", "zhHant", "zhHans"];
const assertLocalized = (value, identity, field) => {
  if (!value || localizedFields.some((locale) => typeof value[locale] !== "string" || !value[locale].trim())) {
    throw new Error(`Invalid ${field} metadata for ${identity}`);
  }
};
for (const page of layoutCatalog.pages) assertLocalized(page.label, page.page, "page label");
for (const section of layoutCatalog.sections || []) {
  assertLocalized(section.label, section.key, "section label");
  assertLocalized(section.description, section.key, "section description");
  if (section.previewSelector !== `[data-layout-section="${section.key}"]`) throw new Error(`Unsafe section selector for ${section.key}`);
}
for (const group of layoutCatalog.groups || []) {
  assertLocalized(group.label, group.key, "group label");
  assertLocalized(group.description, group.key, "group description");
  if (group.previewSelector !== `[data-layout-group="${group.key}"]`) throw new Error(`Unsafe group selector for ${group.key}`);
  for (const item of group.items || []) {
    if (!item.id || item.id.includes("\"") || item.id.includes("'")) throw new Error(`Unsafe layout item ID for ${group.key}`);
    assertLocalized(item.label, `${group.key}.${item.id}`, "item label");
    assertLocalized(item.description, `${group.key}.${item.id}`, "item description");
  }
}
for (const link of layoutCatalog.links || []) {
  assertLocalized(link.label, link.key, "link label");
  assertLocalized(link.description, link.key, "link description");
  assertLocalized(link.locations, link.key, "link locations");
  if (link.previewSelector !== `[data-layout-link="${link.key}"]`) throw new Error(`Unsafe link selector for ${link.key}`);
}
await writeFile(path.join(publicDir, "assets", "layout-slots.json"), JSON.stringify(layoutCatalog), "utf8");

for (const file of htmlFiles) {
  const sourcePath = path.join(root, file);
  const targetPath = path.join(publicDir, file);
  const html = await readFile(sourcePath, "utf8");
  verifyContentBuild(html, file, catalogIdentities);
  await writeFile(targetPath, withClientScripts(html, file), "utf8");
}

for (const file of htmlFiles) {
  const html = await readFile(path.join(publicDir, file), "utf8");
  verifyThemeBuild(html, file);
  verifyMediaBuild(html, file);
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
