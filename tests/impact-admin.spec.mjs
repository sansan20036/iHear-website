import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const publicDir = path.resolve("public");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
let testServer;

test.beforeAll(async () => {
  testServer = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1:3210").pathname;
      const relativePath = pathname === "/about" || pathname === "/about/"
        ? "about.html"
        : pathname.replace(/^\/+/, "") || "index.html";
      const filePath = path.resolve(publicDir, relativePath);

      if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }

      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolve, reject) => {
    testServer.once("error", reject);
    testServer.listen(3210, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    testServer.close((error) => (error ? reject(error) : resolve()));
  });
});

const milestone = {
  id: "journey-2024-06",
  kind: "event",
  period: "2024-06",
  volunteers: 0,
  volunteersPlus: false,
  students: 0,
  studentsPlus: false,
  sessions: 0,
  sessionsPlus: false,
  title: {
    zhHant: "試辦階段開始",
    zhHans: "试办阶段开始",
    en: "Pilot phase begins",
  },
  description: {
    zhHant: "測試資料",
    zhHans: "测试资料",
    en: "Test data",
  },
  status: "published",
  sortOrder: 202406,
  version: 1,
  createdAt: "2024-06-01T00:00:00.000Z",
  updatedAt: "2024-06-01T00:00:00.000Z",
  updatedBy: "test@example.com",
};

async function mockApplication(page) {
  const requests = [];
  let publishedPayload = null;

  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      user: {
        name: "Environment Admin",
        email: "configured-only-in-env@example.com",
        isAdmin: true,
      },
    }),
  }));

  await page.route("**/api/content/get", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ version: 1, updatedAt: "", pages: {} }),
  }));

  await page.route("**/api/impact-milestones**", async (route) => {
    const request = route.request();
    requests.push(`${request.method()} ${request.url()}`);

    if (request.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          milestones: [milestone],
          admin: request.url().includes("includeDrafts=true"),
        }),
      });
    }

    publishedPayload = request.postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ milestone: { ...milestone, ...publishedPayload, id: "journey-test" } }),
    });
  });

  return {
    requests,
    getPublishedPayload: () => publishedPayload,
  };
}

test("environment-defined admin receives inline editing controls", async ({ page }) => {
  const requestedUrls = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  await mockApplication(page);
  await page.goto("/about");

  await expect(page.locator(".ihear-inline-edit-button").first()).toBeVisible();
  await expect(page.locator('script[src*="cloudflareinsights.com"]')).toHaveCount(0);
  expect(requestedUrls.some((url) => url.includes("/cdn-cgi/rum"))).toBe(false);
});

test("manual multilingual editor clears stale copy status and publishes once complete", async ({ page }) => {
  const mocked = await mockApplication(page);
  await page.goto("/about");
  await page.getByRole("button", { name: "繁" }).click();

  await page.getByRole("button", { name: "新增歷程" }).click();
  await page.getByRole("textbox", { name: "標題 — 繁體中文" }).fill("人工翻譯測試");
  await page.getByRole("textbox", { name: "說明文案 — 繁體中文" }).fill("繁體中文測試說明。");

  await page.getByRole("button", { name: "發布" }).click();
  const combinedError = page.getByText("發布前必須完成三種語言的標題與說明文案。");
  await expect(combinedError).toHaveCount(1);

  await page.getByRole("tab", { name: "简体中文 (未填寫)" }).click();
  await page.getByRole("button", { name: "複製自 繁體中文" }).click();
  await expect(page.locator("[data-manual-status]")).toContainText("已複製自");

  await page.getByRole("tab", { name: "English (未填寫)" }).click();
  await expect(page.locator("[data-manual-status]")).toHaveText("");
  await page.getByRole("button", { name: "複製自 繁體中文" }).click();
  await page.getByRole("textbox", { name: "標題 — English" }).fill("Manual translation test");
  await page.getByRole("textbox", { name: "說明文案 — English" }).fill("English text revised by an administrator.");

  await page.getByRole("button", { name: "發布" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(mocked.getPublishedPayload()?.status).toBe("published");
  expect(mocked.requests.some((request) => request.includes("/translate"))).toBe(false);
});

test("mobile editor has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApplication(page);
  await page.goto("/about");
  await page.getByRole("button", { name: "繁" }).click();
  await page.getByRole("button", { name: "新增歷程" }).click();

  const sizes = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport);
});
