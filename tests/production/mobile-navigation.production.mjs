import { expect, test } from '@playwright/test';
import { installReadOnlyGuard } from './read-only.mjs';

test('mobile navigation stays visible when reopened after scrolling', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.use.viewport.width > 1024, 'Mobile navigation only');
  const blocked = [];
  await installReadOnlyGuard(context, blocked);
  await page.goto('/');
  await page.evaluate(() => window.scrollTo(0, 1000));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  const toggle = page.locator('#navToggle');
  const drawer = page.locator('#navLinks');
  for (let cycle = 0; cycle < 3; cycle++) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await drawer.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveCSS('opacity', '1');
    await toggle.click();
    await expect(drawer).toBeHidden();
  }
  expect(blocked).toEqual([]);
});
