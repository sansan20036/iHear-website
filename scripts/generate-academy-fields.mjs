import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Academy course templates are the single source of the editable-field list:
// every data-academy-field element is one field, its current text is the default.
// Run with --write after changing a template; the test suite runs the check mode.
export const ACADEMY_TEMPLATES = { en: "academy-site/index.html", zhHant: "academy-site/zh/index.html" };
const output = "data/academy-fields.json";

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, name) => {
    if (/^#x/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (/^#\d+$/.test(name) && name !== "#39") return String.fromCodePoint(Number(name.slice(1)));
    return entities[name.toLowerCase()] ?? whole;
  });
}

const fieldPattern = /<([a-z][a-z0-9]*)\b[^>]*\bdata-academy-field="([^"]+)"[^>]*>((?:[^<]|<br\s*\/?>)*)<\/\1\s*>/gi;

export function extractAcademyFields(html, locale) {
  const blocks = [...html.matchAll(/\bdata-academy-block="([^"]+)"/g)].map(match => match[1]);
  if (new Set(blocks).size !== blocks.length) throw new Error(`${locale}: repeated Academy block`);
  const fields = [];
  for (const [, tag, id, inner] of html.matchAll(fieldPattern)) {
    const lines = inner.split(/<br\s*\/?>/i).map(line => decode(line).replace(/\s+/g, " ").trim());
    // Headings keep their line breaks; paragraphs (including the text around the
    // generated FAQ price list) may gain them; labels stay one line.
    const paragraph = tag.toLowerCase() === "p" || /\.answer(?:Lead|Note)$/.test(id);
    const multiline = lines.length > 1 || paragraph;
    const block = blocks.filter(candidate => id === candidate || id.startsWith(`${candidate}.`))
      .sort((left, right) => right.length - left.length)[0];
    if (!block) throw new Error(`${locale}: field ${id} is outside every Academy block`);
    fields.push({
      id, block, tag: tag.toLowerCase(), kind: multiline ? "multiline" : "single",
      maxLength: paragraph ? 2000 : multiline ? 300 : 200,
      default: lines.join("\n"),
    });
  }
  const ids = fields.map(field => field.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${locale}: repeated Academy field`);
  const opened = (html.match(/\bdata-academy-field="/g) || []).length;
  if (opened !== fields.length) throw new Error(`${locale}: ${opened - fields.length} Academy fields contain markup other than text and <br>`);
  for (const field of fields) if (!field.default) throw new Error(`${locale}: field ${field.id} has no default text`);
  return { blocks: blocks.filter(block => fields.some(field => field.block === block)), fields };
}

export async function academyFieldRegistry(root) {
  const locales = {};
  for (const [locale, file] of Object.entries(ACADEMY_TEMPLATES)) {
    locales[locale] = extractAcademyFields(await readFile(path.join(root, file), "utf8"), locale);
  }
  return { version: 1, locales };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const expected = `${JSON.stringify(await academyFieldRegistry(root), null, 2)}\n`;
  const target = path.join(root, output);
  let actual = "";
  try { actual = await readFile(target, "utf8"); } catch { /* first run */ }
  if (process.argv.includes("--write")) {
    await writeFile(target, expected, "utf8");
    console.log(`Wrote ${output}.`);
  } else if (actual.replace(/\r\n/g, "\n") !== expected) {
    console.error(`${output} is out of date. Run: node scripts/generate-academy-fields.mjs --write`);
    process.exit(1);
  } else {
    console.log(`${output} matches the Academy templates.`);
  }
}
