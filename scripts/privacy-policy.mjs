// The privacy policy page (2026-11-10). privacy.html is a TEMPLATE: its two marked regions are
// empty in the repository and are filled at build time from three texts (en, zh-Hant, zh-Hans) and a
// decision registry. The policy is a DRAFT until iHear approves it (data/privacy-policy.json).
//
// F-06, option B: the drafts never enter the public repository. They live outside it (the folder
// named by IHEAR_PRIVACY_SOURCES; by default %LOCALAPPDATA%iHear-privacy-drafts) and only iHear's
// approved texts are ever committed, to content/privacy-policy. A draft found inside the repository
// fails the build; --guard checks every file that would be committed. Tests use tests/fixtures.
//
// Fail closed: a draft is rendered only when IHEAR_PRIVACY_PREVIEW=1 and no hosting platform's marker
// is set. Any other environment (Vercel preview or production, an unknown host, a missing setting)
// leaves the page, its footer link and its sitemap entry out, and the server answers 404
// (lib/privacy-policy.ts, lib/public-page.ts, scripts/prepare-public.mjs).
// An approved policy may contain no open decision, and its approval record must name who approved
// it, when, where the written approval is kept, and the SHA-256 of the exact three texts and the
// decision registry it approved: any later change to them blocks the build until it is approved again.
//
//   node scripts/privacy-policy.mjs --check        the template is clean; the configured texts render consistently
//   node scripts/privacy-policy.mjs --fingerprint  the SHA-256 values an approval record must carry (writes nothing)
//   node scripts/privacy-policy.mjs --guard        no draft content in any file that would be committed
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const POLICY_LANGUAGES = [
  {
    lang: "en", file: "en.md", title: "Privacy Policy", label: "Pending iHear decision", colon: ": ",
    pending: /\[PENDING (PD-\d\d)(?:: ([^\]]*))?\]/g,
    draftNotice: "Draft — not yet approved by iHear. This page is shared for review only: it is not in effect and is not a commitment by iHear. Parts marked “Pending iHear decision” have not been decided.",
  },
  {
    lang: "zh-Hant", file: "zh-Hant.md", title: "隱私權政策", label: "待 iHear 決定", colon: "：",
    pending: /【待決 (PD-\d\d)(?:：([^】]*))?】/g,
    draftNotice: "草案：尚未經 iHear 核准。本頁僅供審閱，尚未生效，也不代表 iHear 的承諾。標示「待 iHear 決定」的部分尚未決定。",
  },
  {
    lang: "zh-Hans", file: "zh-Hans.md", title: "隐私政策", label: "待 iHear 决定", colon: "：",
    pending: /【待定 (PD-\d\d)(?:：([^】]*))?】/g,
    draftNotice: "草案：尚未经 iHear 核准。本页仅供审阅，尚未生效，也不代表 iHear 的承诺。标示“待 iHear 决定”的部分尚未决定。",
  },
];
const POLICY_START = "<!-- privacy-policy:start -->";
const POLICY_END = "<!-- privacy-policy:end -->";
const ROBOTS_START = "<!-- privacy-robots:start -->";
const ROBOTS_END = "<!-- privacy-robots:end -->";
export const PRIVACY_URL = "https://www.ihearus.org/privacy";

const escapeHtml = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = value => String(value).replace(/\*\*|`/g, "");

function basicInline(text) {
  let html = escapeHtml(text).replace(/&lt;br&gt;/g, "<br>");
  const codes = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000`; });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/https:\/\/[A-Za-z0-9./?=%#_~-]+/g, url => {
    const clean = url.replace(/[.]+$/, "");
    return `<a href="${clean}">${clean}</a>${url.slice(clean.length)}`;
  });
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
}

function inline(text, language, markers) {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(language.pending)) {
    html += basicInline(text.slice(last, match.index));
    markers.push(match[1]);
    html += `<mark class="policy-pending" data-decision="${match[1]}"><strong class="policy-pending-label">${language.label} ${match[1]}</strong>${match[2] ? `${language.colon}${basicInline(match[2])}` : ""}</mark>`;
    last = match.index + match[0].length;
  }
  if (/【待[決定]|\[PENDING/.test(text.replace(language.pending, ""))) throw new Error(`An open decision without a PD id: ${text.slice(0, 60)}`);
  return html + basicInline(text.slice(last));
}

/** A small Markdown subset (headings, paragraphs, lists, tables, notes) to accessible HTML. */
export function renderPolicyMarkdown(markdown, language) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const markers = [];
  const headings = [];
  const out = [];
  let section = language.title;
  const cells = row => row.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim() || line.startsWith("# ")) { i++; continue; }
    const heading = /^(#{2,3}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const number = /^(\d+(?:\.\d+)?)\.?\s/.exec(heading[2])?.[1];
      if (!number) throw new Error(`Policy headings are numbered: ${heading[2]}`);
      headings.push(`${level}:${number}`);
      section = plain(heading[2]);
      out.push(`<h${level} id="privacy-${language.lang}-${number.replace(".", "-")}">${inline(heading[2], language, markers)}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      if (rows.length < 3 || !/^\|[\s:|-]+\|$/.test(rows[1].trim())) throw new Error(`A table needs a header and a separator row (${section})`);
      const head = cells(rows[0]);
      if (head.some(cell => !cell)) throw new Error(`Every table column needs a header (${section})`);
      const body = rows.slice(2).map(cells);
      out.push(`<div class="policy-table-wrap" role="region" tabindex="0" aria-label="${escapeHtml(section)}"><table>`
        + `<thead><tr>${head.map(cell => `<th scope="col">${inline(cell, language, markers)}</th>`).join("")}</tr></thead>`
        + `<tbody>${body.map(row => `<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${inline(cell, language, markers)}</th>` : `<td>${inline(cell, language, markers)}</td>`)).join("")}</tr>`).join("")}</tbody>`
        + "</table></div>");
      continue;
    }
    if (line.startsWith(">")) {
      const note = [];
      while (i < lines.length && lines[i].startsWith(">")) note.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<div class="policy-callout" role="note">${note.filter(Boolean).map(text => `<p>${inline(text, language, markers)}</p>`).join("")}</div>`);
      continue;
    }
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^( {2})?- /.test(lines[i])) {
        const nested = lines[i].startsWith("  - ");
        const text = lines[i].replace(/^ {0,2}- /, "");
        if (nested) {
          if (!items.length) throw new Error(`A nested item needs a parent (${section})`);
          items.at(-1).children.push(text);
        } else items.push({ text, children: [] });
        i++;
      }
      out.push(`<ul>${items.map(item => `<li>${inline(item.text, language, markers)}${item.children.length ? `<ul>${item.children.map(child => `<li>${inline(child, language, markers)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ul>`);
      continue;
    }
    out.push(`<p>${inline(line, language, markers)}</p>`);
    i++;
  }
  return { html: out.join("\n"), markers, headings };
}

// Where the three texts and the decision registry come from (F-06, option B: drafts never enter the
// public repository):
//   IHEAR_PRIVACY_SOURCES  a folder OUTSIDE the repository (the private drafts) or the test fixture;
//   content/privacy-policy only iHear's approved texts, once approved (a draft there is refused);
//   neither                no texts: the page is left out of the build.
export const FIXTURE_DIR = "tests/fixtures/privacy-policy";
export const REPOSITORY_SOURCES = "content/privacy-policy";
export const DEFAULT_PRIVATE_DRAFTS = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "iHear-privacy-drafts") : null;

export function resolvePolicySources(root = process.cwd(), env = process.env) {
  if (env.IHEAR_PRIVACY_SOURCES) {
    const dir = path.resolve(root, env.IHEAR_PRIVACY_SOURCES);
    const fixture = path.resolve(root, FIXTURE_DIR);
    const relative = path.relative(root, dir);
    const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (inside && dir !== fixture) throw new Error("IHEAR_PRIVACY_SOURCES may name only a folder outside the repository, or the test fixture");
    return { dir, origin: dir === fixture ? "fixture" : "private" };
  }
  const repository = path.join(root, REPOSITORY_SOURCES);
  return existsSync(repository) ? { dir: repository, origin: "repository" } : null;
}

export async function readPolicyInputs(root = process.cwd(), env = process.env) {
  const state = JSON.parse(await readFile(path.join(root, "data", "privacy-policy.json"), "utf8"));
  const location = resolvePolicySources(root, env);
  if (!location) return { state, sources: null, decisions: null, decisionsText: undefined, origin: null };
  const sources = {};
  for (const language of POLICY_LANGUAGES) sources[language.lang] = await readFile(path.join(location.dir, language.file), "utf8");
  const decisionsText = await readFile(path.join(location.dir, "decisions.json"), "utf8");
  return { sources, state, decisions: JSON.parse(decisionsText), decisionsText, origin: location.origin };
}

// Line endings do not count: a checkout may turn LF into CRLF.
const sha256 = text => createHash("sha256").update(String(text).replace(/\r\n/g, "\n"), "utf8").digest("hex");

/** What an approval is bound to: the three texts and the decision registry, as they are now. */
export function policyFingerprint({ sources, decisionsText }) {
  return {
    sources: Object.fromEntries(POLICY_LANGUAGES.map(language => [language.lang, sha256(sources[language.lang])])),
    decisions: sha256(decisionsText),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const filled = value => typeof value === "string" && value.trim().length > 0;

/** Problems with the approval record of an approved policy (none for a consistent one). */
function approvalProblems(state, inputs) {
  const problems = [];
  const record = state.approvalRecord;
  if (!record || typeof record !== "object") return ["An approved policy needs a record of iHear's approval"];
  if (!filled(record.approvedBy)) problems.push("The approval record must name who approved the policy");
  if (!DATE.test(record.approvedOn || "")) problems.push("The approval record needs the approval date (YYYY-MM-DD)");
  if (!filled(record.reference)) problems.push("The approval record must say where the written approval is kept");
  if (DATE.test(record.approvedOn || "") && DATE.test(state.effectiveDate || "") && record.approvedOn > state.effectiveDate) problems.push("The policy cannot take effect before it was approved");
  if (inputs.sources && inputs.decisionsText !== undefined) {
    const now = policyFingerprint(inputs);
    for (const language of POLICY_LANGUAGES) {
      if (record.sources?.[language.lang] !== now.sources[language.lang]) problems.push(`The ${language.lang} text is not the one approved: it must be approved again`);
    }
    if (record.decisions !== now.decisions) problems.push("The decision registry is not the one approved: it must be approved again");
  } else problems.push("The approval cannot be checked without the policy texts and the decision registry");
  return problems;
}

/** The generated parts of the page: the robots meta (drafts only) and the three articles. */
export function renderPolicyRegions({ sources, state }) {
  const draft = state.status !== "approved";
  const articles = POLICY_LANGUAGES.map(language => {
    const { html, markers, headings } = renderPolicyMarkdown(sources[language.lang], language);
    const notice = draft ? `<p class="policy-draft-notice" role="note">${escapeHtml(language.draftNotice)}</p>\n` : "";
    return {
      lang: language.lang, markers, headings,
      html: `<article class="policy-body" lang="${language.lang}" data-policy-lang="${language.lang}" aria-labelledby="privacy-${language.lang}-title">\n<h1 id="privacy-${language.lang}-title">${language.title}</h1>\n${notice}${html}\n</article>`,
    };
  });
  return {
    robots: `${ROBOTS_START}${draft ? '<meta name="robots" content="noindex">' : ""}${ROBOTS_END}`,
    policy: `${POLICY_START}\n${articles.map(article => article.html).join("\n")}\n${POLICY_END}`,
    articles,
  };
}

function regionBounds(html, start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from < 0 || to < from || html.indexOf(start, from + 1) >= 0) throw new Error(`privacy.html needs exactly one ${start} … ${end} region`);
  return { from, to };
}

function replaceRegion(html, start, end, replacement) {
  const { from, to } = regionBounds(html, start, end);
  return html.slice(0, from) + replacement + html.slice(to + end.length);
}

export function applyPolicyRegions(template, regions) {
  // The generated parts follow the template's own line endings.
  const eol = template.includes("\r\n") ? "\r\n" : "\n";
  const policy = regions.policy.replace(/\r?\n/g, eol);
  return replaceRegion(replaceRegion(template, ROBOTS_START, ROBOTS_END, regions.robots), POLICY_START, POLICY_END, policy);
}

// What only rendered policy content carries; none of it may be in the committed template.
const RENDERED = [/class="policy-draft-notice"/, /<article class="policy-body"/, /data-decision="PD-/, /<meta name="robots"/];

/** The committed privacy.html is a template: both regions empty, no policy content (F-06). */
export function templateProblems(template) {
  const problems = [];
  for (const [start, end] of [[ROBOTS_START, ROBOTS_END], [POLICY_START, POLICY_END]]) {
    try {
      const { from, to } = regionBounds(template, start, end);
      if (template.slice(from + start.length, to).trim()) problems.push(`privacy.html: the ${start} region must be empty in the repository`);
    } catch (error) { problems.push(error.message); }
  }
  for (const pattern of RENDERED) if (pattern.test(template)) problems.push(`privacy.html carries rendered policy content (${pattern})`);
  return problems;
}

/** Problems with a rendered privacy page, as messages; empty when it is consistent. */
export function policyProblems(html, inputs) {
  const { state, decisions } = inputs;
  const problems = [];
  const draft = state.status !== "approved";
  if (!["draft", "approved"].includes(state.status)) problems.push(`Unknown policy status ${state.status}`);
  if (draft && inputs.origin === "repository") problems.push(`Draft texts must stay outside the repository: ${REPOSITORY_SOURCES} holds only approved texts`);
  if (!draft && inputs.origin !== "repository") problems.push(`An approved policy is built only from the texts committed in ${REPOSITORY_SOURCES}`);
  const articles = [...html.matchAll(/<article class="policy-body" lang="([^"]+)" data-policy-lang="\1"[^>]*>([\s\S]*?)<\/article>/g)];
  if (JSON.stringify(articles.map(match => match[1])) !== JSON.stringify(POLICY_LANGUAGES.map(language => language.lang))) problems.push("The page needs exactly the en, zh-Hant and zh-Hans articles, in that order");
  const registry = new Map((decisions?.decisions || []).map(decision => [decision.id, decision]));
  const sequences = articles.map(match => [...match[2].matchAll(/data-decision="(PD-\d\d)"/g)].map(found => found[1]));
  const structures = articles.map(match => [...match[2].matchAll(/<h([23]) id="privacy-[^"]+-(\d+(?:-\d+)?)"/g)].map(found => `${found[1]}:${found[2]}`));
  for (let index = 1; index < articles.length; index++) {
    if (JSON.stringify(sequences[index]) !== JSON.stringify(sequences[0])) problems.push(`${articles[index][1]} names different open decisions from en`);
    if (JSON.stringify(structures[index]) !== JSON.stringify(structures[0])) problems.push(`${articles[index][1]} has a different heading structure from en`);
  }
  for (const id of new Set(sequences.flat())) {
    const decision = registry.get(id);
    if (!decision) problems.push(`${id} is not in the decision registry`);
    else if (decision.status !== "pending") problems.push(`${id} is ${decision.status} but the page still shows it as open`);
  }
  for (const decision of registry.values()) {
    if (decision.status === "pending" && !(sequences[0] || []).includes(decision.id)) problems.push(`${decision.id} is open but the page does not show it`);
  }
  for (const match of articles) {
    const notice = match[2].includes('class="policy-draft-notice"');
    if (draft && !notice) problems.push(`${match[1]}: a draft must say it is a draft`);
    if (!draft && notice) problems.push(`${match[1]}: an approved policy must not carry the draft notice`);
    if ((match[2].match(/<h1\b/g) || []).length !== 1) problems.push(`${match[1]}: one h1 per language`);
  }
  const noindex = /<meta name="robots" content="noindex">/.test(html);
  if (draft && !noindex) problems.push("A draft must not be indexed (robots noindex)");
  if (draft && state.approvalRecord) problems.push("A draft cannot carry an approval record");
  if (!draft) {
    if (noindex) problems.push("An approved policy must be indexable");
    if (sequences.flat().length) problems.push("An approved policy may contain no open decision");
    if (!DATE.test(state.effectiveDate || "")) problems.push("An approved policy needs an effective date");
    problems.push(...approvalProblems(state, inputs));
    const open = [...registry.values()].filter(decision => decision.status === "pending").map(decision => decision.id);
    if (open.length) problems.push(`Decisions still open: ${open.join(", ")}`);
    for (const decision of [...registry.values(), ...(decisions?.oauthDecisions || [])].filter(item => item.status === "approved")) {
      if (!filled(decision.decision) || !filled(decision.decidedBy) || !DATE.test(decision.decidedOn || "") || !filled(decision.evidence)) {
        problems.push(`${decision.id} is marked approved without the decision, who decided, the date and where it is recorded`);
      }
    }
  }
  if (/給 iHear 內部|Internal note for iHear|给 iHear 内部|planning\/|\bH8\b/.test(html)) problems.push("Internal notes must not reach the page");
  return problems;
}

// Fail closed: an unapproved draft is shown only where someone asked for it on purpose
// (IHEAR_PRIVACY_PREVIEW=1) AND nothing says this is a hosted deployment. A missing setting, an
// unknown value or any hosting platform's marker keeps it out.
export const HOSTING_MARKERS = ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "NETLIFY", "CONTEXT", "AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV", "K_SERVICE", "FUNCTION_TARGET", "RENDER", "FLY_APP_NAME", "RAILWAY_ENVIRONMENT", "DYNO", "WEBSITE_SITE_NAME", "CF_PAGES"];
export const hostedEnvironment = (env = process.env) => HOSTING_MARKERS.some(name => Boolean(env[name]));
export const draftPreviewEnabled = (env = process.env) => env.IHEAR_PRIVACY_PREVIEW === "1" && !hostedEnvironment(env);

/** Shown in this build? Once approved, everywhere; a draft only in an explicit local preview. */
export const privacyPolicyShown = (state, env = process.env) => state.status === "approved" || draftPreviewEnabled(env);

export function applyPrivacyLink(html, shown) {
  return shown ? html : html.replace(/[ \t]*<!-- privacy-link:start -->[\s\S]*?<!-- privacy-link:end -->(?:\r?\n)?/g, "");
}

export function sitemapWithPrivacy(xml, shown) {
  return shown ? xml : xml.replace(/[ \t]*<url><loc>https:\/\/www\.ihearus\.org\/privacy<\/loc><\/url>(?:\r?\n)?/, "");
}

const MARKER = /【待[決定] PD-\d\d|\[PENDING PD-\d\d/;

/**
 * Before a commit (F-06): the files that would enter the public history must hold no draft. Checks
 * each candidate for the drafts' decision markers, rendered decision marks, draft texts inside the
 * repository, and (when the private drafts are at hand) any line of them.
 */
export function commitCandidateProblems(files, { state, privateTexts = [] }) {
  const problems = [];
  const lines = new Set(privateTexts.flatMap(text => text.replace(/\r\n/g, "\n").split("\n").map(line => line.trim()).filter(line => line.length >= 30 && !/^\|[\s:|-]+\|$/.test(line))));
  for (const { path: file, text } of files) {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.startsWith(`${FIXTURE_DIR}/`)) continue;
    if (state.status !== "approved" && normalized.startsWith(`${REPOSITORY_SOURCES}/`)) problems.push(`${normalized}: draft texts must stay outside the repository`);
    if (MARKER.test(text)) problems.push(`${normalized}: carries a draft decision marker`);
    if (!normalized.startsWith("tests/") && /data-decision="PD-\d\d"/.test(text)) problems.push(`${normalized}: carries a rendered open decision`);
    for (const line of lines) if (text.includes(line)) { problems.push(`${normalized}: carries text from the private drafts`); break; }
  }
  return problems;
}

async function main() {
  const root = process.cwd();
  const mode = process.argv[2];
  if (!["--check", "--fingerprint", "--guard"].includes(mode)) throw new Error("Use --check, --fingerprint or --guard");
  const inputs = await readPolicyInputs(root);
  if (mode === "--guard") {
    const { execFileSync } = await import("node:child_process");
    const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    const files = [];
    for (const file of listed) {
      if (!existsSync(path.join(root, file))) continue;
      const buffer = await readFile(path.join(root, file));
      if (buffer.includes(0)) continue; // binary
      files.push({ path: file, text: buffer.toString("utf8") });
    }
    const privateDir = process.env.IHEAR_PRIVACY_SOURCES || DEFAULT_PRIVATE_DRAFTS;
    const privateTexts = [];
    if (privateDir && existsSync(privateDir) && resolvePolicySources(root, { IHEAR_PRIVACY_SOURCES: privateDir }).origin === "private") {
      for (const name of [...POLICY_LANGUAGES.map(language => language.file), "decisions.json"]) if (existsSync(path.join(privateDir, name))) privateTexts.push(await readFile(path.join(privateDir, name), "utf8"));
    }
    const problems = commitCandidateProblems(files, { state: inputs.state, privateTexts });
    console.log(`checked ${files.length} commit candidates${privateTexts.length ? ` against ${privateTexts.length} private draft files` : " (private drafts not available here)"}`);
    if (problems.length) { console.error(`Draft content would enter the public history:\n- ${problems.join("\n- ")}`); process.exitCode = 1; }
    else console.log("no draft content in the commit candidates");
    return;
  }
  const template = await readFile(path.join(root, "privacy.html"), "utf8");
  const problems = templateProblems(template);
  if (!inputs.sources) {
    if (problems.length) throw new Error(`The privacy template is not clean:\n- ${problems.join("\n- ")}`);
    console.log(`privacy.html template is clean (${inputs.state.status}); no policy texts configured, so a build leaves the page out`);
    return;
  }
  if (mode === "--fingerprint") {
    // For the person recording iHear's approval: the values the record must carry. Nothing is written.
    console.log(JSON.stringify({ origin: inputs.origin, ...policyFingerprint(inputs) }, null, 2));
    return;
  }
  problems.push(...policyProblems(applyPolicyRegions(template, renderPolicyRegions(inputs)), inputs));
  if (problems.length) throw new Error(`The privacy page is not consistent:\n- ${problems.join("\n- ")}`);
  console.log(`privacy.html template is clean and the ${inputs.origin} texts render consistently (${inputs.state.status})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
