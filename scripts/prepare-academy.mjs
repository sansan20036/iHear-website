import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Source files remain portable for direct-file and local-server previews.
// Deployed HTML uses absolute paths because Next's clean routes omit a slash.
export async function prepareAcademy(root, publicDir) {
  const base = "/academy/courses";
  const pageRoutes = new Map([
    [`${base}/index.html`, "/academy/en"],
    [`${base}/zh/index.html`, "/academy"],
  ]);
  const destination = path.join(publicDir, "academy", "courses");
  await cp(path.join(root, "academy-site"), destination, { recursive: true });
  for (const file of ["index.html", "zh/index.html"]) {
    const target = path.join(destination, file);
    const html = await readFile(target, "utf8");
    const deployed = html.replace(/\b(href|src)="([^"]*)"/g, (attribute, name, value) => {
      if (!value || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value)) return attribute;
      const resolved = path.posix.join(base, path.posix.dirname(file), value);
      if (!resolved.startsWith(base + "/")) throw new Error(`Academy asset escapes its folder: ${value}`);
      const href = pageRoutes.get(resolved) || resolved;
      return `${name}="${href}"`;
    });
    await writeFile(target, deployed, "utf8");
  }
}
