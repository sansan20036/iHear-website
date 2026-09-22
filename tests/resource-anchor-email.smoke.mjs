// Checkpoint 5 workflows run inside the isolated public Resources smoke server.
import { legacyResourceSnapshot } from './helpers/resource-public-snapshot.mjs';
export async function resourceAnchorEmailTests({ visitor, admin, origin, expect, step, topic, item, l }) {
  await step('Deep links wait for data, preserve stable/suffixed slugs and avoid repeat scrolling', async () => {
    const page = await visitor.newPage();
    const payload = legacyResourceSnapshot({ topics: [topic('before', 'published', 0), { ...topic('journal', 'published', 1), slug: 'journal-club' }, { ...topic('journal2', 'published', 2), slug: 'journal-club-2' }, { ...topic('journal3', 'published', 3), slug: 'journal-club-3' }], items: [item('intro', 'before', 'text'), item('j', 'journal', 'text'), item('j2', 'journal2', 'text'), item('j3', 'journal3', 'text')] });
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/resources', async route => { await gate; await route.fulfill({ json: payload }); });
    await page.addInitScript(() => { const original = window.scrollTo.bind(window); window.anchorScrollCalls = 0; window.scrollTo = (...args) => { window.anchorScrollCalls++; return original(...args); }; });
    await page.goto(origin + '/resources#journal-club');
    await expect(page.locator('[data-resource-topics] section')).toHaveCount(0); release();
    const target = page.locator('[data-resource-topic="journal"]'); await expect(target.locator('h2')).toBeFocused();
    expect(await target.getAttribute('id')).toBe('journal-club');
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const slug of ['journal-club-2', 'journal-club-3', 'journal-club']) {
        await page.evaluate(slug => { location.hash = slug; }, slug);
        const selected = page.locator(`[data-resource-slug="${slug}"]`);
        await expect(selected.locator('h2')).toBeFocused();
        expect(await selected.evaluate(node => node.getBoundingClientRect().top >= document.querySelector('.nav').getBoundingClientRect().bottom)).toBe(true);
      }
    }
    payload.topics[1].title = l('Renamed Journal heading');
    const count = await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); return window.anchorScrollCalls; });
    const response = page.waitForResponse(origin + '/api/resources'); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await response;
    await expect(target.locator('h2')).toHaveText('Renamed Journal heading');
    await expect(target.locator('h2')).toBeFocused();
    expect(await page.evaluate(() => window.anchorScrollCalls)).toBe(count);
    await page.reload(); await expect(target.locator('h2')).toBeFocused();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => { location.hash = 'journal-club-2'; });
    await expect(page.locator('[data-resource-slug="journal-club-2"] h2')).toBeFocused();
    await page.screenshot({ path: 'output/playwright/resource-anchor-390.png' });
    await page.close();
  });
  await step('Legacy anchors, DOM ID collision, unavailable topics and malformed hashes are safe', async () => {
    const page = await visitor.newPage();
    const payload = legacyResourceSnapshot({ topics: [{ ...topic('forms', 'published', 1), slug: 'resource-links' }, { ...topic('articles', 'published', 2), slug: 'resource-articles' }, { ...topic('collision', 'published', 3), slug: 'main' }], items: [item('f', 'forms', 'text'), item('a', 'articles', 'text'), item('c', 'collision', 'text')] });
    await page.route('**/api/resources', route => route.fulfill({ json: payload }));
    await page.goto(origin + '/resources#resource-links');
    for (const hash of ['resource-articles', 'resources', 'resource-guides', 'main']) {
      await page.evaluate(hash => { location.hash = hash; }, hash);
      const target = hash === 'main' ? page.locator('[data-resource-topic="collision"] h2') : page.locator(`#${hash}`).locator('h1,h2').first();
      await expect(target).toBeFocused();
    }
    expect(await page.locator('[id]').evaluateAll(nodes => nodes.length === new Set(nodes.map(n => n.id)).size)).toBe(true);
    await page.close();
    const privatePage = await visitor.newPage();
    for (const hash of ['private-draft-topic', 'private-archived-topic', 'empty-published-topic', 'never-existed', '%E0%A4%A']) {
      await privatePage.goto(origin + '/resources#' + hash);
      await expect(privatePage.locator('.resource-anchor-notice')).toBeVisible();
      expect(await privatePage.locator('body').innerText()).not.toContain('PRIVATE-');
      expect(await privatePage.locator('.resource-anchor-notice').innerText()).not.toContain(hash);
    }
    await privatePage.close();
  });
  await step('Email subjects round-trip exactly once in all languages and preserve other item types', async () => {
    const page = await visitor.newPage();
    const names = l('English 中文 & ? # % 😀 spaces', '繁體 中文 & ? # % 😀 空白', '简体 中文 & ? # % 😀 空格');
    await page.route('**/api/resources', route => route.fulfill({ json: legacyResourceSnapshot({ topics: [topic('mail', 'published', 1)], items: [{ ...item('email', 'mail', 'email_request'), title: names }, { ...item('fallback', 'mail', 'email_request'), title: l(names.en) }, item('external', 'mail', 'external_link'), item('plain', 'mail', 'text')] }) }));
    await page.goto(origin + '/resources');
    for (const [language, locale, prefix] of [['en', 'en', 'Resource guide request: '], ['zhTW', 'zhHant', '索取指南：'], ['zhCN', 'zhHans', '索取指南：']]) {
      await page.setViewportSize({ width: 1440, height: 900 }); await page.locator(`#langSwitch button[data-lang="${language}"]`).click();
      for (const id of ['email', 'fallback']) {
        const link = page.locator(`[data-resource-item="${id}"] a`); const subject = prefix + (id === 'fallback' ? names.en : names[locale]);
        await expect(link).toHaveAttribute('href', 'mailto:ihearprogram@gmail.com?subject=' + encodeURIComponent(subject));
        const href = await link.getAttribute('href'); expect(decodeURIComponent(href.split('?subject=')[1])).toBe(subject);
        expect(new URL(href).searchParams.get('subject')).toBe(subject); expect(await link.getAttribute('target')).toBeNull();
        // Capture native link activation without launching or sending from a mail client.
        await link.evaluate(node => node.addEventListener('click', event => { event.preventDefault(); window.activatedMail = node.href; }, { once: true }));
        await link.focus(); await page.keyboard.press('Enter'); expect(await page.evaluate(() => window.activatedMail)).toBe(href);
      }
      await expect(page.locator('[data-resource-item="external"] a')).toHaveAttribute('target', '_blank');
      await expect(page.locator('[data-resource-item="plain"] a, [data-resource-item="plain"] button')).toHaveCount(0);
    }
    await page.close();
  });
  await step('Admin copy URL supports clipboard success and manual fallback with visibility warnings', async () => {
    for (const clipboard of ['success', 'missing', 'denied']) {
      const page = await admin.newPage();
      await page.addInitScript(mode => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : { writeText: async text => { if (mode === 'denied') throw new Error('Denied'); window.copiedTopicUrl = text; } } }), clipboard);
      await page.goto(origin + '/admin/resources');
      await page.getByRole('button', { name: '主題管理', exact: true }).click();
      const card = page.locator('[data-resource-id="topic-a"]');
      await card.getByRole('button', { name: '複製主題網址' }).click();
      const input = card.getByLabel('主題網址', { exact: true }); await expect(input).toHaveValue(origin + '/resources#topic-a');
      await expect(card.getByRole('status')).toHaveText(clipboard === 'success' ? '已複製網址。' : '請選取下方網址並手動複製。');
      if (clipboard === 'success') expect(await page.evaluate(() => window.copiedTopicUrl)).toBe(origin + '/resources#topic-a');
      await input.focus(); expect(await input.evaluate(node => node.selectionEnd - node.selectionStart)).toBe((await input.inputValue()).length);
      for (const id of ['PRIVATE-DRAFT-TOPIC', 'EMPTY-PUBLISHED-TOPIC']) await expect(page.locator(`[data-resource-id="${id}"]`)).toContainText('訪客目前無法查看此主題');
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width <= 390) await expect.poll(() => page.locator('.admin-sidebar').evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
        await input.click();
        if (clipboard === 'missing' && width !== 390) { await input.scrollIntoViewIfNeeded(); await page.screenshot({ path: `output/playwright/resource-copy-${width}.png` }); }
      }
      await page.getByLabel('狀態篩選', { exact: true }).selectOption('archived');
      await expect(page.locator('[data-resource-id="PRIVATE-ARCHIVED-TOPIC"]')).toContainText('訪客目前無法查看此主題');
      await page.close();
    }
  });
}
