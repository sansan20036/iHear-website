import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const publicDir = path.resolve("public");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
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
      const cleanRoutes = { "/about": "about.html", "/about/": "about.html", "/team": "team.html", "/team/": "team.html" };
      const relativePath = cleanRoutes[pathname] || pathname.replace(/^\/+/, "") || "index.html";
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
  countries: 0,
  countryNames: { zhHant: "", zhHans: "", en: "" },
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

const siteMetrics = {
  id: "impact-2027-01",
  kind: "metrics",
  period: "2027-01",
  volunteers: 41,
  volunteersPlus: true,
  students: 63,
  studentsPlus: true,
  sessions: 1299,
  sessionsPlus: true,
  countries: 5,
  countryNames: {
    zhHant: "臺灣 · 中國 · 美國 · 加拿大 · 日本",
    zhHans: "台湾 · 中国 · 美国 · 加拿大 · 日本",
    en: "Taiwan · China · United States · Canada · Japan",
  },
  title: { zhHant: "", zhHans: "", en: "" },
  description: {
    zhHant: "測試目前成果",
    zhHans: "测试目前成果",
    en: "Current metrics fixture",
  },
  status: "published",
  sortOrder: 202701,
  version: 1,
  updatedAt: "2027-01-01T00:00:00.000Z",
};

async function mockApplication(page) {
  const requests = [];
  let publishedPayload = null;
  const liveRevisions = {
    content: { revision: "1", updatedAt: "2026-07-31T00:00:00.000Z" },
    impact: { revision: "1", updatedAt: "2026-07-31T00:00:00.000Z" },
    team: { revision: "1", updatedAt: "2026-07-31T00:00:00.000Z" },
  };

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
    body: JSON.stringify({ version: 2, updatedAt: "", pages: {}, itemUpdatedAt: {} }),
  }));

  await page.route("**/api/live-revisions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ version: 1, revisions: liveRevisions }),
  }));

  await page.route("**/api/site-metrics", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ metrics: siteMetrics }),
  }));

  const teamProfile = {
    id: "tutor-test",
    personId: "person-test",
    section: "tutor",
    status: "published",
    sortOrder: 10,
    name: "Test Tutor",
    initials: "TT",
    school: "Test School",
    grade: "10",
    showSchool: true,
    showGrade: true,
    role: { en: "Lead Tutor", zhHant: "首席導師", zhHans: "首席导师" },
    schoolDisplay: { en: "Test School", zhHant: "測試學校", zhHans: "测试学校" },
    languages: { en: "English", zhHant: "英文", zhHans: "英文" },
    strengths: { en: "Confidence", zhHant: "建立自信", zhHans: "建立自信" },
    summary: { en: "English summary", zhHant: "繁中簡介", zhHans: "简中简介" },
    bio: { en: "English biography", zhHant: "繁中完整介紹", zhHans: "简中完整介绍" },
    hobbies: { en: "Reading", zhHant: "閱讀", zhHans: "阅读" },
    publicationConsentAt: "2026-07-31T00:00:00.000Z",
    profileVersion: 1,
    personVersion: 1,
    updatedAt: "2026-07-31T00:00:00.000Z",
  };

  await page.route("**/api/team-profiles**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      leaders: [],
      tutors: [teamProfile],
      people: [{ id: "person-test", name: "Test Tutor", initials: "TT", consentConfirmed: true }],
      admin: route.request().url().includes("includeDrafts=true"),
    }),
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
    liveRevisions,
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

test("favicon is linked and served from the generated public directory", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/about");

  await expect(page.locator('link[rel="icon"][href="/favicon.ico"]')).toHaveCount(1);

  const response = await page.request.get("/favicon.ico");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/x-icon");
  expect((await response.body()).byteLength).toBeGreaterThan(0);
});

test("team directory renders API data, switches language, and excludes generic pencils", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/team");

  await expect(page.locator("[data-team-tutors] .tutor-prof")).toHaveCount(1);
  await expect(page.getByText("Test Tutor")).toBeVisible();
  await page.getByText("Test Tutor").click();
  await expect(page.getByText("English biography")).toBeVisible();
  await expect(page.locator("[data-team-tutors] .ihear-inline-edit-button")).toHaveCount(0);

  await page.locator('#langSwitch button[data-lang="zhTW"]').click();
  await expect(page.getByText("繁中完整介紹")).toBeVisible();
  await page.locator('#langSwitch button[data-lang="zhCN"]').click();
  await expect(page.getByText("简中完整介绍")).toBeVisible();
});

test("team manager is mobile-safe and exposes structured editing controls", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockApplication(page);
  await page.goto("/team");

  await page.getByRole("button", { name: "Manage profiles" }).click();
  await page.getByRole("button", { name: "Add profile" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /publication consent/i })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test("homepage uses current metrics across counters, languages, and inline editing", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");

  await expect(page.locator('[data-site-metric-value="sessions"]').first()).toHaveText("1,299+");
  await expect(page.locator('[data-site-metric-value="students"]').first()).toHaveText("63+");
  await expect(page.locator('[data-site-metric-value="volunteers"]')).toHaveText("41");
  await expect(page.locator('[data-site-metric-value="countries"]')).toHaveText("5");
  await expect(page.locator("[data-site-metric-asof]")).toHaveText("as of January 2027");
  await expect(page.locator("[data-site-metric-country-names]")).toHaveText(
    "Taiwan · China · United States · Canada · Japan",
  );
  await expect(page.locator("[data-no-inline-edit] .ihear-inline-edit-button")).toHaveCount(0);

  await page.getByRole("button", { name: "繁" }).click();
  await expect(page.locator("[data-site-metric-asof]")).toHaveText("截至 2027 年 1 月");
  await expect(page.locator("[data-site-metric-country-names]")).toHaveText(
    "臺灣 · 中國 · 美國 · 加拿大 · 日本",
  );
});

for (const fallbackCase of [
  { name: "null metrics", status: 200, body: { metrics: null } },
  { name: "API failure", status: 503, body: { error: "Unavailable" } },
]) {
  test(`homepage preserves static fallback for ${fallbackCase.name}`, async ({ page }) => {
    await mockApplication(page);
    await page.route("**/api/site-metrics", (route) => route.fulfill({
      status: fallbackCase.status,
      contentType: "application/json",
      body: JSON.stringify(fallbackCase.body),
    }));
    await page.goto("/");

    await expect(page.locator('[data-site-metric-value="sessions"]').first()).toHaveText("1,200+");
    await expect(page.locator("[data-site-metric-asof]")).toHaveText("as of June 2026");
    await expect(page.locator("[data-site-metric-country-names]")).toHaveText(
      "Taiwan · China · US · Canada",
    );
  });
}

test("content overrides still apply when admin controls render before content finishes loading", async ({ page }) => {
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

  await page.route("**/api/content/get", async (route) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        updatedAt: "2026-07-31T00:00:00.000Z",
        pages: {
          "/about": {
            "section:nth-of-type(1)>div:nth-of-type(1)>div:nth-of-type(1)>h2:nth-of-type(1)": "Production override loaded",
          },
        },
      }),
    });
  });

  await page.route("**/api/impact-milestones**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ milestones: [milestone], admin: false }),
  }));

  await page.goto("/about");

  await expect(page.getByRole("heading", { name: /Production override loaded/ })).toBeVisible();
  await expect(page.locator(".ihear-inline-edit-button").first()).toBeVisible();
});

test("Google sign-in clears stale OAuth cookies before creating a new PKCE flow", async ({ page }) => {
  const authRequests = [];

  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({}),
  }));

  await page.route("**/api/content/get", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ version: 1, updatedAt: "", pages: {} }),
  }));

  await page.route("**/api/impact-milestones**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ milestones: [milestone], admin: false }),
  }));

  await page.route("**/api/auth/clear-stale", (route) => {
    authRequests.push("clear-stale");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/auth/csrf", (route) => {
    authRequests.push("csrf");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ csrfToken: "fresh-csrf-token" }),
    });
  });

  await page.route("**/api/auth/signin/google", (route) => {
    authRequests.push("signin");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "http://127.0.0.1:3210/about?oauth=started" }),
    });
  });

  await page.goto("/about");
  const signInButton = page.locator("[data-auth-desktop] [data-auth-signin]");
  await expect(signInButton).toBeVisible();
  await signInButton.click();
  await expect(page).toHaveURL("http://127.0.0.1:3210/about?oauth=started");

  expect(authRequests).toEqual(["clear-stale", "csrf", "signin"]);
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

test("mobile editor has no horizontal overflow at supported narrow widths", async ({ page }) => {
  await mockApplication(page);
  for (const width of [390, 375, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/about");
    await page.getByRole("button", { name: "繁" }).click();
    await page.getByRole("button", { name: "新增歷程" }).click();

    const sizes = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      dialogLeft: document.querySelector("dialog")?.getBoundingClientRect().left ?? 0,
      dialogRight: document.querySelector("dialog")?.getBoundingClientRect().right ?? 0,
    }));
    expect(sizes.document).toBeLessThanOrEqual(sizes.viewport);
    expect(sizes.dialogLeft).toBeGreaterThanOrEqual(-1);
    expect(sizes.dialogRight).toBeLessThanOrEqual(sizes.viewport + 1);
  }
});

test("team updates synchronize immediately across open tabs", async ({ context, page }) => {
  let teamName = "First Tutor";
  let teamRevision = "1";
  const profile = () => ({
    id: "tutor-live",
    personId: "person-live",
    section: "tutor",
    status: "published",
    sortOrder: 10,
    name: teamName,
    initials: "FT",
    school: "",
    grade: "",
    showSchool: false,
    showGrade: false,
    role: { en: "Tutor", zhHant: "導師", zhHans: "导师" },
    schoolDisplay: { en: "", zhHant: "", zhHans: "" },
    languages: { en: "English", zhHant: "英文", zhHans: "英文" },
    strengths: { en: "Support", zhHant: "支持", zhHans: "支持" },
    summary: { en: "Summary", zhHant: "簡介", zhHans: "简介" },
    bio: { en: "Biography", zhHant: "介紹", zhHans: "介绍" },
    hobbies: { en: "Reading", zhHant: "閱讀", zhHans: "阅读" },
    profileVersion: 1,
    personVersion: 1,
    updatedAt: "2026-07-31T00:00:00.000Z",
  });

  await context.route("**/api/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "{}",
  }));
  await context.route("**/api/content/get**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ version: 2, updatedAt: "", pages: {}, itemUpdatedAt: {} }),
  }));
  await context.route("**/api/live-revisions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      version: 1,
      revisions: {
        content: { revision: "1", updatedAt: "2026-07-31T00:00:00.000Z" },
        impact: { revision: "1", updatedAt: "2026-07-31T00:00:00.000Z" },
        team: { revision: teamRevision, updatedAt: "2026-07-31T00:00:00.000Z" },
      },
    }),
  }));
  await context.route("**/api/team-profiles**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ leaders: [], tutors: [profile()] }),
  }));

  const secondPage = await context.newPage();
  await Promise.all([page.goto("/team"), secondPage.goto("/team")]);
  await expect(page.getByText("First Tutor")).toBeVisible();
  await expect(secondPage.getByText("First Tutor")).toBeVisible();

  teamName = "Updated Tutor";
  teamRevision = "2";
  await page.evaluate(() => window.iHearLiveContent.announce("team", { revision: "2" }));

  await expect(page.getByText("Updated Tutor")).toBeVisible();
  await expect(secondPage.getByText("Updated Tutor")).toBeVisible();
  await secondPage.close();
});

test("live refresh restores metrics and inline content fallbacks after deletion", async ({ page }) => {
  await mockApplication(page);
  let metrics = siteMetrics;
  let content = {
    version: 2,
    updatedAt: "2026-07-31T00:00:00.000Z",
    pages: {
      "/about": {
        "section:nth-of-type(1)>div:nth-of-type(1)>div:nth-of-type(1)>h2:nth-of-type(1)": "Temporary override",
      },
    },
    itemUpdatedAt: {
      "/about": {
        "section:nth-of-type(1)>div:nth-of-type(1)>div:nth-of-type(1)>h2:nth-of-type(1)": "2026-07-31T00:00:00.000Z",
      },
    },
  };
  await page.route("**/api/site-metrics**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ metrics }),
  }));
  await page.route("**/api/content/get**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(content),
  }));

  await page.goto("/");
  await expect(page.locator('[data-site-metric-value="sessions"]').first()).toHaveText("1,299+");
  metrics = null;
  await page.evaluate(() => window.iHearLiveContent.announce("impact", { revision: "2" }));
  await expect(page.locator('[data-site-metric-value="sessions"]').first()).toHaveText("1,200+");

  await page.goto("/about");
  await expect(page.getByRole("heading", { name: /Temporary override/ })).toBeVisible();
  content = { version: 2, updatedAt: "", pages: {}, itemUpdatedAt: {} };
  await page.evaluate(() => window.iHearLiveContent.announce("content", { revision: "2" }));
  await expect(page.getByRole("heading", { name: /Why iHear exists/ })).toBeVisible();
});
