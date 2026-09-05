import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = new URL(process.env.IHEAR_SNAPSHOT_BASE_URL || "https://www.ihearus.org/");

const pages = [
  "/",
  "/about",
  "/programs",
  "/impact",
  "/team",
  "/submit-bio",
  "/stories",
  "/get-involved",
  "/academy",
  "/donate",
  "/resources",
  "/faq",
  "/contact",
];

const endpoints = [
  "/api/content/get",
  "/api/team-profiles",
  "/api/impact-milestones",
  "/api/site-media",
  "/api/site-metrics",
  "/api/site-theme",
  "/api/live-revisions",
  "/api/site-layout?page=%2F",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function capture(route) {
  const requestedUrl = new URL(route, baseUrl);
  const response = await fetch(requestedUrl, {
    cache: "no-store",
    headers: {
      Accept: "*/*",
      "Cache-Control": "no-cache",
      "User-Agent": "iHear production snapshot/1.0",
    },
    redirect: "follow",
  });
  const body = await response.text();
  return {
    route,
    requestedUrl: requestedUrl.href,
    finalUrl: response.url,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    etag: response.headers.get("etag") || "",
    bodySha256: sha256(body),
    body,
  };
}

const createdAt = new Date().toISOString();
const pageSnapshots = [];
const endpointSnapshots = [];

for (const route of pages) pageSnapshots.push(await capture(route));
for (const route of endpoints) endpointSnapshots.push(await capture(route));

const payload = {
  format: "ihear-production-site-snapshot",
  version: 1,
  createdAt,
  baseUrl: baseUrl.href,
  pages: pageSnapshots,
  endpoints: endpointSnapshots,
};
const snapshot = {
  checksumAlgorithm: "sha256",
  checksum: sha256(JSON.stringify(payload)),
  payload,
};
const timestamp = createdAt.replace(/[-:.]/g, "");
const backupDirectory = path.join(process.cwd(), "backups");
const outputPath = path.join(backupDirectory, `ihear-production-site-${timestamp}.json`);

await mkdir(backupDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});

const unsuccessful = [...pageSnapshots, ...endpointSnapshots]
  .filter((item) => item.status < 200 || item.status >= 300)
  .map((item) => ({ route: item.route, status: item.status }));

console.log(JSON.stringify({
  created: true,
  path: path.relative(process.cwd(), outputPath),
  checksum: snapshot.checksum,
  pages: pageSnapshots.length,
  endpoints: endpointSnapshots.length,
  unsuccessful,
}));
