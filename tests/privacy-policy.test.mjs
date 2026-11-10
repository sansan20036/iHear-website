import { afterEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The privacy policy page (2026-11-10). privacy.html is a template whose regions are filled at build
// time; the draft texts stay OUTSIDE the public repository (F-06, option B) and only iHear's approved
// texts may ever be committed. A draft is shown only in an explicit local preview (fail closed).
// Everything here runs on the test fixture (tests/fixtures/privacy-policy), which holds no policy
// content; the checks of the real drafts run only where the private drafts are at hand.
const {
  FIXTURE_DIR, HOSTING_MARKERS, POLICY_LANGUAGES, applyPolicyRegions, applyPrivacyLink, commitCandidateProblems,
  policyFingerprint, policyProblems, privacyPolicyShown, readPolicyInputs, renderPolicyMarkdown, renderPolicyRegions,
  resolvePolicySources, sitemapWithPrivacy, templateProblems,
} = await import('../scripts/privacy-policy.mjs');
const root = path.resolve('.');
const template = await readFile('privacy.html', 'utf8');
const fixture = await readPolicyInputs(root, { IHEAR_PRIVACY_SOURCES: FIXTURE_DIR });
const rendered = applyPolicyRegions(template, renderPolicyRegions(fixture));
const articlesOf = html => Object.fromEntries([...html.matchAll(/<article class="policy-body" lang="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(match => [match[1], match[2]]));
const TEMPLATES = ['index.html', 'about.html', 'programs.html', 'impact.html', 'team.html', 'submit-bio.html', 'stories.html', 'get-involved.html', 'academy.html', 'donate.html', 'resources.html', 'faq.html', 'contact.html', 'events.html', 'privacy.html'];
const PRIVATE_DIR = process.env.IHEAR_PRIVACY_SOURCES && !path.resolve(process.env.IHEAR_PRIVACY_SOURCES).startsWith(root)
  ? process.env.IHEAR_PRIVACY_SOURCES
  : process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'iHear-privacy-drafts');
const havePrivateDrafts = Boolean(PRIVATE_DIR && existsSync(path.join(PRIVATE_DIR, 'decisions.json')));

describe('F-06: no policy content in the repository', () => {
  test('privacy.html is a clean template and the repository holds no policy texts', () => {
    expect(templateProblems(template)).toEqual([]);
    expect(template).not.toMatch(/policy-draft-notice|data-decision|<article class="policy-body"/);
    expect(existsSync('content/privacy-policy')).toBe(false);
    expect(fixture.state.status).toBe('draft');
    expect(fixture.state.approvalRecord).toBeNull();
  });

  test('a template that carries rendered content is refused', () => {
    expect(templateProblems(rendered)).toEqual(expect.arrayContaining(['privacy.html: the <!-- privacy-policy:start --> region must be empty in the repository']));
  });

  test('texts are read only from outside the repository, the fixture, or (approved only) content/privacy-policy', () => {
    expect(resolvePolicySources(root, {})).toBeNull();
    expect(resolvePolicySources(root, { IHEAR_PRIVACY_SOURCES: FIXTURE_DIR })).toMatchObject({ origin: 'fixture' });
    expect(resolvePolicySources(root, { IHEAR_PRIVACY_SOURCES: path.join(os.tmpdir(), 'drafts') })).toMatchObject({ origin: 'private' });
    for (const inside of ['tests', 'content/privacy-policy', 'data', '.']) {
      expect(() => resolvePolicySources(root, { IHEAR_PRIVACY_SOURCES: inside }), inside).toThrow(/outside the repository/);
    }
    // A draft committed into the repository fails the build; an approved policy must come from there.
    expect(policyProblems(rendered, { ...fixture, origin: 'repository' })).toContain('Draft texts must stay outside the repository: content/privacy-policy holds only approved texts');
  });

  test('the commit guard finds drafts, decision marks and private text; the fixture is exempt', () => {
    const state = { status: 'draft' };
    const files = [
      { path: 'tests/fixtures/privacy-policy/en.md', text: `[PENDING ${'PD'}-01: fixture]` },
      { path: 'content/privacy-policy/en.md', text: 'anything' },
      { path: 'docs/notes.md', text: `see 【待決 ${'PD'}-07：something】` },
      { path: 'privacy.html', text: '<mark data-decision="PD-03">' },
      { path: 'README.md', text: 'This sentence is copied from the private draft text.' },
      { path: 'lib/clean.ts', text: 'nothing to see' },
    ];
    expect(commitCandidateProblems(files, { state, privateTexts: ['# Title\nThis sentence is copied from the private draft text.\n'] })).toEqual([
      'content/privacy-policy/en.md: draft texts must stay outside the repository',
      'docs/notes.md: carries a draft decision marker',
      'privacy.html: carries a rendered open decision',
      'README.md: carries text from the private drafts',
    ]);
  });

  test('right now, nothing that would be committed carries draft content', async () => {
    const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const files = [];
    for (const file of listed) {
      if (!existsSync(file)) continue;
      const buffer = await readFile(file);
      if (!buffer.includes(0)) files.push({ path: file, text: buffer.toString('utf8') });
    }
    const privateTexts = havePrivateDrafts ? await Promise.all(['en.md', 'zh-Hant.md', 'zh-Hans.md', 'decisions.json'].map(name => readFile(path.join(PRIVATE_DIR, name), 'utf8'))) : [];
    expect(files.length).toBeGreaterThan(100);
    expect(commitCandidateProblems(files, { state: fixture.state, privateTexts })).toEqual([]);
  }, 60000);
});

describe('rendering and consistency (fixture)', () => {
  test('the fixture renders into a consistent draft in all three languages', () => {
    expect(policyProblems(rendered, fixture)).toEqual([]);
    expect(Object.keys(articlesOf(rendered))).toEqual(['en', 'zh-Hant', 'zh-Hans']);
    const results = POLICY_LANGUAGES.map(language => renderPolicyMarkdown(fixture.sources[language.lang], language));
    for (const result of results) {
      expect(result.markers).toEqual(results[0].markers);
      expect(result.headings).toEqual(results[0].headings);
    }
  });

  test('a marker without a decision id, a decided item still shown, or an open item not shown is caught', () => {
    expect(() => renderPolicyMarkdown('## 1. Test\n\nText [PENDING: no id]', POLICY_LANGUAGES[0])).toThrow(/without a PD id/);
    const decided = { ...fixture, decisions: { ...fixture.decisions, decisions: fixture.decisions.decisions.map(item => (item.id === 'PD-02' ? { ...item, status: 'approved' } : item)) } };
    expect(policyProblems(rendered, decided)).toContain('PD-02 is approved but the page still shows it as open');
    const extra = { ...fixture, decisions: { ...fixture.decisions, decisions: [...fixture.decisions.decisions, { id: 'PD-09', status: 'pending' }] } };
    expect(policyProblems(rendered, extra)).toContain('PD-09 is open but the page does not show it');
  });

  test('a draft that lost its notice, its noindex, or its language parity is caught', () => {
    expect(policyProblems(rendered.replace(/<p class="policy-draft-notice" role="note">[^<]*<\/p>\r?\n/, ''), fixture)).toContain('en: a draft must say it is a draft');
    expect(policyProblems(rendered.replace('<meta name="robots" content="noindex">', ''), fixture)).toContain('A draft must not be indexed (robots noindex)');
    const zhHans = rendered.indexOf('lang="zh-Hans" data-policy-lang="zh-Hans"');
    expect(policyProblems(rendered.slice(0, zhHans) + rendered.slice(zhHans).replace('data-decision="PD-02"', 'data-decision="PD-03"'), fixture)).toContain('zh-Hans names different open decisions from en');
    expect(policyProblems(rendered.slice(0, zhHans) + rendered.slice(zhHans).replace('<h3 id="privacy-zh-Hans-2-1">', '<h2 id="privacy-zh-Hans-2-1">'), fixture)).toContain('zh-Hans has a different heading structure from en');
  });
});

describe('approval integrity', () => {
  // A synthetic, fully decided policy (TEST ONLY: nothing here is iHear's decision), as if its
  // approved texts were committed in content/privacy-policy.
  function decidedPolicy() {
    const sources = Object.fromEntries(POLICY_LANGUAGES.map(language => [language.lang, fixture.sources[language.lang].replace(language.pending, 'DECIDED')]));
    const evidence = { decision: 'TEST ONLY', decidedBy: 'TEST ONLY', decidedOn: '2026-11-30', evidence: 'TEST ONLY' };
    const decisions = { ...fixture.decisions, decisions: fixture.decisions.decisions.map(item => ({ ...item, status: 'approved', ...evidence })), oauthDecisions: [] };
    const decisionsText = JSON.stringify(decisions);
    const state = { status: 'approved', effectiveDate: '2026-12-01', approvalRecord: { approvedBy: 'TEST ONLY', approvedOn: '2026-11-30', reference: 'TEST ONLY', ...policyFingerprint({ sources, decisionsText }) } };
    const html = applyPolicyRegions(template, renderPolicyRegions({ sources, state }));
    return { html, inputs: { sources, decisions, decisionsText, state, origin: 'repository' } };
  }

  test('an approved policy is refused while anything is open; a fully decided, fully recorded one passes', () => {
    expect(policyProblems(rendered, { ...fixture, state: { ...fixture.state, status: 'approved' } })).toEqual(expect.arrayContaining([
      'An approved policy must be indexable', 'An approved policy may contain no open decision', 'An approved policy needs an effective date',
      "An approved policy needs a record of iHear's approval", 'An approved policy is built only from the texts committed in content/privacy-policy',
    ]));
    const { html, inputs } = decidedPolicy();
    expect(policyProblems(html, inputs)).toEqual([]);
    expect(html).not.toMatch(/noindex|policy-draft-notice|data-decision/);
    expect(policyProblems(html, { ...inputs, origin: 'private' })).toContain('An approved policy is built only from the texts committed in content/privacy-policy');
  });

  test('the approval record must name who, when and where, and must match the exact approved texts', () => {
    const { html, inputs } = decidedPolicy();
    const withRecord = changes => ({ ...inputs, state: { ...inputs.state, approvalRecord: { ...inputs.state.approvalRecord, ...changes } } });
    expect(policyProblems(html, withRecord({ approvedBy: '' }))).toContain('The approval record must name who approved the policy');
    expect(policyProblems(html, withRecord({ approvedOn: 'soon' }))).toContain('The approval record needs the approval date (YYYY-MM-DD)');
    expect(policyProblems(html, withRecord({ reference: ' ' }))).toContain('The approval record must say where the written approval is kept');
    expect(policyProblems(html, withRecord({ approvedOn: '2026-12-02' }))).toContain('The policy cannot take effect before it was approved');
    expect(policyProblems(html, { ...inputs, state: { ...inputs.state, approvalRecord: 'approved' } })).toContain("An approved policy needs a record of iHear's approval");
    const edited = { ...inputs, sources: { ...inputs.sources, 'zh-Hans': inputs.sources['zh-Hans'].replace('fixture 文字', 'fixture 文字（修订）') } };
    expect(policyProblems(applyPolicyRegions(template, renderPolicyRegions(edited)), edited)).toContain('The zh-Hans text is not the one approved: it must be approved again');
    expect(policyProblems(html, { ...inputs, decisionsText: inputs.decisionsText.replace('TEST ONLY', 'TEST ONLY, edited') })).toContain('The decision registry is not the one approved: it must be approved again');
    // Line endings do not count, whichever a checkout gives (LF in CI, CRLF on Windows with autocrlf).
    const lf = text => text.replace(/\r\n/g, '\n');
    for (const convert of [lf, text => lf(text).replace(/\n/g, '\r\n')]) {
      const variant = { ...inputs, sources: Object.fromEntries(Object.entries(inputs.sources).map(([lang, text]) => [lang, convert(text)])) };
      expect(policyProblems(applyPolicyRegions(template, renderPolicyRegions(variant)), variant)).toEqual([]);
    }
  });

  test('an approved decision needs its decision text, who decided, the date and the evidence; a draft cannot carry an approval', () => {
    const { html, inputs } = decidedPolicy();
    const bare = { ...inputs.decisions, decisions: inputs.decisions.decisions.map(item => (item.id === 'PD-03' ? { ...item, evidence: '' } : item)) };
    const decisionsText = JSON.stringify(bare);
    const rebound = { ...inputs, decisions: bare, decisionsText, state: { ...inputs.state, approvalRecord: { ...inputs.state.approvalRecord, decisions: policyFingerprint({ sources: inputs.sources, decisionsText }).decisions } } };
    expect(policyProblems(html, rebound)).toContain('PD-03 is marked approved without the decision, who decided, the date and where it is recorded');
    expect(policyProblems(rendered, { ...fixture, state: { ...fixture.state, approvalRecord: { approvedBy: 'someone' } } })).toContain('A draft cannot carry an approval record');
  });
});

describe('fail closed: a draft appears only in an explicit local preview', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const draft = { status: 'draft' };
  const environments = [
    [{}, false, 'nothing set (unknown environment)'],
    [{ IHEAR_PRIVACY_PREVIEW: '1' }, true, 'explicit local preview'],
    [{ IHEAR_PRIVACY_PREVIEW: 'true' }, false, 'preview flag with another value'],
    [{ IHEAR_PRIVACY_PREVIEW: '1', VERCEL: '1' }, false, 'preview flag on Vercel'],
    [{ IHEAR_PRIVACY_PREVIEW: '1', VERCEL_ENV: 'preview' }, false, 'preview flag on a Vercel preview'],
    [{ VERCEL_ENV: 'production' }, false, 'Vercel production'],
    [{ IHEAR_PRIVACY_PREVIEW: '1', CI: 'true' }, true, 'explicit preview in CI tests'],
    ...['NETLIFY', 'CONTEXT', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV', 'K_SERVICE', 'FUNCTION_TARGET', 'RENDER', 'FLY_APP_NAME', 'RAILWAY_ENVIRONMENT', 'DYNO', 'WEBSITE_SITE_NAME', 'CF_PAGES', 'VERCEL_URL']
      .map(name => [{ IHEAR_PRIVACY_PREVIEW: '1', [name]: 'x' }, false, `preview flag on a host (${name})`]),
  ];
  test.each(environments)('%o → shown %s (%s)', async (env, expected) => {
    const { privacyPolicyAvailable } = await import('../lib/privacy-policy');
    expect(privacyPolicyShown(draft, env)).toBe(expected);
    expect(privacyPolicyAvailable(env)).toBe(expected);
    expect(privacyPolicyShown({ status: 'approved' }, env)).toBe(true);
  });

  test('the build and the server list the same hosting markers', async () => {
    const lib = await import('../lib/privacy-policy');
    expect(lib.HOSTING_MARKERS).toEqual(HOSTING_MARKERS);
    expect(lib.PRIVACY_POLICY_APPROVED).toBe(false);
  });

  test.each([[{}], [{ VERCEL_ENV: 'production' }], [{ IHEAR_PRIVACY_PREVIEW: '1', VERCEL: '1' }]])('the server answers 404 for the draft with %o, before reading any file', async env => {
    for (const name of ['IHEAR_PRIVACY_PREVIEW', 'VERCEL', 'VERCEL_ENV']) vi.stubEnv(name, env[name] ?? '');
    const { servePublicPage, PUBLIC_PAGES } = await import('../lib/public-page');
    expect(PUBLIC_PAGES).toContain('/privacy');
    expect((await servePublicPage(new Request('https://www.ihearus.org/privacy'), '/privacy')).status).toBe(404);
  }, 60000);

  test('the footer link and the sitemap entry are removed cleanly (CRLF templates)', async () => {
    const index = await readFile('index.html', 'utf8');
    const stripped = applyPrivacyLink(index, false);
    expect(stripped).not.toMatch(/privacy-link|\/privacy/);
    expect(stripped.split('\n').length).toBe(index.split('\n').length - 1);
    expect(applyPrivacyLink(index, true)).toBe(index);
    const sitemap = await readFile('sitemap.xml', 'utf8');
    expect(sitemap).toContain('<loc>https://www.ihearus.org/privacy</loc>');
    const without = sitemapWithPrivacy(sitemap, false);
    expect(without).not.toContain('/privacy<');
    expect(without.split('\n').length).toBe(sitemap.split('\n').length - 1);
  });

  test('routing and bundles: /privacy.html redirects to /privacy; policy texts and the template stay out of server bundles', async () => {
    const config = (await import('../next.config.mjs')).default;
    expect(await config.redirects()).toContainEqual({ source: '/privacy.html', destination: '/privacy', permanent: true });
    expect(config.outputFileTracingExcludes?.['/**']).toEqual(expect.arrayContaining(['./content/privacy-policy/**', './privacy.html']));
    for (const file of ['lib/privacy-policy.ts', 'lib/public-page.ts']) expect(await readFile(file, 'utf8')).not.toMatch(/content\/privacy-policy|privacy\.html|decisions\.json|iHear-privacy-drafts/);
  });
});

describe('footer link on every public page', () => {
  test.each(TEMPLATES)('%s has one privacy link in its footer, in three languages', async file => {
    const html = await readFile(file, 'utf8');
    const footer = html.match(/<div class="foot-bottom">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const links = [...footer.matchAll(/<a class="foot-privacy" href="([^"]+)" data-privacy-link>([\s\S]*?)<\/a>/g)];
    expect(links).toHaveLength(1);
    expect(links[0][1]).toBe('/privacy');
    expect([...links[0][2].matchAll(/<span lang="([^"]+)">([^<]+)<\/span>/g)].map(match => [match[1], match[2]])).toEqual([
      ['en', 'Privacy Policy'], ['zh-Hant', '隱私權政策'], ['zh-Hans', '隐私政策'],
    ]);
    expect((html.match(/data-privacy-link/g) || [])).toHaveLength(1);
  });
});

describe('accessibility of the rendered page (fixture)', () => {
  const articles = articlesOf(rendered);
  test('page language, skip link, one labelled article per language with one h1, no skipped heading levels, unique ids', () => {
    expect(rendered).toMatch(/<html lang="en">/);
    expect(rendered).toMatch(/<a class="skip-link" href="#main"/);
    expect(rendered).toMatch(/<main id="main">/);
    for (const [lang, body] of Object.entries(articles)) {
      expect(rendered).toMatch(new RegExp(`<article class="policy-body" lang="${lang}" data-policy-lang="${lang}" aria-labelledby="privacy-${lang}-title">`));
      expect(body.match(/<h1 id="privacy-[^"]+-title">/g)).toHaveLength(1);
      const levels = [...body.matchAll(/<h([1-6])\b/g)].map(match => Number(match[1]));
      expect(levels[0]).toBe(1);
      for (let index = 1; index < levels.length; index++) expect(levels[index] - levels[index - 1], `${lang} heading ${index}`).toBeLessThanOrEqual(1);
    }
    const ids = [...rendered.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('tables have column and row headers inside a labelled, keyboard-scrollable region; links have text; marks are labelled', () => {
    const wraps = [...rendered.matchAll(/<div class="policy-table-wrap" role="region" tabindex="0" aria-label="([^"]+)"><table>([\s\S]*?)<\/table><\/div>/g)];
    expect(wraps.length).toBe(3);
    for (const [, label, table] of wraps) {
      expect(label.trim()).not.toBe('');
      expect(table).toMatch(/<thead><tr>(<th scope="col">[^]*?<\/th>)+<\/tr><\/thead>/);
      for (const row of table.match(/<tbody>([\s\S]*)<\/tbody>/)[1].split('</tr>').filter(Boolean)) expect(row).toMatch(/^<tr><th scope="row">/);
    }
    for (const [, attributes, text] of rendered.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      expect(text.replace(/<[^>]+>/g, '').trim() || /aria-label="([^"]+)"/.exec(attributes)?.[1], attributes).toBeTruthy();
      if (/target="_blank"/.test(attributes)) expect(attributes).toMatch(/rel="noopener noreferrer"/);
    }
    for (const [, body] of rendered.matchAll(/<mark class="policy-pending" data-decision="PD-\d\d">([\s\S]*?)<\/mark>/g)) {
      expect(body).toMatch(/^<strong class="policy-pending-label">(Pending iHear decision|待 iHear 決定|待 iHear 决定) PD-\d\d<\/strong>/);
    }
  });
});

// The real drafts, where they are at hand (a reviewer's own computer). Skipped in CI by design: the
// drafts are not in the repository. What they must contain (marker counts, decision ids, required
// phrases) is recorded with them, in expectations.json beside the drafts, so this file carries no
// policy content (F-06, option B).
describe.skipIf(!havePrivateDrafts)('the private drafts (local only)', async () => {
  const drafts = havePrivateDrafts ? await readPolicyInputs(root, { IHEAR_PRIVACY_SOURCES: PRIVATE_DIR }) : null;
  const html = drafts ? applyPolicyRegions(template, renderPolicyRegions(drafts)) : '';
  const articles = articlesOf(html);
  const expectationsFile = havePrivateDrafts ? path.join(PRIVATE_DIR, 'expectations.json') : '';
  const expected = expectationsFile && existsSync(expectationsFile) ? JSON.parse(await readFile(expectationsFile, 'utf8')) : null;

  test('the expectations are recorded beside the drafts', () => {
    expect(expected, `${expectationsFile} is missing`).not.toBeNull();
  });

  test('they render into a consistent draft: the same markers in every language, as many as recorded', () => {
    expect(drafts.origin).toBe('private');
    expect(policyProblems(html, drafts)).toEqual([]);
    const results = POLICY_LANGUAGES.map(language => renderPolicyMarkdown(drafts.sources[language.lang], language));
    for (const result of results) {
      expect(result.markers).toHaveLength(expected.markers);
      expect(result.markers).toEqual(results[0].markers);
    }
    expect(new Set(results[0].markers).size).toBe(expected.uniqueMarkers);
  });

  test('the registry holds the recorded decisions, all still pending, overlaps resolvable', () => {
    const { decisions, oauthDecisions, pilotDecisionList } = drafts.decisions;
    expect(decisions.map(item => item.id)).toEqual(expected.decisionIds);
    expect(oauthDecisions.map(item => item.id)).toEqual(expected.oauthDecisionIds);
    const known = new Set([...decisions.map(item => item.id), ...oauthDecisions.map(item => item.id), ...Object.keys(pilotDecisionList)]);
    for (const item of [...decisions, ...oauthDecisions]) {
      expect(item.status).toBe('pending');
      for (const overlap of item.overlaps ?? []) expect(known.has(overlap), `${item.id} overlaps ${overlap}`).toBe(true);
    }
  });

  test.each(POLICY_LANGUAGES.map(language => language.lang))('%s carries every recorded phrase and no internal note', lang => {
    expect(expected.phrases[lang]?.length).toBeGreaterThan(0);
    for (const phrase of expected.phrases[lang]) expect(articles[lang], phrase).toContain(phrase);
    expect(html).not.toMatch(/給 iHear 內部|Internal note|给 iHear 内部|planning\/|\bH8\b/);
  });
});
