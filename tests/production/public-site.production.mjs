import { expect, test as base } from "@playwright/test";
import { installReadOnlyGuard, productionOrigin, publicPages } from "./read-only.mjs";

const test = base.extend({
  inspection: [async ({ context, page }, use, testInfo) => {
    const blocked = [], failures = [], scriptErrors = [];
    await installReadOnlyGuard(context, blocked);
    page.on("pageerror", error => scriptErrors.push(error.message));
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.origin === productionOrigin && response.status() >= 400) {
        failures.push({ path: url.pathname, status: response.status() });
      }
    });
    page.on("requestfailed", request => {
      const url = new URL(request.url());
      const error = request.failure()?.errorText;
      if (url.origin === productionOrigin && error !== "net::ERR_ABORTED") failures.push({ path: url.pathname, error });
    });
    try {
      await use({ blocked, failures, scriptErrors });
      expect(blocked, "Read-only guard blocked unexpected traffic").toEqual([]);
      expect(failures, "Production returned HTTP errors").toEqual([]);
      expect(scriptErrors, "Uncaught page JavaScript errors").toEqual([]);
    } finally {
      await testInfo.attach("inspection-diagnostics", {
        body: Buffer.from(JSON.stringify({ blocked, failures, scriptErrors }, null, 2)),
        contentType: "application/json",
      });
    }
  }, { auto: true }],
});

const adminControls = [
  ".ihear-inline-edit-button", ".site-media-edit", ".site-theme-trigger",
  ".ihear-layout-trigger", ".gallery-manage", "[data-resource-manage]",
  "[data-team-toggle]", "[data-team-add]", "[data-team-sort-az]",
  "[data-team-drag]", 'a[href^="/admin"]',
].map(selector => `${selector}:visible`).join(", ");

function responseFor(page, pathname) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === productionOrigin && url.pathname === pathname && response.request().method() === "GET";
  }, { timeout: 45_000 });
}

async function inspectImages(page) {
  // Scrolling triggers normal lazy loading and reveal animations without submitting anything.
  await page.evaluate(async () => {
    const nextFrame = () => new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)); });
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.max(200, innerHeight * 0.8)) {
      window.scrollTo(0, y);
      await nextFrame();
    }
  });
  const images = page.locator('img[src]:not([src=""]), img[srcset]');
  // Include images whose onerror handler hid them, but exclude deliberately hidden defaults.
  await expect.poll(() => images.evaluateAll(nodes => nodes.filter(img => {
    const box = img.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }).filter(img => !img.complete || img.naturalWidth === 0)
    .map(img => ({ alt: img.alt, src: img.currentSrc || img.src }))), {
    timeout: 30_000, message: "Displayed photos and video covers must finish loading",
  }).toEqual([]);
  expect(await images.count(), "Page should contain images").toBeGreaterThan(0);
}

for (const route of publicPages) {
  test(`${route} visitor content, images, links and layout`, async ({ page }, testInfo) => {
    const required = ["/api/auth/session", "/api/content/get"];
    if (["/", "/impact", "/team"].includes(route)) required.push("/api/site-media");
    if (route === "/team") required.push("/api/team-profiles");
    if (route === "/resources") required.push("/api/resources");
    if (["/", "/programs", "/impact"].includes(route)) required.push("/api/media-galleries");
    const responses = await Promise.all([
      page.goto(route, { waitUntil: "load" }),
      ...required.map(pathname => responseFor(page, pathname)),
    ]);
    for (const response of responses) expect(response?.status(), response?.url()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(route);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("h1")).not.toHaveText("");
    const session = await responses[1].json();
    expect(session?.user, "Fresh inspection context must remain signed out").toBeFalsy();

    if (route === "/team") {
      const data = await responses[required.indexOf("/api/team-profiles") + 1].json();
      const count = data.leaders.length + data.tutors.length;
      expect(count, "Published team profiles should be present").toBeGreaterThan(0);
      await expect(page.locator("[data-profile-id]")).toHaveCount(count);
    }
    if (route === "/resources") {
      const data = await responses[required.indexOf("/api/resources") + 1].json();
      expect(Array.isArray(data.items)).toBe(true);
      const links = page.locator(".resource-links-list a");
      await expect(links).toHaveCount(data.items.length);
      const rendered = await links.evaluateAll(nodes => nodes.map(link => ({ href: link.href, target: link.target, rel: link.rel, title: link.textContent.trim() })));
      expect(rendered.map(link => link.href).sort()).toEqual(data.items.map(item => new URL(item.url).href).sort());
      for (const link of rendered) {
        expect(new URL(link.href).protocol).toBe("https:");
        expect(link.target).toBe("_blank");
        expect(link.rel).toContain("noopener");
        expect(link.title).not.toBe("");
      }
      await expect(page.locator("[data-resource-retry]")).toBeHidden();
    }
    if (required.includes("/api/media-galleries")) {
      const data = await responses[required.indexOf("/api/media-galleries") + 1].json();
      for (const root of await page.locator("[data-media-gallery]").all()) {
        const id = await root.getAttribute("data-media-gallery");
        const gallery = data.items.find(item => item.id === id);
        expect(gallery, `Gallery ${id} should exist in the public API`).toBeDefined();
        if (gallery.items.length) {
          await expect(root).toBeVisible();
          await expect(root.locator(".gallery-frame img")).toBeVisible();
          await expect(root.locator(".gallery-frame")).not.toHaveAttribute("aria-busy", "true");
        } else {
          await expect(root).toBeHidden();
        }
      }
    }
    await expect(page.locator(".gallery-error:visible, [data-team-retry]:visible")).toHaveCount(0);
    await expect.poll(() => page.locator("[data-site-media-slot]").evaluateAll(nodes => nodes
      .filter(node => node.getBoundingClientRect().width > 0 && node.querySelector("picture"))
      .filter(node => node.dataset.siteMediaReady !== "true").map(node => node.dataset.siteMediaSlot)),
    { timeout: 30_000, message: "Image slots must resolve instead of staying blank" }).toEqual([]);
    await inspectImages(page);
    await expect(page.locator(adminControls)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      { message: "Page must not overflow horizontally" }).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.scrollTo(0, 0));
    if (testInfo.project.use.viewport.width < 600) {
      const menu = page.locator("#navToggle");
      await menu.click();
      await expect(menu).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator('#navLinks a[href="/resources"], #navLinks a[href^="/resources#"], #navLinks a[href="#resources"]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        "Open mobile menu must not overflow horizontally").toBeLessThanOrEqual(1);
      await menu.click();
      await expect(menu).toHaveAttribute("aria-expanded", "false");
    }
  });
}
