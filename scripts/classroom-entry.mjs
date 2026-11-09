import { readFile } from "node:fs/promises";
import path from "node:path";

// The online classroom's release switch (D2, 2026-11-07). One file decides both the home page
// entries, kept or left out when the pages are built, and the header's entries in assets/auth.js.
// Off, the built home page has no entry at all. It is turned on only after the staff acceptance on
// the live site (S3), in a commit of its own, and turned off again by rolling that deployment back.
export const CLASSROOM_ENTRY_FILE = "data/classroom-entry.json";
export const CLASSROOM_SWITCH_LINE = "const CLASSROOM_ENTRY_RELEASED = false;";

const MARKER = /<!-- classroom-entry:(start|end) -->/g;
const BLOCK = /[ \t]*<!-- classroom-entry:start -->[\s\S]*?<!-- classroom-entry:end -->[ \t]*(?:\r?\n)?/g;
const CLASSROOM_LINK = /\bhref=["']\/classroom(?:[/?#"'])/i;

export async function readClassroomEntrySwitch(root) {
  const value = JSON.parse(await readFile(path.join(root, CLASSROOM_ENTRY_FILE), "utf8"));
  if (!value || typeof value !== "object" || Object.keys(value).join() !== "released" || typeof value.released !== "boolean") {
    throw new Error(`${CLASSROOM_ENTRY_FILE} must be exactly { "released": true } or { "released": false }`);
  }
  return value.released;
}

// A page as built: switched on, the entries stay and only their markers go; switched off, each
// marked block goes with its line. A classroom link outside the markers would stay in a page that
// is switched off, so that stops the build.
export function applyClassroomEntry(html, released) {
  const markers = [...html.matchAll(MARKER)].map(match => match[1]);
  if (markers.length % 2 || markers.some((marker, index) => marker !== (index % 2 ? "end" : "start"))) {
    throw new Error("A classroom entry block is not closed, or is inside another");
  }
  if (released) return html.replace(MARKER, "");
  const result = html.replace(BLOCK, "");
  if (CLASSROOM_LINK.test(result) || result.includes("data-classroom-entry")) {
    throw new Error("A classroom entry outside the classroom-entry markers would stay in a page switched off");
  }
  return result;
}

// The header script as built, its switch set from the same file.
export function applyClassroomSwitch(script, released) {
  const count = script.split(CLASSROOM_SWITCH_LINE).length - 1;
  if (count !== 1) throw new Error(`assets/auth.js must hold the classroom switch line exactly once (found ${count})`);
  return released ? script.replace(CLASSROOM_SWITCH_LINE, "const CLASSROOM_ENTRY_RELEASED = true;") : script;
}
