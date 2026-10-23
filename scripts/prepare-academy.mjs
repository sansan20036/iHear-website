import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// HTML templates stay private: the request-time routes supply the published
// prices and text. Static assets keep their existing public URLs.
export async function prepareAcademy(root, publicDir) {
  const base = "/academy/courses";
  // A versioned entry bypasses browser-cached redirects from the brief period
  // when course URLs redirected to /academy and /academy/en. Canonicals stay clean.
  const pageRoutes = new Map([
    [`${base}/index.html`, base],
    [`${base}/zh/index.html`, `${base}/zh`],
  ]);
  const destination = path.join(publicDir, "academy", "courses");
  const privateDir = path.join(root, ".private", "academy");
  await mkdir(path.join(privateDir, "zh"), { recursive: true });
  await cp(path.join(root, "academy-site"), destination, {
    recursive: true,
    filter: source => !source.endsWith(".html"),
  });
  for (const file of ["index.html", "zh/index.html"]) {
    // Remove only the two obsolete public HTML files from previous builds.
    await rm(path.join(destination, file), { force: true });
    const html = await readFile(path.join(root, "academy-site", file), "utf8");
    // Deployed HTML uses absolute paths because Next's clean routes omit a slash.
    const deployed = html.replace(/\b(href|src)="([^"]*)"/g, (attribute, name, value) => {
      if (!value || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value)) return attribute;
      const resolved = new URL(value.replace(/&amp;/g, "&"), `https://academy.invalid${base}/${file}`);
      if (!resolved.pathname.startsWith(base + "/")) throw new Error(`Academy asset escapes its folder: ${value}`);
      const page = pageRoutes.get(resolved.pathname);
      if (page && !resolved.searchParams.has("entry")) resolved.searchParams.set("entry", "official");
      const href = (page || resolved.pathname) + resolved.search + resolved.hash;
      return `${name}="${href.replace(/&/g, "&amp;")}"`;
    });
    await writeFile(path.join(privateDir, file), deployed, "utf8");
  }
}
