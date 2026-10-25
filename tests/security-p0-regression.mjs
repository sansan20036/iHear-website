// Explicitly invoked local-only acceptance test. It does not start a server,
// read credentials, change application data, or visit the production website.
// capture: IHEAR_P0_ISOLATED=1 IHEAR_P0_BASE_URL=http://127.0.0.1:3214 node tests/security-p0-regression.mjs capture baseline output/playwright/security-p0/baseline
// compare: node tests/security-p0-regression.mjs compare BASELINE_DIR PATCHED_DIR OUTPUT_DIR
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const fixture = JSON.parse(await readFile(new URL('./security-p0-regression.fixture.json', import.meta.url), 'utf8'));
const repository = path.resolve(process.env.IHEAR_P0_SOURCE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = value => value.replace(/\s+/g, ' ').trim();
const viewports = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-320', width: 320, height: 720 },
];
const expectedVersions = {
  baseline: {
    next: '16.2.11', sharp: '0.35.3', '@img/sharp-wasm32': '0.35.3',
    '@img/sharp-linux-x64': '0.35.3', '@img/sharp-libvips-linux-x64': '1.3.2',
  },
  patched: {
    next: '16.4.1', sharp: '0.35.5', '@img/sharp-wasm32': '0.35.5',
    '@img/sharp-linux-x64': '0.35.5', '@img/sharp-libvips-linux-x64': '1.3.4',
  },
};
const motionStyle = '*,:before,:after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';
const [mode, ...arguments_] = process.argv.slice(2);

function localOrigin(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname)
    || /^ihear-[a-z0-9-]+$/.test(url.hostname);
  assert.ok(local && url.protocol === 'http:' && !url.username && !url.password,
    'P0 accepts only an isolated loopback/Docker HTTP server');
  assert.equal(url.pathname, '/', 'Provide only a local server origin');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  return url.origin;
}

async function sourceIdentity() {
  const hashes = {};
  for (const name of Object.keys(fixture.sourceHashes)) {
    // Git archive uses LF; a Windows checkout may use CRLF. Normalize only line
    // endings, without trimming or normalizing text, prices, markup or styles.
    hashes[name] = sha256((await readFile(path.join(repository, name), 'utf8')).replace(/\r\n/g, '\n'));
  }
  assert.deepEqual(hashes, fixture.sourceHashes, 'Academy source must still match the a845762 baseline');
  const lock = JSON.parse(await readFile(path.join(repository, 'package-lock.json'), 'utf8'));
  return { baselineCommit: fixture.baselineCommit, sourceHashes: hashes,
    versions: Object.fromEntries(['next', 'sharp', '@img/sharp-wasm32', '@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']
      .map(name => [name, lock.packages[`node_modules/${name}`]?.version ?? null])) };
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const frame = () => new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)); });
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.max(300, innerHeight * 0.8)) {
      scrollTo(0, y);
      await frame();
    }
    await Promise.all([...document.images].map(img => img.decode().catch(() => {})));
    scrollTo(0, 0);
    await frame();
  });
  await expect.poll(() => page.locator('img').evaluateAll(images => images
    .filter(img => img.getBoundingClientRect().width > 0 && img.getBoundingClientRect().height > 0)
    .filter(img => !img.complete || img.naturalWidth === 0).map(img => img.getAttribute('src'))),
  { timeout: 20_000, message: 'Visible images must load' }).toEqual([]);
}

async function assertLayout(page, selectors) {
  const layout = await page.evaluate(selectors => {
    const rounded = value => Math.round(value * 100) / 100;
    const visible = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const nodes = [...document.querySelectorAll(selectors)].filter(visible);
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      elements: nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { tag: node.tagName, id: node.id, text: node.textContent.replace(/\s+/g, ' ').trim(),
          x: rounded(rect.x), y: rounded(rect.y + scrollY), width: rounded(rect.width), height: rounded(rect.height),
          clipped: node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).display !== 'inline' };
      }),
    };
  }, selectors);
  assert.ok(layout.overflow <= 1, `No horizontal overflow; found ${layout.overflow}px`);
  for (const element of layout.elements) {
    assert.ok(element.x >= -1 && element.x + element.width <= page.viewportSize().width + 1,
      `Visible content stays in the viewport: ${element.id || element.text.slice(0, 70)}`);
    assert.equal(element.clipped, false, `No horizontally clipped label: ${element.text.slice(0, 70)}`);
  }
  return layout;
}

async function snapshotContent(page, origin) {
  return page.evaluate(origin => {
    const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const href = node => (node.getAttribute('href') || '').replaceAll(origin, '{local-origin}');
    return {
      lang: document.documentElement.lang,
      title: document.title,
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      mainText: text(document.querySelector('main')),
      headings: [...document.querySelectorAll('h1,h2,h3')].map(node => ({ level: node.tagName, text: text(node) })),
      links: [...document.querySelectorAll('a[href]')].map(node => ({ text: text(node), href: href(node), lang: node.lang })),
      faq: [...document.querySelectorAll('#faq details')].map(node => ({
        question: text(node.querySelector('summary')), answer: text(node.querySelector('p')),
      })),
    };
  }, origin);
}

async function capture(label, directory) {
  assert.ok(['baseline', 'patched'].includes(label), 'Capture label must be baseline or patched');
  assert.equal(process.env.IHEAR_P0_ISOLATED, '1', 'Require IHEAR_P0_ISOLATED=1 for the isolated test server');
  const origin = localOrigin(process.env.IHEAR_P0_BASE_URL);
  const output = path.resolve(directory);
  await mkdir(output, { recursive: true });
  const identity = await sourceIdentity();
  assert.deepEqual(identity.versions, expectedVersions[label], `${label} capture must use its exact expected dependency tuple`);
  const browser = await chromium.launch({ headless: true });
  const report = { label, identity, environment: { browser: browser.version(), node: process.version,
    platform: process.platform, arch: process.arch, locale: 'en-US', timezone: 'Asia/Taipei', deviceScaleFactor: 1 },
  checks: [], screenshots: [], blockedExternal: [], errors: [], completed: false };

  async function screenshot(page, name, locator = null) {
    await page.mouse.move(0, 0);
    const file = `${name}.png`;
    const options = { path: path.join(output, file), animations: 'disabled', caret: 'hide' };
    if (locator) await locator.screenshot(options);
    else { await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ ...options, fullPage: true }); }
    report.screenshots.push({ file, sha256: sha256(await readFile(path.join(output, file))) });
  }

  async function withPage(viewport, operation) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'Asia/Taipei', reducedMotion: 'reduce',
      serviceWorkers: 'block', storageState: { cookies: [], origins: [] } });
    const failures = [];
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        report.blockedExternal.push({ host: url.hostname, pathname: url.pathname });
        // The legacy markup includes an analytics script. Stub it without making
        // a network request; any unexpected external resource remains a failure.
        if (url.hostname === 'static.cloudflareinsights.com') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
        failures.push(`Unexpected external resource: ${url.hostname}${url.pathname}`);
        return route.abort('blockedbyclient');
      }
      if (!['GET', 'HEAD'].includes(request.method())) {
        failures.push(`Blocked write method ${request.method()} ${url.pathname}`);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await context.routeWebSocket('**/*', socket => { failures.push('Unexpected WebSocket'); socket.close(); });
    page.on('pageerror', error => failures.push(`Page error: ${error.message}`));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400) failures.push(`${response.status()} ${url.pathname}`);
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      if (url.origin === origin && request.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(`Request failed: ${url.pathname}`);
    });
    try { await operation(page); assert.deepEqual(failures, [], 'No HTTP, script, write or external-resource failures'); }
    finally { await context.close(); }
  }

  async function load(page, route) {
    const response = await page.goto(origin + route, { waitUntil: 'load' });
    assert.equal(response?.status(), 200, route);
    assert.equal(new URL(page.url()).origin, origin);
    await page.addStyleTag({ content: motionStyle });
    await expect(page.locator('main h1')).toBeVisible();
    await settle(page);
  }

  try {
    for (const viewport of viewports) {
      await withPage(viewport, async page => {
        await load(page, '/academy');
        const state = { kind: 'introduction', viewport, locales: [] };
        for (const [switchName, locale] of [['en', 'en'], ['zhCN', 'zhHans'], ['zhTW', 'zhHant']]) {
          const toggle = page.locator('#navToggle');
          const mobile = await toggle.isVisible();
          if (mobile) { await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); }
          await page.locator(`#langSwitch button[data-lang="${switchName}"]`).click();
          const courseLink = page.locator('[data-layout-link="academy.acad.courses.href"]');
          await expect(courseLink).toHaveText(fixture.courseLabels[locale]);
          await expect(courseLink).toHaveAttribute('href', '/academy/courses/zh?entry=official');
          if (mobile) { await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); }
          await page.evaluate(() => scrollTo(0, 0));
          state.locales.push({ locale, content: await snapshotContent(page, origin),
            layout: await assertLayout(page, '.academy-card,.academy-card .btn,.academy-card h1,.academy-card p') });
          await screenshot(page, `${viewport.name}-introduction-${locale}`);
        }
        if (viewport.width < 600) {
          await page.evaluate(() => scrollTo(0, 500));
          for (let cycle = 0; cycle < 3; cycle++) {
            const toggle = page.locator('#navToggle');
            await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            await expect(page.locator('#navLinks')).toBeVisible();
            await expect(page.locator('#navLinks')).toHaveCSS('opacity', '1');
            await assertLayout(page, '#navLinks,#navLinks a');
            if (cycle === 2) await screenshot(page, `${viewport.name}-introduction-menu`);
            await toggle.click(); await expect(page.locator('#navLinks')).toBeHidden();
          }
        }
        await page.locator('[data-layout-link="academy.acad.courses.href"]').click();
        await expect(page).toHaveURL(`${origin}/academy/courses/zh?entry=official`);
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
        await expect(page.locator('#pricing')).toBeAttached();
        report.checks.push(state);
      });

      for (const [language, route] of [['en', '/academy/courses'], ['zh-Hant', '/academy/courses/zh']]) {
        await withPage(viewport, async page => {
          await load(page, `${route}?entry=official`);
          await expect(page.locator('html')).toHaveAttribute('lang', language);
          await expect(page.locator('input[name="currency"]:checked')).toHaveValue(language === 'en' ? 'USD' : 'TWD');
          await expect(page.locator('input[name="duration"]:checked')).toHaveValue('60');
          await expect(page.locator('input[name="tutor"]:checked')).toHaveValue('highschool');
          await expect(page.locator('input[name="plan"]:checked')).toHaveValue('single');
          await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://www.ihearus.org${route}`);
          for (const section of ['subjects','approach','learners','tutors','pricing','purpose','faq','start']) {
            await expect(page.locator(`#${section}`)).toHaveCount(1);
          }
          for (const [lang, target] of [['en','/academy/courses'],['zh-Hant','/academy/courses/zh']]) {
            await expect(page.locator(`a[lang="${lang}"]`)).toHaveCount(2);
            for (const link of await page.locator(`a[lang="${lang}"]`).all()) {
              await expect(link).toHaveAttribute('href', `${target}?entry=official`);
            }
          }
          const content = await snapshotContent(page, origin);
          assert.deepEqual(content.faq, fixture.faq[language].map(item => ({
            question: normalize(item.question), answer: normalize(item.answer) })), 'Every FAQ question/answer matches production baseline');
          assert.doesNotMatch(content.mainText, /(?:\$35\b|\$40\b|\$330\b|\$380\b|USD 35|USD 40|USD 330|USD 380)/);
          const state = { kind: 'course', language, viewport, defaultContent: content,
            defaultLayout: await assertLayout(page, 'main h1,.subject,.subject a,.price-card,.price-options label,#price,#price-detail,#faq summary'), prices: [] };
          await screenshot(page, `${viewport.name}-${language}-default`);
          for (const [currency, minutes, tutor, single, total] of fixture.prices) {
            for (const [name, value] of [['currency',currency],['duration',minutes],['tutor',tutor]]) {
              await page.locator(`input[name="${name}"][value="${value}"]`).check();
            }
            for (const [plan, expected] of [['single',single],['package',total]]) {
              await page.locator(`input[name="plan"][value="${plan}"]`).check();
              await expect(page.locator('#price')).toHaveText(expected);
              const detail = normalize(await page.locator('#price-detail').textContent());
              assert.ok(detail.includes(expected), 'Detail quotes the selected price');
              assert.ok(detail.includes(minutes), 'Detail quotes the selected duration');
              assert.ok(detail.includes(language === 'en' ? (tutor === 'college' ? 'college' : 'high-school') : (tutor === 'college' ? '大學生' : '高中生')), 'Detail quotes the selected tutor');
              if (plan === 'package') {
                assert.ok(detail.includes(language === 'en' ? '10% off' : '九折'), 'Ten sessions keep the agreed discount');
                assert.ok(detail.includes(single), 'Package saving is one full single session');
              }
              const tutorLabels = await page.locator('[data-tutor-price]').allTextContents();
              for (const option of ['highschool','college']) {
                const row = fixture.prices.find(row => row[0] === currency && row[1] === minutes && row[2] === option);
                await expect(page.locator(`[data-tutor-price="${option}"]`)).toHaveText(row[3] + (language === 'en' ? '/session' : '／堂'));
              }
              state.prices.push({ currency, minutes, tutor, plan, price: expected, detail, tutorLabels,
                unit: normalize(await page.locator('#price-unit').textContent()),
                layout: await assertLayout(page, '.price-card,.price-options label,#price,#price-detail') });
              if (minutes === '60' && tutor === 'college' && plan === 'package') {
                await screenshot(page, `${viewport.name}-${language}-pricing-${currency}`, page.locator('#pricing'));
              }
            }
          }
          // Exercise both currency directions repeatedly without changing the
          // selected tutor, duration or plan; then restore the original default.
          for (const currency of ['TWD','USD','TWD','USD']) {
            await page.locator(`input[name="currency"][value="${currency}"]`).check();
            await expect(page.locator('#price')).toHaveText(currency === 'TWD' ? 'NT$12,600' : 'US$405');
            await expect(page.locator('input[name="duration"]:checked')).toHaveValue('60');
            await expect(page.locator('input[name="tutor"]:checked')).toHaveValue('college');
            await expect(page.locator('input[name="plan"]:checked')).toHaveValue('package');
          }
          const details = page.locator('#faq details');
          await expect(details).toHaveCount(9);
          for (const detail of await details.all()) {
            await detail.locator('summary').click();
            await expect(detail).toHaveAttribute('open','');
            await expect(detail.locator('p')).toBeVisible();
            await assertLayout(page, '#faq details[open],#faq details[open] p');
          }
          state.faqOpenLayout = await assertLayout(page, '#faq details,#faq summary,#faq p');
          await screenshot(page, `${viewport.name}-${language}-faq-open`, page.locator('#faq'));
          for (const detail of await details.all()) {
            await detail.locator('summary').click();
            await expect(detail).not.toHaveAttribute('open','');
            await expect(detail.locator('p')).toBeHidden();
          }
          await page.locator('.hero a.button[href="#start"]').click();
          await expect(page.locator('#start')).toBeInViewport();
          const mail = new URL(await page.locator('a[href^="mailto:"][href*="body="]').getAttribute('href'));
          assert.equal(mail.pathname, 'ihearprogram@gmail.com');
          assert.ok(mail.searchParams.get('subject').includes('iHear Academy'));
          assert.ok(mail.searchParams.get('body').includes(language === 'en' ? 'grade' : '年級'));
          state.emailDraft = { recipient: mail.pathname, subject: mail.searchParams.get('subject'), body: mail.searchParams.get('body') };
          const otherLanguage = language === 'en' ? 'zh-Hant' : 'en';
          await page.locator(`header a[lang="${otherLanguage}"]`).click();
          await expect(page.locator('html')).toHaveAttribute('lang', otherLanguage);
          await expect(page.locator('input[name="currency"]:checked')).toHaveValue(otherLanguage === 'en' ? 'USD' : 'TWD');
          report.checks.push(state);
        });
      }
      console.log(`P0 ${label}: ${viewport.name} passed introduction, 2 locales, 32 price states, 18 FAQs and currency/navigation checks.`);
    }
    report.completed = true;
  } catch (error) {
    report.errors.push(String(error.stack || error));
    throw error;
  } finally {
    await browser.close();
    await writeFile(path.join(output, 'capture.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`P0 ${label}: ${report.checks.length} route/viewport cases and ${report.screenshots.length} screenshots captured.`);
}

async function compare(baselineDirectory, patchedDirectory, outputDirectory) {
  const baseline = JSON.parse(await readFile(path.join(baselineDirectory, 'capture.json'), 'utf8'));
  const patched = JSON.parse(await readFile(path.join(patchedDirectory, 'capture.json'), 'utf8'));
  assert.equal(baseline.label, 'baseline'); assert.equal(patched.label, 'patched');
  assert.equal(baseline.completed, true); assert.equal(patched.completed, true);
  assert.deepEqual(baseline.environment, patched.environment, 'Use the same browser, OS, fonts/locale and Node for both captures');
  assert.deepEqual(baseline.identity.sourceHashes, patched.identity.sourceHashes);
  assert.deepEqual(baseline.identity.versions, expectedVersions.baseline, 'Baseline dependency tuple');
  assert.deepEqual(patched.identity.versions, expectedVersions.patched, 'Patched dependency tuple');
  const output = path.resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const result = { baselineVersions: baseline.identity.versions, patchedVersions: patched.identity.versions,
    contentAndLayoutEqual: true, screenshots: [], completed: false, failures: [] };
  try { assert.deepEqual(patched.checks, baseline.checks); }
  catch (error) { result.contentAndLayoutEqual = false; result.failures.push(`Content/layout mismatch: ${error.message}`); }
  assert.deepEqual(patched.screenshots.map(item => item.file), baseline.screenshots.map(item => item.file), 'Same screenshot set');
  const { default: sharp } = await import('sharp');
  for (const screenshot of baseline.screenshots) {
    const [before, after] = await Promise.all([baselineDirectory, patchedDirectory].map(directory =>
      sharp(path.join(directory, screenshot.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
    if (before.info.width !== after.info.width || before.info.height !== after.info.height) {
      result.screenshots.push({ file: screenshot.file, equal: false, before: before.info, after: after.info });
      result.failures.push(`Screenshot dimensions differ: ${screenshot.file}`);
      continue;
    }
    let changedPixels = 0;
    const diff = Buffer.alloc(before.data.length);
    for (let i = 0; i < before.data.length; i += 4) {
      const changed = before.data[i] !== after.data[i] || before.data[i+1] !== after.data[i+1]
        || before.data[i+2] !== after.data[i+2] || before.data[i+3] !== after.data[i+3];
      if (changed) changedPixels++;
      diff[i] = 255; diff[i+1] = changed ? 0 : 255; diff[i+2] = changed ? 80 : 255; diff[i+3] = 255;
    }
    result.screenshots.push({ file: screenshot.file, equal: changedPixels === 0, changedPixels,
      totalPixels: before.info.width * before.info.height, width: before.info.width, height: before.info.height });
    if (changedPixels) {
      result.failures.push(`Pixel differences require review: ${screenshot.file} (${changedPixels} pixels)`);
      await sharp(diff, { raw: { width: before.info.width, height: before.info.height, channels: 4 } }).png()
        .toFile(path.join(output, `diff-${screenshot.file}`));
    }
  }
  result.completed = true;
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify(result, null, 2) + '\n');
  assert.deepEqual(result.failures, [], 'P0 requires identical content/layout and zero unreviewed screenshot pixel differences');
  console.log(`P0 comparison PASS: ${patched.checks.length} route/viewport cases, 96 exact price states, 54 FAQ checks, ${result.screenshots.length} pixel-identical screenshots.`);
}

if (mode === 'capture' && arguments_.length === 2) await capture(...arguments_);
else if (mode === 'compare' && arguments_.length === 3) await compare(...arguments_);
else throw new Error('Usage: security-p0-regression.mjs capture <baseline|patched> <output-dir> | compare <baseline-dir> <patched-dir> <output-dir>');
