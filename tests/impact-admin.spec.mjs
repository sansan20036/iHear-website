import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const publicDir = path.resolve("public");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
let testServer;
const e2ePort = Number(process.env.IHEAR_E2E_PORT || 3210);
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;

async function previewAndSaveMedia(dialog) {
  const save = dialog.locator("[data-media-save]");
  await save.click();
  await expect(dialog.locator("[data-media-status]")).toContainText(/preview ready|預覽已完成|预览已完成|descriptions are ready|圖片描述已完成|图片描述已完成/);
  await expect(save).toBeEnabled();
  await save.click();
}

test.beforeAll(async () => {
  testServer = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, e2eOrigin).pathname;
      const cleanRoutes = Object.fromEntries([
        "about", "programs", "impact", "team", "submit-bio", "stories", "get-involved",
        "academy", "donate", "resources", "faq", "contact",
      ].flatMap((route) => [[`/${route}`, `${route}.html`], [`/${route}/`, `${route}.html`]]));
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
    testServer.listen(e2ePort, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  testServer.closeIdleConnections?.();
  testServer.closeAllConnections?.();
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

const previousMetrics = {
  ...siteMetrics,
  id: "impact-2026-12",
  period: "2026-12",
  volunteers: 38,
  students: 58,
  sessions: 1100,
  sortOrder: 202612,
};

const futureJourneyEvent = {
  ...milestone,
  id: "journey-2028-01",
  period: "2028-01",
  title: {
    zhHant: "未來一般歷程",
    zhHans: "未来一般历程",
    en: "Future journey event",
  },
  sortOrder: 202801,
};

async function mockApplication(page, { admin = true, duplicateAvatar = false, tutorName = "Test Tutor" } = {}) {
  const requests = [];
  let publishedPayload = null;
  let translationPreviewCount = 0;
  const mediaItems = {};
  let mediaUploadCount = 0;
  let mediaMutationDelay = 0;
  let mediaMutationFailure = false;
  let mediaCommitThenFailure = false;
  let mediaStaleReads = 0;
  let mediaStaleItems = null;
  let themeSetting = { theme: "warm", recordVersion: 1, updatedAt: "2026-08-17T00:00:00.000Z" };
  let themeReadOverride = null;
  let themeGetCount = 0;
  const layoutRecords = new Map([["/__global__", { page: "/__global__", config: { hiddenSections: [], orders: {}, links: {} }, recordVersion: 1, updatedAt: "" }]]);
  let layoutPostCount = 0;
  let layoutDelay = 0;
  let contentResponse = {
    version: 3,
    updatedAt: "",
    locales: {
      en: { pages: {}, itemUpdatedAt: {} },
      zhHant: { pages: {}, itemUpdatedAt: {} },
      zhHans: { pages: {}, itemUpdatedAt: {} },
    },
  };
  const liveRevisions = {
    content: { revision: "1", updatedAt: "2026-07-31T00:00:00.000Z" },
    impact: { revision: "1", updatedAt: "2026-07-31T00:00:00.000Z" },
    team: { revision: "1", updatedAt: "2026-07-31T00:00:00.000Z" },
    theme: { revision: "1", updatedAt: "2026-08-17T00:00:00.000Z" },
    layout: { revision: "1", updatedAt: "2026-08-23T00:00:00.000Z" },
  };

  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(admin ? {
      user: {
        name: "Environment Admin",
        email: "configured-only-in-env@example.com",
        isAdmin: true,
      },
    } : {}),
  }));

  await page.route("**/api/content/get**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(contentResponse),
  }));

  await page.route("**/api/live-revisions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ version: 1, revisions: liveRevisions }),
  }));

  await page.route("**/api/admin/translations/preview", (route) => {
    translationPreviewCount += 1;
    const submitted = route.request().postDataJSON();
    const fields = Object.fromEntries(Object.entries(submitted.fields || {}).map(([field, value]) => [field, {
      value: {
        en: value.en || "",
        zhHant: value.zhHant || `繁中 ${value.en || ""}`,
        zhHans: value.zhHans || `简中 ${value.en || ""}`,
      },
      zhHantStatus: value.zhHant ? "protected" : "translated",
      zhHansStatus: value.zhHans ? "protected" : "translated",
    }]));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receipt: "e2e-signed-receipt", fields }) });
  });

  await page.route("**/api/admin/translations/traditionalize", (route) => {
    const submitted = route.request().postDataJSON();
    const value = String(submitted.value || "").replaceAll("开发", "開發").replaceAll("服务器", "伺服器").replaceAll("软件", "軟體");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ value }) });
  });

  await page.route("**/api/site-layout**", async (route) => {
    const request = route.request();
    const pagePath = new URL(request.url()).searchParams.get("page") || "/";
    if (!layoutRecords.has(pagePath)) layoutRecords.set(pagePath, { page: pagePath, config: { hiddenSections: [], orders: {}, links: {} }, recordVersion: 1, updatedAt: "" });
    const records = [layoutRecords.get("/__global__"), layoutRecords.get(pagePath)];
    if (new URL(request.url()).pathname.endsWith("/bootstrap")) return route.fulfill({ status: 200, contentType: "application/javascript", body: `window.__IHEAR_SITE_LAYOUT__=${JSON.stringify({ version: 1, page: pagePath, records })};` });
    if (request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 1, records }) });
    const submitted = request.postDataJSON();
    layoutPostCount += 1;
    if (layoutDelay) await new Promise((resolve) => { setTimeout(resolve, layoutDelay); });
    const updates = submitted.updates || [submitted];
    if (updates.some((update) => !layoutRecords.has(update.page) || layoutRecords.get(update.page).recordVersion !== update.expectedVersion)) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Layout changed elsewhere" }) });
    }
    const saved = updates.map((update) => {
      const current = layoutRecords.get(update.page);
      const next = { page: update.page, config: update.config, recordVersion: current.recordVersion + 1, updatedAt: "2026-08-23T00:01:00.000Z" };
      layoutRecords.set(update.page, next); return next;
    });
    liveRevisions.layout = { revision: String(Number(liveRevisions.layout.revision) + 1), updatedAt: "2026-08-23T00:01:00.000Z" };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(submitted.updates ? { ok: true, records: saved, revision: liveRevisions.layout } : { ok: true, record: saved[0], revision: liveRevisions.layout }) });
  });

  await page.route("**/api/site-theme**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/bootstrap")) {
      return route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `(()=>{const s=${JSON.stringify(themeSetting)};document.documentElement.dataset.theme=s.theme;window.__IHEAR_SITE_THEME__=s;try{localStorage.setItem("ihear:site-theme",s.theme)}catch{}})();`,
      });
    }
    if (request.method() === "GET") {
      themeGetCount += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 1, ...(themeReadOverride || themeSetting) }) });
    }
    const payload = request.postDataJSON();
    if (payload.expectedVersion !== themeSetting.recordVersion) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "conflict" }) });
    }
    themeSetting = { theme: payload.theme, recordVersion: themeSetting.recordVersion + 1, updatedAt: "2026-08-17T00:01:00.000Z" };
    liveRevisions.theme = { revision: String(Number(liveRevisions.theme.revision) + 1), updatedAt: themeSetting.updatedAt };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, ...themeSetting, revision: liveRevisions.theme }),
    });
  });

  await page.route("**/api/site-media**", async (route) => {
    const request = route.request();
    const method = request.method();
    const requestUrl = new URL(request.url());
    if (method === "GET" && requestUrl.pathname.endsWith("/source")) {
      return route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: await readFile(path.resolve("assets/images/hero-classroom-800.webp")),
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (method === "GET") {
      const responseItems = mediaStaleReads > 0 && mediaStaleItems
        ? mediaStaleItems
        : mediaItems;
      if (mediaStaleReads > 0) mediaStaleReads -= 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: 1, items: responseItems }),
      });
    }
    const slot = decodeURIComponent(requestUrl.pathname.split("/").pop());
    requests.push(`${method} ${request.url()}`);
    if (mediaMutationDelay > 0) await new Promise((resolve) => { setTimeout(resolve, mediaMutationDelay); });
    if (mediaMutationFailure) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated media failure" }),
      });
    }
    if (method === "DELETE") {
      delete mediaItems[slot];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, slot, revision: "2" }),
      });
    }
    mediaUploadCount += 1;
    const isTutoring = slot === "services.tutoring";
    const isOutreach = slot === "services.outreach";
    const isVolunteers = slot === "global.volunteers";
    const isAvatar = slot.startsWith("team.");
    const item = {
      slot,
      alt: isTutoring ? {
        en: "Student receiving individual tutoring",
        zhHant: "學生接受一對一英語輔導",
        zhHans: "学生接受一对一英语辅导",
      } : isOutreach ? {
        en: "Community members attending a hearing seminar",
        zhHant: "社區成員參與聽力健康講座",
        zhHans: "社区成员参与听力健康讲座",
      } : isVolunteers ? {
        en: "Young volunteers celebrating outdoors",
        zhHant: "年輕志工在戶外一同慶祝",
        zhHans: "年轻志愿者在户外一同庆祝",
      } : isAvatar ? {
        en: "Portrait of Zoe Lu",
        zhHant: "Zoe Lu 的個人頭像",
        zhHans: "Zoe Lu 的个人头像",
      } : {
        en: "Students learning communication skills",
        zhHant: "學生學習溝通技巧",
        zhHans: "学生学习沟通技巧",
      },
      focalX: isAvatar ? 50 : isTutoring ? 0 : isOutreach ? 100 : 50,
      focalY: isAvatar ? 50 : isTutoring ? 100 : isOutreach ? 0 : 50,
      zoom: 100,
      recordVersion: mediaUploadCount,
      updatedAt: "2026-08-16T00:00:00.000Z",
      src: "/assets/images/volunteers-1200.webp",
      srcSet: "/assets/images/volunteers-480.webp 480w, /assets/images/volunteers-800.webp 800w, /assets/images/volunteers-1200.webp 1200w",
      variants: (isAvatar ? [480, 800] : [480, 800, 1200]).map((width) => ({
        width,
        pixelWidth: width,
        pixelHeight: isAvatar ? width : Math.round(width * 0.75),
        byteSize: 1000,
        mimeType: "image/webp",
        url: `/assets/images/volunteers-${width}.webp`,
      })),
    };
    mediaItems[slot] = item;
    if (mediaCommitThenFailure) {
      return route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated response timeout" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, item, revision: "2" }),
    });
  });

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
    name: tutorName,
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

  const zoeProfile = {
    ...teamProfile,
    id: "leader-zoe-lu",
    personId: "person-zoe-lu",
    section: "leader",
    sortOrder: 10,
    name: "Zoe Lu",
    initials: "ZL",
    role: { en: "Founder & Co-President", zhHant: "創辦人暨共同會長", zhHans: "创办人暨共同会长" },
    bio: { en: "Leadership biography", zhHant: "領導團隊介紹", zhHans: "领导团队介绍" },
  };
  const danielProfile = {
    ...zoeProfile,
    id: "leader-daniel-hollis",
    personId: "person-daniel-hollis",
    sortOrder: 20,
    name: "Daniel Hollis",
    initials: "DH",
  };
  const howardProfile = {
    ...zoeProfile,
    id: "leader-howard-ren",
    personId: "person-howard-m-ren",
    sortOrder: 30,
    name: "Howard M. Ren",
    initials: "HR",
  };
  const zoeTutorProfile = {
    ...zoeProfile,
    id: "tutor-zoe-lu",
    section: "tutor",
    sortOrder: 20,
  };

  await page.route("**/api/team-profiles**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      leaders: [zoeProfile, danielProfile, howardProfile],
      tutors: duplicateAvatar ? [teamProfile, zoeTutorProfile] : [teamProfile],
      people: [
        { id: "person-zoe-lu", name: "Zoe Lu", initials: "ZL", consentConfirmed: true },
        { id: "person-daniel-hollis", name: "Daniel Hollis", initials: "DH", consentConfirmed: true },
        { id: "person-howard-m-ren", name: "Howard M. Ren", initials: "HR", consentConfirmed: true },
        { id: "person-test", name: tutorName, initials: "TT", consentConfirmed: true },
      ],
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
          milestones: [milestone, previousMetrics, siteMetrics, futureJourneyEvent],
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
    getTranslationPreviewCount: () => translationPreviewCount,
    getMediaItem: (slot = "home.hero") => mediaItems[slot] || null,
    getMediaUploadCount: () => mediaUploadCount,
    setMediaMutationDelay: (value) => { mediaMutationDelay = value; },
    setMediaMutationFailure: (value) => { mediaMutationFailure = value; },
    setMediaCommitThenFailure: (value) => { mediaCommitThenFailure = value; },
    setMediaStaleReads: (value) => {
      mediaStaleItems = structuredClone(mediaItems);
      mediaStaleReads = value;
    },
    getTheme: () => themeSetting,
    getThemeGetCount: () => themeGetCount,
    getLayoutPostCount: () => layoutPostCount,
    getLayoutRecord: (scope) => layoutRecords.get(scope),
    setLayoutDelay: (value) => { layoutDelay = value; },
    setThemeReadOverride: (value) => { themeReadOverride = value; },
    setContentItemVersion: (pagePath, key, version) => {
      contentResponse = structuredClone(contentResponse);
      for (const language of ["en", "zhHant", "zhHans"]) {
        contentResponse.locales[language].itemUpdatedAt[pagePath] ||= {};
        contentResponse.locales[language].itemUpdatedAt[pagePath][key] = version;
      }
    },
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

test("administrator avatar menu is the only public-site admin navigation entry", async ({ page }) => {
  await mockApplication(page);

  for (const route of ["/", "/team", "/impact"]) {
    await page.goto(route);
    await expect(page.locator(".auth-admin-link")).toHaveCount(2);
    await expect(page.locator('a[href^="/admin"]:not(.auth-admin-link)')).toHaveCount(0);
    await expect(page.locator(".site-metrics-admin-row")).toHaveCount(0);
  }

  await page.goto("/");
  const profile = page.locator("[data-auth-desktop] .auth-profile");
  await profile.click();
  const popover = page.locator("[data-auth-desktop] .auth-popover");
  await expect(popover).toBeVisible();
  await expect(page.locator('.auth-admin-link:visible')).toHaveCount(1);
  await expect(popover.locator(".auth-admin-link")).toHaveAttribute("href", "/admin");
  await expect(popover.locator(".auth-admin-link")).toHaveText(/Admin dashboard/);
  await expect(popover.locator("[data-auth-signout]")).toHaveText("Sign out");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(profile).toBeFocused();

  await page.locator('#langSwitch button[data-lang="zhTW"]').click();
  await page.locator("[data-auth-desktop] .auth-profile").click();
  await expect(page.locator("[data-auth-desktop] .auth-admin-link")).toContainText("管理後台");
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

test("all static i18n text has an explicit semantic editable slot", async ({ page }) => {
  await mockApplication(page, { admin: false });
  const routes = ["/", "/about", "/programs", "/impact", "/team", "/submit-bio", "/stories", "/get-involved", "/academy", "/donate", "/resources", "/faq", "/contact"];
  const managed = new Set(["latest_label", "latest_period", "latest_headline", "latest_description", "latest_link", "stat_asof", "stat_countries_sub"]);
  for (const route of routes) {
    await page.goto(route);
    const missing = await page.locator("[data-i18n]").evaluateAll((nodes, excluded) => nodes.filter((node) => !excluded.includes(node.dataset.i18n) && !node.hasAttribute("data-editable-content")).map((node) => node.dataset.i18n), [...managed]);
    expect(missing, route).toEqual([]);
  }
});

test("language switching reapplies semantic overrides from memory", async ({ page }) => {
  await mockApplication(page);
  await page.route("**/api/content/get**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 3, updatedAt: "", locales: {
    en: { pages: { "/": { "home.mission.heading": "English override" } }, itemUpdatedAt: {} },
    zhHant: { pages: { "/": { "home.mission.heading": "繁中覆寫" } }, itemUpdatedAt: {} },
    zhHans: { pages: { "/": { "home.mission.heading": "简中覆写" } }, itemUpdatedAt: {} },
  } }) }));
  await page.goto("/");
  const heading = page.locator('[data-editable-content="home.mission.heading"]');
  const external = page.locator('a[data-editable-content][target="_blank"]').first();
  await external.evaluate((link) => { window.__externalHintNode = link.querySelector(".external-hint"); });
  await expect(heading).toHaveText("English override");
  await page.getByRole("button", { name: "繁" }).click(); await expect(heading).toHaveText("繁中覆寫");
  await page.getByRole("button", { name: "简" }).click(); await expect(heading).toHaveText("简中覆写");
  expect(await external.evaluate((link) => window.__externalHintNode === link.querySelector(".external-hint"))).toBe(true);
});

test("language safeguards pause a Chinese English source and preview Taiwan Traditional conversion", async ({ page }) => {
  const mocked = await mockApplication(page);
  await page.goto("/");
  const target = page.locator('[data-editable-content="home.stat.countries"]');
  await expect(page.locator(".ihear-inline-edit-button")).toBeVisible();
  await target.evaluate((element) => element.click());
  const dialog = page.locator(".ihear-content-dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("textbox", { name: "English" }).fill("這是一整段中文內容");
  await expect(dialog.getByText(/Chinese content was detected/)).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(mocked.getTranslationPreviewCount()).toBe(0);

  await dialog.getByRole("button", { name: "Translate this content anyway" }).click();
  await page.waitForTimeout(1_000);
  expect(mocked.getTranslationPreviewCount()).toBe(0);

  await dialog.getByRole("button", { name: "Generate translation preview" }).click();
  await expect.poll(() => mocked.getTranslationPreviewCount()).toBe(1);
  await expect(dialog.getByText(/Chinese preview ready/)).toBeVisible();

  await dialog.getByRole("tab", { name: "繁體中文" }).click();
  const traditional = dialog.getByRole("textbox", { name: "繁體中文" });
  await traditional.fill("This English sentence was pasted into Chinese");
  await expect(dialog.getByText(/contains no Chinese characters/)).toBeVisible();
  await traditional.fill("开发服务器和软件");
  await dialog.getByRole("button", { name: "Convert to Taiwan Traditional Chinese" }).click();
  await expect(dialog.getByText("開發伺服器和軟體", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Apply conversion" }).click();
  await expect(traditional).toHaveValue("開發伺服器和軟體");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("a media revision refreshes around a text draft without reporting a false content conflict", async ({ page }) => {
  const mocked = await mockApplication(page);
  await page.goto("/programs");
  const key = "shared.train2.title";
  await page.locator(`[data-editable-content="${key}"]`).click();
  const dialog = page.locator(".ihear-content-dialog");
  const english = dialog.getByRole("textbox", { name: "English" });
  await english.fill("Mentorship draft that must remain intact");

  await page.evaluate(() => window.iHearLiveContent.announce("content", { revision: "2" }));
  await expect(english).toHaveValue("Mentorship draft that must remain intact");
  await expect(page.locator(".ihear-inline-live-notice")).toBeHidden();

  mocked.setContentItemVersion("/__global__", key, "2026-09-02T00:00:00.000Z");
  await page.evaluate(() => window.iHearLiveContent.announce("content", { revision: "3" }));
  await expect(page.locator(".ihear-inline-live-notice")).toBeVisible();
  await expect(english).toHaveValue("Mentorship draft that must remain intact");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("static card reordering preserves the exact DOM nodes", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/programs");
  const result = await page.evaluate(() => {
    const container = document.querySelector('[data-layout-group="programs.services"]');
    const before = Array.from(container.children);
    window.iHearSiteLayout.moveExisting(container, ["outreach", "tutoring"]);
    const after = Array.from(container.children);
    return { sameFirst: before[1] === after[0], sameSecond: before[0] === after[1], order: after.map((node) => node.dataset.layoutItem) };
  });
  expect(result).toEqual({ sameFirst: true, sameSecond: true, order: ["outreach", "tutoring"] });
});

test("layout settings use the page control without a hover toolbar", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/resources");
  await page.locator('[data-layout-group="resources.guides"]').hover();
  await expect(page.locator(".ihear-layout-quick")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Adjust this page layout" })).toBeVisible();
});

test("visual layout drawer publishes one atomic batch and preserves keyed card nodes", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const mocked = await mockApplication(page);
  mocked.setLayoutDelay(250);
  await page.goto("/programs");
  await page.evaluate(() => { const nodes = document.querySelectorAll('[data-layout-group="programs.services"] > [data-layout-item]'); window.__programNodes = Array.from(nodes); });
  await page.getByRole("button", { name: "Adjust this page layout" }).click();
  const dialog = page.getByRole("dialog", { name: "Adjust this page layout" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => ({ width: node.getBoundingClientRect().width, viewport: innerWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }))).toEqual({ width: 320, viewport: 320, overflow: false });
  await expect(dialog).not.toContainText(/programs\.how|programs\.services|site\.cta|\.href/);
  await dialog.getByRole("switch", { name: /How to get started/ }).uncheck();
  await dialog.getByRole("tab", { name: "Card order" }).click();
  await dialog.getByRole("button", { name: "Move down: One-to-one English tutoring" }).click();
  await dialog.getByRole("tab", { name: "Button links" }).click();
  const linkCard = dialog.locator(".ihear-layout-link-card").filter({ hasText: "Request tutoring button" }).first();
  await linkCard.getByRole("textbox", { name: "Link address" }).fill("https://example.org/request");
  await expect(linkCard).toContainText("This shared link appears");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog).toBeHidden(); await expect(page.getByText("Previewing unpublished layout changes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Return to settings" }).click();
  await dialog.getByRole("button", { name: "Review and publish" }).click();
  await expect(dialog).toContainText("This page"); await expect(dialog).toContainText("Across the site");
  await dialog.getByRole("button", { name: "Confirm publish" }).evaluate((node) => { node.click(); node.click(); node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await expect(dialog.getByRole("button", { name: "Publishing…" })).toBeDisabled();
  await expect(dialog).toBeHidden();
  expect(mocked.getLayoutPostCount()).toBe(1);
  await expect(page.locator('[data-layout-section="programs.how"]')).toBeHidden();
  await expect(page.locator('[data-layout-link="site.cta.request_tutoring.href"]').first()).toHaveAttribute("href", "https://example.org/request");
  const result = await page.evaluate(() => { const nodes = Array.from(document.querySelectorAll('[data-layout-group="programs.services"] > [data-layout-item]')); return { order: nodes.map((node) => node.dataset.layoutItem), same: nodes[0] === window.__programNodes[1] && nodes[1] === window.__programNodes[0], overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; });
  expect(result).toEqual({ order: ["outreach", "tutoring"], same: true, overflow: false });
  await page.getByRole("button", { name: "Undo this publish" }).click();
  await expect(page.getByText("The previous layout was restored.")).toBeVisible();
  await expect(page.locator('[data-layout-section="programs.how"]')).toBeVisible();
  const restored = await page.evaluate(() => { const nodes = Array.from(document.querySelectorAll('[data-layout-group="programs.services"] > [data-layout-item]')); return { order: nodes.map((node) => node.dataset.layoutItem), same: nodes[0] === window.__programNodes[0] && nodes[1] === window.__programNodes[1] }; });
  expect(restored).toEqual({ order: ["tutoring", "outreach"], same: true });
});

test("layout drawer follows all three languages without losing its draft", async ({ page }) => {
  await mockApplication(page); await page.goto("/programs");
  await page.getByRole("button", { name: "Adjust this page layout" }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("switch", { name: /How to get started/ }).uncheck();
  await dialog.getByRole("button", { name: "繁", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "調整本頁版面" })).toBeVisible(); await expect(dialog).toContainText("尚有 1 項未發布變更");
  await dialog.getByRole("button", { name: "简", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "调整本页版面" })).toBeVisible(); await expect(dialog).toContainText("还有 1 项未发布更改");
  await dialog.getByRole("button", { name: "EN", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: /How to get started/ })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.locator('[data-layout-section="programs.how"]')).toBeVisible();
});

test("layout drawer fits desktop, narrow mobile, and short landscape viewports", async ({ page }) => {
  await mockApplication(page);
  for (const viewport of [
    { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 900 },
    { width: 390, height: 844 }, { width: 375, height: 812 }, { width: 320, height: 720 }, { width: 568, height: 320 },
  ]) {
    await page.setViewportSize(viewport); await page.goto("/programs"); await page.getByRole("button", { name: "Adjust this page layout" }).click();
    const dialog = page.getByRole("dialog", { name: "Adjust this page layout" }); await expect(dialog).toBeVisible();
    const metrics = await dialog.evaluate((node) => ({
      width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height),
      viewportWidth: innerWidth, viewportHeight: innerHeight, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      panelScrollable: node.querySelector(".ihear-layout-panel").scrollHeight >= node.querySelector(".ihear-layout-panel").clientHeight,
    }));
    expect(metrics.width).toBe(viewport.width <= 390 ? viewport.width : 380); expect(metrics.height).toBe(viewport.height); expect(metrics.pageOverflow).toBe(false); expect(metrics.panelScrollable).toBe(true);
    await dialog.getByRole("button", { name: "Close" }).click();
  }
});

test("pages without supported layout slots do not show administrator layout controls", async ({ page }) => {
  await mockApplication(page); await page.goto("/faq");
  await page.evaluate(() => {
    document.querySelectorAll("[data-layout-section],[data-layout-group],[data-layout-link]").forEach((node) => {
      node.removeAttribute("data-layout-section"); node.removeAttribute("data-layout-group"); node.removeAttribute("data-layout-link");
    });
    window.dispatchEvent(new CustomEvent("ihear:auth", { detail: { session: { user: { isAdmin: true } } } }));
  });
  await expect(page.locator(".ihear-layout-trigger")).toHaveCount(0);
});

test("layout metadata failure shows a friendly message without engineering identifiers", async ({ page }) => {
  await mockApplication(page); await page.route("**/assets/layout-slots.json", (route) => route.fulfill({ status: 503, body: "unavailable" })); await page.goto("/programs");
  await page.getByRole("button", { name: "Adjust this page layout" }).click(); const dialog = page.getByRole("dialog", { name: "Adjust this page layout" });
  await expect(dialog).toContainText("Page settings could not be loaded"); await expect(dialog).not.toContainText(/programs\.|site\.|\.href/);
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(page.getByRole("button", { name: "Adjust this page layout" })).toBeFocused();
});

test("failed layout publish keeps the draft and permits a deliberate retry", async ({ page }) => {
  let failedPosts = 0; await mockApplication(page);
  await page.route("**/api/site-layout", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    failedPosts += 1; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "internal detail" }) });
  });
  await page.goto("/programs"); await page.getByRole("button", { name: "Adjust this page layout" }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("switch", { name: /How to get started/ }).uncheck(); await dialog.getByRole("button", { name: "Review and publish" }).click(); await dialog.getByRole("button", { name: "Confirm publish" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Your draft is still here"); expect(failedPosts).toBe(1); await expect(dialog.getByRole("button", { name: "Confirm publish" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Back to editing" }).click(); await expect(dialog.getByRole("switch", { name: /How to get started/ })).not.toBeChecked();
});

test("an external layout revision protects a dirty draft and pauses publishing", async ({ page }) => {
  const mocked = await mockApplication(page); await page.goto("/programs"); await page.evaluate(() => window.iHearLiveContent.checkNow({ force: true }));
  await page.getByRole("button", { name: "Adjust this page layout" }).click(); const dialog = page.getByRole("dialog"); await dialog.getByRole("switch", { name: /How to get started/ }).uncheck();
  mocked.liveRevisions.layout = { revision: "9", updatedAt: "2026-08-24T00:00:00.000Z" }; await page.evaluate(() => window.iHearLiveContent.checkNow({ force: true }));
  await expect(dialog.getByRole("alert")).toContainText("changed in another tab"); await expect(dialog.getByRole("button", { name: "Review and publish" })).toBeDisabled(); await expect(dialog.getByRole("switch", { name: /How to get started/ })).not.toBeChecked();
});

test("layout bootstrap hides configured sections before first paint without CLS", async ({ page }) => {
  await mockApplication(page, { admin: false });
  await page.route("**/assets/site-layout.js**", async (route) => { const response = await route.fetch(); const client = await response.text(); const measure = `(function(name){document.addEventListener("DOMContentLoaded",function(){const target=document.querySelector('[data-layout-section="home.video"]'),next=target&&target.nextElementSibling;window[name]={hidden:target?getComputedStyle(target).display==="none":false,nextTop:next?next.getBoundingClientRect().top:null}}, {once:true})})`; await route.fulfill({ response, body: `${measure}("__layoutBeforeClient");\n${client}\n${measure}("__layoutAfterClient");` }); });
  await page.route("**/api/site-layout/bootstrap**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: `(()=>{window.__IHEAR_SITE_LAYOUT__={version:1,page:"/",records:[{page:"/",config:{hiddenSections:["home.video"],orders:{},links:{}},recordVersion:1,updatedAt:""}]};const s=document.createElement("style");s.id="ihear-layout-bootstrap-style";s.textContent='[data-layout-section="home.video"]{display:none!important}';document.head.appendChild(s)})();` }));
  await page.goto("/");
  await expect(page.locator('[data-layout-section="home.video"]')).toBeHidden();
  const positions = await page.evaluate(() => ({ before: window.__layoutBeforeClient, after: window.__layoutAfterClient }));
  expect(positions.before).toEqual(positions.after);
});

test("administrator previews, cancels, publishes, and restores the global theme", async ({ page }) => {
  const mocked = await mockApplication(page);
  await page.goto("/about");
  const trigger = page.getByRole("button", { name: "Change theme" });
  await expect(trigger).toBeVisible();

  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Site background theme" });
  await expect(dialog).toBeVisible();
  await page.getByLabel("Sage Green").check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sage");
  await dialog.locator("[data-site-theme-cancel]").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "warm");

  await trigger.click();
  await page.getByLabel("Ocean Blue").check();
  await page.getByRole("button", { name: "Apply theme" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ocean");
  expect(mocked.getTheme()).toMatchObject({ theme: "ocean", recordVersion: 2 });

  await trigger.click();
  await page.getByRole("button", { name: "Preview default" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "warm");
  expect(mocked.getTheme().theme).toBe("ocean");
  await page.getByRole("button", { name: "Apply theme" }).click();
  await expect(dialog).toBeHidden();
  expect(mocked.getTheme().theme).toBe("warm");
});

test("donate page follows the active site theme palette", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/donate");
  const section = page.locator("body.subpage .donate");
  const heading = page.getByRole("heading", { level: 1, name: "Every contribution creates opportunity" });
  const card = page.locator(".donate-card").first();

  await expect(section).toHaveCSS("background-color", "rgb(250, 247, 242)");
  await expect(heading).toHaveCSS("color", "rgb(38, 57, 116)");
  await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await page.getByRole("button", { name: "Change theme" }).click();
  await page.getByLabel("Sage Green").check();
  await expect(section).toHaveCSS("background-color", "rgb(241, 245, 242)");
  await expect(heading).toHaveCSS("color", "rgb(38, 57, 116)");
  await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.getByRole("dialog", { name: "Site background theme" }).locator("[data-site-theme-cancel]").click();
});

test("published theme cannot be downgraded by a stale live-refresh response", async ({ page }) => {
  const mocked = await mockApplication(page);
  await page.goto("/about");
  await page.getByRole("button", { name: "Change theme" }).click();
  await page.getByLabel("Lavender Mist").check();
  const readsBeforeSave = mocked.getThemeGetCount();
  await page.getByRole("button", { name: "Apply theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "lavender");
  await page.waitForTimeout(100);
  expect(mocked.getThemeGetCount()).toBe(readsBeforeSave);

  mocked.setThemeReadOverride({ theme: "warm", recordVersion: 1, updatedAt: "2026-08-17T00:00:00.000Z" });
  await page.evaluate(() => {
    const channel = new BroadcastChannel("ihear-content-updates");
    channel.postMessage({ id: `stale-theme-${Date.now()}`, clientId: "regression-test", scope: "theme", revision: "999", timestamp: Date.now() });
    setTimeout(() => channel.close(), 100);
  });
  await expect.poll(() => mocked.getThemeGetCount()).toBeGreaterThan(readsBeforeSave);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "lavender");
});

test("theme control is admin-only, localized, keyboard-safe, and mobile-safe", async ({ page }) => {
  await mockApplication(page, { admin: false });
  await page.goto("/about");
  await expect(page.getByRole("button", { name: "Change theme" })).toHaveCount(0);

  await page.unrouteAll({ behavior: "wait" });
  await mockApplication(page);
  await page.reload();
  await page.locator('[data-lang="zhTW"]').first().click();
  const trigger = page.getByRole("button", { name: "更換主題色" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "全站背景主題" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 320, height: 720 });
  await trigger.click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
});

test("Hero image editor compresses before upload and restores the repository fallback", async ({ page }) => {
  const mocked = await mockApplication(page);
  await page.goto("/");

  const vendor = await page.request.get("/assets/vendor/browser-image-compression.js");
  expect(vendor.status()).toBe(200);
  expect(vendor.headers()["content-type"]).toContain("javascript");
  expect((await vendor.body()).byteLength).toBeGreaterThan(1000);

  const hero = page.locator('[data-site-media-slot="home.hero"]');
  await hero.hover();
  await hero.locator(".site-media-edit").click();
  const dialog = page.locator(".site-media-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-media-file]").setInputFiles("assets/images/hero-classroom.jpg");
  await expect(dialog.locator("[data-media-save]")).toBeEnabled({ timeout: 20_000 });
  await dialog.locator('[data-media-focal-grid] button[data-x="100"][data-y="0"]').click();
  // Simulate the production CDN returning the pre-upload image list once when
  // the live-revision refresh fires immediately after a successful mutation.
  mocked.setMediaStaleReads(1);
  await previewAndSaveMedia(dialog);
  await expect(dialog).not.toBeVisible({ timeout: 20_000 });
  expect(mocked.getMediaUploadCount()).toBe(1);
  await expect(hero).toHaveAttribute("data-site-media-custom", "true");
  await expect(hero.locator("img")).toHaveAttribute("src", "/assets/images/volunteers-1200.webp");
  await page.waitForTimeout(1_200);
  await expect(hero).toHaveAttribute("data-site-media-custom", "true");
  await expect(hero.locator("img")).toHaveAttribute("src", "/assets/images/volunteers-1200.webp");
  await expect(page.locator(".site-toast.is-error")).toHaveCount(0);

  await hero.hover();
  await hero.locator(".site-media-edit").click();
  page.once("dialog", (nativeDialog) => nativeDialog.accept());
  await page.locator("[data-media-restore]").click();
  await expect(dialog).not.toBeVisible();
  await expect(hero).not.toHaveAttribute("data-site-media-custom", "true");
  await expect(hero.locator("img")).toHaveAttribute("src", /hero-classroom\.jpg$/);
  await expect(page.locator(".site-toast.is-error")).toHaveCount(0);
  expect(mocked.requests.some((request) => request.startsWith("POST "))).toBe(true);
  expect(mocked.requests.some((request) => request.startsWith("DELETE "))).toBe(true);
});

test("Hero compression failure never sends an upload request", async ({ page }) => {
  const mocked = await mockApplication(page);
  await page.goto("/");
  const hero = page.locator('[data-site-media-slot="home.hero"]');
  await hero.hover();
  await hero.locator(".site-media-edit").click();
  await page.locator("[data-media-file]").setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.locator("[data-media-save]")).toBeDisabled();
  expect(mocked.getMediaUploadCount()).toBe(0);
  expect(mocked.requests.some((request) => request.startsWith("POST "))).toBe(false);
});

test("a timed-out upload response is reconciled when the server already committed the image", async ({ page }) => {
  const mocked = await mockApplication(page);
  mocked.setMediaCommitThenFailure(true);
  await page.goto("/");

  const hero = page.locator('[data-site-media-slot="home.hero"]');
  await hero.hover();
  await hero.locator(".site-media-edit").click();
  const dialog = page.locator(".site-media-dialog");
  await dialog.locator("[data-media-file]").setInputFiles("assets/images/hero-classroom.jpg");
  await expect(dialog.locator("[data-media-save]")).toBeEnabled({ timeout: 20_000 });
  await previewAndSaveMedia(dialog);

  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await expect(hero).toHaveAttribute("data-site-media-custom", "true");
  await expect(hero.locator("img")).toHaveAttribute("src", "/assets/images/volunteers-1200.webp");
  await expect(page.locator(".site-toast.is-error")).toHaveCount(0);
  expect(mocked.getMediaItem("home.hero")?.recordVersion).toBeGreaterThan(0);
});

test("sitewide media slots independently update service cards, localized alt text, focus, and fallback", async ({ page }) => {
  const mocked = await mockApplication(page);
  await page.goto("/programs");

  const tutoring = page.locator('[data-site-media-slot="services.tutoring"]');
  const outreach = page.locator('[data-site-media-slot="services.outreach"]');
  await expect(tutoring).toHaveCount(1);
  await expect(outreach).toHaveCount(1);

  await tutoring.scrollIntoViewIfNeeded();
  await tutoring.hover();
  const tutoringEdit = tutoring.locator(".site-media-edit");
  await expect(tutoringEdit).toBeVisible();
  await tutoringEdit.focus();
  await tutoringEdit.click();
  let openDialog = page.locator(".site-media-dialog[open]");
  await openDialog.locator("[data-media-file]").setInputFiles("assets/images/hero-classroom.jpg");
  await expect(openDialog.locator("[data-media-save]")).toBeEnabled({ timeout: 20_000 });
  await openDialog.locator('[data-media-focal-grid] button[data-x="0"][data-y="100"]').click();
  await previewAndSaveMedia(openDialog);
  await expect(openDialog).not.toBeVisible({ timeout: 20_000 });

  await expect(tutoring).toHaveAttribute("data-site-media-custom", "true");
  await expect(tutoring.locator("img")).toHaveCSS("object-position", "0% 100%");
  await expect(outreach).not.toHaveAttribute("data-site-media-custom", "true");
  await page.locator('#langSwitch button[data-lang="zhTW"]').click();
  await expect(tutoring.locator("img")).toHaveAttribute("alt", "學生接受一對一英語輔導");

  await outreach.scrollIntoViewIfNeeded();
  await outreach.hover();
  const outreachEdit = outreach.locator(".site-media-edit");
  await expect(outreachEdit).toBeVisible();
  await outreachEdit.focus();
  await outreachEdit.click();
  openDialog = page.locator(".site-media-dialog[open]");
  await openDialog.locator("[data-media-file]").setInputFiles("assets/images/hero-classroom.jpg");
  await expect(openDialog.locator("[data-media-save]")).toBeEnabled({ timeout: 20_000 });
  await openDialog.locator('[data-media-focal-grid] button[data-x="100"][data-y="0"]').click();
  await previewAndSaveMedia(openDialog);
  await expect(openDialog).not.toBeVisible({ timeout: 20_000 });

  await expect(tutoring).toHaveAttribute("data-site-media-custom", "true");
  await expect(outreach).toHaveAttribute("data-site-media-custom", "true");
  await expect(outreach.locator("img")).toHaveCSS("object-position", "100% 0%");
  await expect(outreach.locator("img")).toHaveAttribute("alt", "社區成員參與聽力健康講座");

  await tutoring.scrollIntoViewIfNeeded();
  await tutoring.hover();
  await tutoringEdit.focus();
  await tutoringEdit.click();
  page.once("dialog", (nativeDialog) => nativeDialog.accept());
  await page.locator(".site-media-dialog[open] [data-media-restore]").click();
  await expect(tutoring).not.toHaveAttribute("data-site-media-custom", "true");
  await expect(tutoring.locator("img")).toHaveAttribute("src", /tutoring-student\.jpg$/);
  await expect(outreach).toHaveAttribute("data-site-media-custom", "true");

  expect(mocked.getMediaUploadCount()).toBe(2);
  expect(mocked.requests.some((request) => request.includes("/api/site-media/services.tutoring"))).toBe(true);
  expect(mocked.requests.some((request) => request.includes("/api/site-media/services.outreach"))).toBe(true);
});

test("all repository content photos expose stable sitewide media slots", async ({ page }) => {
  test.setTimeout(60_000);
  await mockApplication(page);
  await page.goto("/");
  await expect(page.locator("[data-site-media-slot]")).toHaveCount(4);
  await expect(page.locator('[data-site-media-slot="global.volunteers"] .site-media-edit')).toHaveCount(1);

  await page.goto("/programs");
  await expect(page.locator("[data-site-media-slot]")).toHaveCount(2);

  await page.goto("/get-involved");
  const volunteers = page.locator('[data-site-media-slot="global.volunteers"]');
  await expect(volunteers).toHaveCount(1);
  const volunteersEdit = volunteers.locator(".site-media-edit");
  await expect(volunteersEdit).toHaveCount(1);
  await volunteers.scrollIntoViewIfNeeded();
  await volunteers.hover();
  await volunteersEdit.focus();
  await volunteersEdit.press("Enter");
  let openDialog = page.locator(".site-media-dialog[open]");
  await openDialog.locator("[data-media-file]").setInputFiles("assets/images/hero-classroom.jpg");
  await expect(openDialog.locator("[data-media-save]")).toBeEnabled({ timeout: 20_000 });
  await previewAndSaveMedia(openDialog);
  await expect(openDialog).not.toBeVisible({ timeout: 20_000 });
  await expect(volunteers).toHaveAttribute("data-site-media-custom", "true");
  await page.locator('#langSwitch button[data-lang="zhTW"]').click();
  await expect(volunteers.locator("img")).toHaveAttribute("alt", "年輕志工在戶外一同慶祝");

  await expect(volunteersEdit).toBeEnabled({ timeout: 20_000 });
  await volunteers.scrollIntoViewIfNeeded();
  await volunteers.hover();
  await volunteersEdit.focus();
  await volunteersEdit.press("Enter");
  openDialog = page.locator(".site-media-dialog[open]");
  page.once("dialog", (nativeDialog) => nativeDialog.accept());
  await openDialog.locator("[data-media-restore]").click();
  await expect(volunteers).not.toHaveAttribute("data-site-media-custom", "true");
  await expect(volunteers.locator("img")).toHaveAttribute("src", /volunteers\.jpg$/);
});

test("team avatars crop one person into a square WebP, recrop, and delete the photo", async ({ page }) => {
  const mocked = await mockApplication(page, { duplicateAvatar: true });
  await page.goto("/team");

  const zoeAvatars = page.locator('[data-site-media-slot="team.zoe-lu.avatar"]');
  await expect(zoeAvatars).toHaveCount(2);
  await expect(page.locator('[data-site-media-slot="team.daniel-hollis.avatar"]')).toHaveCount(1);
  await expect(page.locator('[data-site-media-slot="team.howard-ren.avatar"]')).toHaveCount(1);
  const tutorAvatar = page.locator('[data-site-media-slot="team.test.avatar"]');
  await expect(tutorAvatar).toHaveCount(1);
  const tutorDetails = page.locator('[data-profile-id="tutor-test"] details');
  await expect(tutorDetails).not.toHaveAttribute("open", "");
  await expect(tutorAvatar).toBeVisible();
  await tutorAvatar.hover();
  const tutorEdit = page.locator('[data-profile-id="tutor-test"] > .site-media-avatar-edit');
  await expect(tutorEdit).toBeVisible();
  await tutorEdit.click();
  await expect(tutorDetails).not.toHaveAttribute("open", "");
  await expect(page.locator('.site-media-dialog[open][data-media-kind="avatar"]')).toBeVisible();
  await page.locator('.site-media-dialog[open] [data-media-cancel]').last().click();

  const avatar = zoeAvatars.first();
  const initials = avatar.locator(".avatar-initials");
  await expect(initials).toBeVisible();
  await expect(avatar.locator("picture")).toBeHidden();

  await avatar.hover();
  const edit = avatar.getByRole("button", { name: "Change avatar" });
  await expect(edit).toBeVisible();
  await edit.focus();
  await edit.press("Enter");

  let dialog = page.locator('.site-media-dialog[open][data-media-kind="avatar"]');
  await expect(dialog.getByRole("heading", { name: "Change avatar" })).toBeVisible();
  await expect(dialog.locator(".site-media-alt-grid")).toBeHidden();
  await expect(dialog.locator(".site-media-translation-options")).toBeHidden();
  const quadrantPhoto = await sharp({
    create: { width: 800, height: 800, channels: 3, background: "#ef4444" },
  }).composite([
    { input: { create: { width: 400, height: 400, channels: 3, background: "#22c55e" } }, left: 400, top: 0 },
    { input: { create: { width: 400, height: 400, channels: 3, background: "#2563eb" } }, left: 0, top: 400 },
    { input: { create: { width: 400, height: 400, channels: 3, background: "#facc15" } }, left: 400, top: 400 },
  ]).png().toBuffer();
  await expect(dialog.locator("[data-media-drop]")).toContainText("Ctrl+V");
  await dialog.evaluate((node, bytes) => {
    const file = new File([new Uint8Array(bytes)], "four-people.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    node.dispatchEvent(event);
  }, Array.from(quadrantPhoto));
  const cropper = page.locator(".ihear-avatar-crop-dialog[open]");
  await expect(cropper.getByRole("heading", { name: "Crop one person" })).toBeVisible();
  await expect(cropper.locator("[data-avatar-crop-intake-hint]")).toContainText("paste or drop");
  await cropper.locator("[data-avatar-crop-stage]").evaluate((node, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "replacement.png", { type: "image/png" }));
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    node.dispatchEvent(event);
  }, Array.from(quadrantPhoto));
  await expect(cropper.locator("[data-avatar-crop-quality]")).toContainText("400 × 400");
  await expect(cropper.locator("[data-crop-handle]")).toHaveCount(4);
  await expect(cropper.locator("[data-avatar-crop-preview]")).toBeVisible();
  await expect(cropper.getByRole("group").getByRole("button", { name: "Keep original" })).toHaveAttribute("aria-pressed", "true");
  await expect(cropper.getByRole("group").getByRole("button", { name: "Replace with white" })).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.locator("[data-media-focal]")).toBeHidden();

  await page.evaluate(() => {
    window.iHearAvatarBackgroundRemoval.remove = async (source, options) => {
      options?.onProgress?.("processing");
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      const output = document.createElement("canvas");
      output.width = source.width;
      output.height = source.height;
      const context = output.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, output.width, output.height);
      context.fillStyle = "#28417f";
      context.fillRect(output.width * 0.25, output.height * 0.25, output.width * 0.5, output.height * 0.5);
      return output;
    };
  });
  const whiteBackground = cropper.getByRole("group").getByRole("button", { name: "Replace with white" });
  await whiteBackground.click();
  await expect(cropper).toHaveAttribute("data-busy", "");
  await expect(whiteBackground).toBeDisabled();
  await expect(cropper.locator("[data-avatar-crop-background-status]")).toContainText("Removing the background");
  await expect(whiteBackground).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 });
  await expect(cropper.locator("[data-avatar-crop-background-status]")).toContainText("White background is ready");
  const backgroundPreview = await cropper.locator("[data-avatar-crop-preview]").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    return {
      corner: [...context.getImageData(4, 4, 1, 1).data],
      center: [...context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data],
    };
  });
  expect(backgroundPreview.corner.slice(0, 3)).toEqual([255, 255, 255]);
  expect(backgroundPreview.center[2]).toBeGreaterThan(backgroundPreview.center[0]);

  const zoom = cropper.locator("[data-avatar-crop-zoom]");
  await zoom.evaluate((input) => {
    input.value = "400";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(cropper.getByRole("group").getByRole("button", { name: "Keep original" })).toHaveAttribute("aria-pressed", "true");
  await expect(cropper.locator("[data-avatar-crop-background-status]")).toContainText("crop changed");
  const selection = cropper.locator("[data-avatar-crop-selection]");
  await selection.focus();
  for (let index = 0; index < 10; index += 1) await selection.press("Shift+ArrowRight");
  for (let index = 0; index < 10; index += 1) await selection.press("Shift+ArrowDown");
  await expect(cropper.locator("[data-avatar-crop-warning]")).toBeVisible();
  await cropper.locator("[data-avatar-crop-confirm]").click();
  await expect(cropper).not.toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator("[data-media-save]")).toBeEnabled({ timeout: 20_000 });

  const cropResult = await dialog.locator("[data-media-preview]").evaluate(async (image) => {
    await image.decode();
    const blob = await fetch(image.src).then((response) => response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const center = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return { width: image.naturalWidth, height: image.naturalHeight, size: blob.size, center: [...center] };
  });
  expect(cropResult.width).toBe(800);
  expect(cropResult.height).toBe(800);
  expect(cropResult.size).toBeLessThanOrEqual(500 * 1024);
  expect(cropResult.center[0]).toBeGreaterThan(200);
  expect(cropResult.center[1]).toBeGreaterThan(150);
  expect(cropResult.center[2]).toBeLessThan(80);
  mocked.setMediaMutationDelay(1_500);
  await dialog.locator("[data-media-save]").click();
  await expect(dialog).not.toBeVisible({ timeout: 500 });
  await expect(avatar).toHaveAttribute("data-site-media-custom", "true", { timeout: 1_000 });
  await expect(avatar.locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 1_000 });
  await expect(avatar).toHaveAttribute("data-site-media-operation", "upload");
  await expect(avatar.locator(".site-media-edit")).toBeDisabled();
  await expect(avatar.locator(".site-media-edit")).toHaveAttribute("aria-label", "Uploading…");
  await expect(avatar.locator(".site-media-edit-spinner")).toBeVisible();
  await expect.poll(() => mocked.getMediaItem("team.zoe-lu.avatar"), { timeout: 5_000 }).not.toBeNull();
  mocked.setMediaMutationDelay(0);

  await expect(avatar).not.toHaveAttribute("data-site-media-operation");
  await expect(avatar.locator(".site-media-edit")).toBeEnabled();
  await expect(avatar).toHaveAttribute("data-site-media-custom", "true");
  await expect(page.locator('[data-site-media-slot="team.zoe-lu.avatar"][data-site-media-custom="true"]')).toHaveCount(2);
  await expect(initials).toBeHidden();
  await expect(avatar.locator("picture")).toBeVisible();
  await expect(avatar.locator("img")).toHaveCSS("object-position", "50% 50%");
  await expect.poll(() => avatar.locator("img").evaluate((image) => ({
    transform: image.style.transform,
    transformOrigin: image.style.transformOrigin,
  }))).toEqual({ transform: "none", transformOrigin: "50% 50%" });
  await expect(avatar.locator("img")).toHaveAttribute("alt", "");
  await page.locator('#langSwitch button[data-lang="zhTW"]').click();
  await expect(avatar.locator("img")).toHaveAttribute("alt", "");

  await avatar.hover();
  await avatar.getByRole("button", { name: "更換頭像" }).click();
  dialog = page.locator('.site-media-dialog[open][data-media-kind="avatar"]');
  await expect(dialog.locator("[data-media-restore]")).toHaveText("刪除照片");
  await dialog.locator("[data-media-recrop]").click();
  const recropper = page.locator(".ihear-avatar-crop-dialog[open]");
  await expect(recropper.getByRole("heading", { name: "裁切單一人物" })).toBeVisible();
  await recropper.locator("[data-avatar-crop-cancel]").last().click();
  await expect(recropper).not.toBeVisible();

  mocked.setMediaMutationDelay(1_500);
  mocked.setMediaMutationFailure(true);
  page.once("dialog", (nativeDialog) => nativeDialog.accept());
  await dialog.locator("[data-media-restore]").click();
  await expect(dialog).not.toBeVisible({ timeout: 500 });
  await expect(avatar).not.toHaveAttribute("data-site-media-custom", "true", { timeout: 500 });
  await expect(initials).toBeVisible();
  await expect(avatar).toHaveAttribute("data-site-media-operation", "delete");
  await expect(avatar.locator(".site-media-edit")).toHaveAttribute("aria-label", "正在刪除…");
  await expect(avatar.locator(".site-media-edit-spinner")).toBeVisible();
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await expect(dialog.locator("[data-media-status]")).toContainText(/restored|恢復|恢复/);
  await expect(avatar).toHaveAttribute("data-site-media-custom", "true");
  await expect(avatar.locator("picture")).toBeVisible();

  mocked.setMediaMutationFailure(false);
  mocked.setMediaStaleReads(1);
  page.once("dialog", (nativeDialog) => nativeDialog.accept());
  await dialog.locator("[data-media-restore]").click();
  await expect(dialog).not.toBeVisible({ timeout: 500 });
  await expect(avatar).not.toHaveAttribute("data-site-media-custom", "true", { timeout: 500 });
  await page.waitForTimeout(1_200);
  await expect(page.locator('[data-site-media-slot="team.zoe-lu.avatar"][data-site-media-custom="true"]')).toHaveCount(0);
  await expect(avatar.locator("picture")).toBeHidden();
  await expect(initials).toBeVisible();
  await expect.poll(() => mocked.getMediaItem("team.zoe-lu.avatar"), { timeout: 5_000 }).toBeNull();
  expect(mocked.requests.some((request) => request.includes("/api/site-media/team.zoe-lu.avatar"))).toBe(true);
});

test("avatar cropper stays usable without horizontal overflow at supported viewports", async ({ page }) => {
  const viewports = [
    { width: 1440, height: 900 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
    { width: 375, height: 812 },
    { width: 320, height: 700 },
    { width: 568, height: 320 },
  ];

  await mockApplication(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/team");
    const avatar = page.locator('[data-site-media-slot="team.zoe-lu.avatar"]').first();
    await avatar.hover();
    await avatar.getByRole("button", { name: "Change avatar" }).click();
    const mediaDialog = page.locator('.site-media-dialog[open][data-media-kind="avatar"]');
    await mediaDialog.locator("[data-media-file]").setInputFiles("assets/images/hero-classroom.jpg");
    const cropper = page.locator(".ihear-avatar-crop-dialog[open]");
    await expect(cropper).toBeVisible();
    const geometry = await cropper.evaluate((node) => {
      const rectangle = node.getBoundingClientRect();
      const stage = node.querySelector("[data-avatar-crop-stage]").getBoundingClientRect();
      const confirm = node.querySelector("[data-avatar-crop-confirm]").getBoundingClientRect();
      return {
        left: rectangle.left,
        right: rectangle.right,
        stageLeft: stage.left,
        stageRight: stage.right,
        confirmLeft: confirm.left,
        confirmRight: confirm.right,
        viewportWidth: document.documentElement.clientWidth,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(geometry.horizontalOverflow).toBe(false);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.stageLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.stageRight).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.confirmLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.confirmRight).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    await cropper.locator("[data-avatar-crop-cancel]").last().click();
    await mediaDialog.locator("[data-media-cancel]").last().click();
  }
});

test("team directory renders API data, switches language, and excludes generic pencils", async ({ page }) => {
  await mockApplication(page, { admin: false });
  await page.goto("/team");

  const details = page.locator("[data-team-tutors] .tutor-prof");
  const summary = details.locator("summary");
  const summaryAvatar = summary.locator(".team-avatar-slot");
  await expect(details).toHaveCount(1);
  await expect(details).not.toHaveAttribute("open", "");
  await expect(summaryAvatar).toHaveCount(1);
  await expect(summaryAvatar).toBeVisible();
  await expect(summaryAvatar.locator("img")).toHaveAttribute("alt", "");
  await expect(details.locator(".tp-body .team-avatar-slot")).toHaveCount(0);
  await expect(page.getByText("Test Tutor")).toBeVisible();
  await expect(page.getByText("English biography")).toBeHidden();
  await expect(summary).not.toContainText("Lead Tutor");
  const avatarBeforeOpen = await summaryAvatar.elementHandle();
  await page.getByText("Test Tutor").click();
  await expect(page.getByText("English biography")).toBeVisible();
  const avatarAfterOpen = await summaryAvatar.elementHandle();
  expect(await avatarBeforeOpen.evaluate((node, after) => node === after, avatarAfterOpen)).toBe(true);
  await expect(page.locator("[data-team-tutors] .ihear-inline-edit-button")).toHaveCount(0);
  await expect(page.locator("[data-team-toggle]")).toHaveCount(0);
  await expect(page.locator(".roster-heading-actions [data-team-sort-az]")).toBeHidden();
  await expect(page.locator("[data-team-add],[data-edit],[data-delete]")).toHaveCount(0);

  await page.locator('#langSwitch button[data-lang="zhTW"]').click();
  await expect(page.getByText("繁中完整介紹")).toBeVisible();
  await page.locator('#langSwitch button[data-lang="zhCN"]').click();
  await expect(page.getByText("简中完整介绍")).toBeVisible();
});

test("collapsed tutor summary keeps a long name, avatar, and chevron safe at supported viewports", async ({ page }) => {
  const longName = "AlexandriaSupercalifragilisticMentorshipCoordinator Montgomery-Worthington";
  const viewports = [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
    { width: 375, height: 812 },
    { width: 320, height: 800 },
    { width: 568, height: 320 },
  ];
  await mockApplication(page, { admin: false, tutorName: longName });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/team");

    const details = page.locator('[data-profile-id="tutor-test"] details');
    const summary = details.locator("summary");
    const avatar = summary.locator(".av-roster");
    await expect(details).not.toHaveAttribute("open", "");
    await expect(avatar).toBeVisible();
    await expect(page.getByText("English biography")).toBeHidden();

    const geometry = await summary.evaluate((node) => {
      const avatarNode = node.querySelector(".av-roster");
      const nameNode = node.querySelector(".tp-id");
      const chevronNode = node.querySelector(".chev");
      const summaryRect = node.getBoundingClientRect();
      const avatarRect = avatarNode.getBoundingClientRect();
      const nameRect = nameNode.getBoundingClientRect();
      const chevronRect = chevronNode.getBoundingClientRect();
      return {
        avatarWidth: avatarRect.width,
        avatarHeight: avatarRect.height,
        avatarShrink: getComputedStyle(avatarNode).flexShrink,
        nameMinWidth: getComputedStyle(nameNode).minWidth,
        nameWrap: getComputedStyle(nameNode.querySelector("b")).overflowWrap,
        nameRight: nameRect.right,
        chevronLeft: chevronRect.left,
        chevronRight: chevronRect.right,
        chevronShrink: getComputedStyle(chevronNode).flexShrink,
        summaryRight: summaryRect.right,
        viewportWidth: document.documentElement.clientWidth,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    const expectedAvatarSize = viewport.width <= 640 ? 64 : 72;
    expect(geometry.avatarWidth).toBeCloseTo(expectedAvatarSize, 0);
    expect(geometry.avatarHeight).toBeCloseTo(expectedAvatarSize, 0);
    expect(geometry.avatarShrink).toBe("0");
    expect(geometry.nameMinWidth).toBe("0px");
    expect(geometry.nameWrap).toBe("anywhere");
    expect(geometry.chevronShrink).toBe("0");
    expect(geometry.nameRight).toBeLessThanOrEqual(geometry.chevronLeft);
    expect(geometry.chevronRight).toBeLessThanOrEqual(geometry.summaryRight + 1);
    expect(geometry.summaryRight).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.horizontalOverflow).toBe(false);
  }
});

test("signed-in administrator saves the public tutor A-Z order across reloads", async ({ page }) => {
  await mockApplication(page);
  await page.unroute("**/api/team-profiles**");

  const makeProfile = (id, name, sortOrder) => ({
    id,
    personId: `person-${id}`,
    section: "tutor",
    status: "published",
    sortOrder,
    name,
    initials: name.split(" ").map((part) => part[0]).join(""),
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
    hobbies: { en: "", zhHant: "", zhHans: "" },
    publicationConsentAt: "2026-07-31T00:00:00.000Z",
    profileVersion: 1,
    personVersion: 1,
    updatedAt: "2026-07-31T00:00:00.000Z",
  });
  let tutors = [makeProfile("tutor-tristan", "Tristan Young", 10), makeProfile("tutor-amy", "Amy Chen", 20)];
  const reorderRequests = [];

  await page.route("**/api/team-profiles**", async (route) => {
    const request = route.request();
    if (request.method() === "PATCH" && request.url().includes("/reorder")) {
      const payload = request.postDataJSON();
      reorderRequests.push(payload);
      const byId = new Map(tutors.map((profile) => [profile.id, profile]));
      tutors = payload.ordered.map((entry, index) => ({
        ...byId.get(entry.id),
        sortOrder: (index + 1) * 10,
        profileVersion: byId.get(entry.id).profileVersion + 1,
      }));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, revision: { revision: "2" } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ leaders: [], tutors, people: [], admin: request.url().includes("includeDrafts=true") }),
    });
  });

  await page.goto("/team");
  const saveSort = page.getByRole("button", { name: "Save A–Z order" });
  await expect(saveSort).toBeVisible();
  await saveSort.click();
  const sortDialog = page.locator(".team-sort-dialog[open]");
  await expect(sortDialog).toBeVisible();
  await expect(sortDialog.locator(".team-sort-list li").nth(0)).toContainText("Amy Chen");
  await expect(sortDialog.locator(".team-sort-list li").nth(1)).toContainText("Tristan Young");
  await sortDialog.locator("[data-sort-confirm]").click();

  await expect.poll(() => reorderRequests.length).toBe(1);
  expect(reorderRequests[0].ordered.map((entry) => entry.id)).toEqual(["tutor-amy", "tutor-tristan"]);
  await expect(page.locator("[data-team-tutors] > [data-profile-id]").nth(0)).toHaveAttribute("data-profile-id", "tutor-amy");

  await page.reload();
  await expect(page.locator("[data-team-tutors] > [data-profile-id]").nth(0)).toHaveAttribute("data-profile-id", "tutor-amy");
  expect(reorderRequests).toHaveLength(1);
});

test("team manager is mobile-safe and exposes structured editing controls", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockApplication(page);
  await page.goto("/team");

  await page.getByRole("button", { name: "Manage profiles" }).click();
  const dragHandle = page.locator("[data-team-tutors] [data-team-drag='tutor']");
  await expect(dragHandle).toHaveCount(1);
  await expect(dragHandle).toBeVisible();
  const dragBounds = await dragHandle.boundingBox();
  expect(dragBounds).not.toBeNull();
  expect(dragBounds.width).toBeGreaterThanOrEqual(40);
  expect(dragBounds.x + dragBounds.width).toBeLessThanOrEqual(320);
  await page.getByRole("button", { name: "Add profile" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /publication consent/i })).toBeVisible();

  const modalBeforeScroll = await page.evaluate(() => {
    const dialog = document.querySelector(".team-profile-editor");
    const header = dialog.querySelector(".team-editor-head");
    const body = dialog.querySelector(".team-editor-body");
    const footer = dialog.querySelector(".team-editor-footer");
    const dialogRect = dialog.getBoundingClientRect();
    return {
      scrollable: body.scrollHeight > body.clientHeight,
      scrollTop: body.scrollTop,
      headerTop: header.getBoundingClientRect().top,
      footerBottom: footer.getBoundingClientRect().bottom,
      dialogTop: dialogRect.top,
      dialogBottom: dialogRect.bottom,
      viewportHeight: window.innerHeight,
      bodyOverflow: getComputedStyle(document.body).overflow,
    };
  });
  expect(modalBeforeScroll.scrollable).toBe(true);
  expect(modalBeforeScroll.bodyOverflow).toBe("hidden");
  expect(modalBeforeScroll.dialogTop).toBeGreaterThanOrEqual(0);
  expect(modalBeforeScroll.dialogBottom).toBeLessThanOrEqual(modalBeforeScroll.viewportHeight);

  const modalAfterScroll = await page.evaluate(() => {
    const dialog = document.querySelector(".team-profile-editor");
    const header = dialog.querySelector(".team-editor-head");
    const body = dialog.querySelector(".team-editor-body");
    const footer = dialog.querySelector(".team-editor-footer");
    body.scrollTop = body.scrollHeight;
    return {
      scrollTop: body.scrollTop,
      headerTop: header.getBoundingClientRect().top,
      footerBottom: footer.getBoundingClientRect().bottom,
    };
  });
  expect(modalAfterScroll.scrollTop).toBeGreaterThan(0);
  expect(modalAfterScroll.headerTop).toBeCloseTo(modalBeforeScroll.headerTop, 0);
  expect(modalAfterScroll.footerBottom).toBeCloseTo(modalBeforeScroll.footerBottom, 0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.body.classList.contains("team-profile-modal-open")))
    .toBe(false);
});

test("team manager confirms moving a profile to trash and removes it from the active roster", async ({ page }) => {
  await mockApplication(page);
  await page.unroute("**/api/team-profiles**");

  const profile = {
    id: "tutor-delete-test",
    personId: "person-delete-test",
    section: "tutor",
    status: "published",
    sortOrder: 10,
    name: "Delete Test Tutor",
    initials: "DT",
    school: "",
    grade: "",
    showSchool: false,
    showGrade: false,
    role: { en: "Tutor", zhHant: "導師", zhHans: "导师" },
    schoolDisplay: { en: "", zhHant: "", zhHans: "" },
    languages: { en: "English", zhHant: "英文", zhHans: "英文" },
    strengths: { en: "Support", zhHant: "支持", zhHans: "支持" },
    summary: { en: "Delete flow test", zhHant: "刪除流程測試", zhHans: "删除流程测试" },
    bio: { en: "Temporary deletion fixture", zhHant: "暫時刪除測試資料", zhHans: "临时删除测试资料" },
    hobbies: { en: "", zhHant: "", zhHans: "" },
    publicationConsentAt: "2026-07-31T00:00:00.000Z",
    profileVersion: 3,
    personVersion: 7,
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
  let tutors = [profile];
  let deletePayload = null;
  let nativeDialogCount = 0;
  page.on("dialog", async (dialog) => {
    nativeDialogCount += 1;
    await dialog.dismiss();
  });

  await page.route("**/api/team-profiles**", async (route) => {
    const request = route.request();
    if (request.method() === "DELETE") {
      deletePayload = request.postDataJSON();
      tutors = [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, deletedId: profile.id, revision: { revision: "2" } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        leaders: [],
        tutors,
        people: tutors.length ? [{ id: profile.personId, name: profile.name, initials: profile.initials, consentConfirmed: true }] : [],
        admin: request.url().includes("includeDrafts=true"),
      }),
    });
  });

  await page.goto("/team");
  await page.getByRole("button", { name: "Manage profiles" }).click();
  await page.locator(`[data-profile-id="${profile.id}"] summary`).click();
  await page.locator(`[data-edit="${profile.id}"]`).click();

  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(page.getByText("Move this profile to trash? You can restore it in the admin dashboard.")).toBeVisible();
  expect(nativeDialogCount).toBe(0);

  await page.locator("[data-delete-confirm]").click();
  await expect(page.locator(`[data-profile-id="${profile.id}"]`)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Team profile moved to trash.")).toBeVisible();
  expect(deletePayload).toEqual({ profileVersion: 3 });
  expect(nativeDialogCount).toBe(0);
});

test("team manager drag handles reorder profiles and persist once", async ({ page }) => {
  await mockApplication(page);
  await page.unroute("**/api/team-profiles**");

  const makeProfile = (id, name, sortOrder) => ({
    id,
    personId: `person-${id}`,
    section: "tutor",
    status: "published",
    sortOrder,
    name,
    initials: name.split(" ").map((part) => part[0]).join(""),
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
    publicationConsentAt: "2026-07-31T00:00:00.000Z",
    profileVersion: 1,
    personVersion: 1,
    updatedAt: "2026-07-31T00:00:00.000Z",
  });
  let tutors = [makeProfile("tutor-one", "First Tutor", 10), makeProfile("tutor-two", "Second Tutor", 20)];
  const reorderRequests = [];

  await page.route("**/api/team-profiles**", async (route) => {
    const request = route.request();
    if (request.method() === "PATCH" && request.url().includes("/reorder")) {
      const payload = request.postDataJSON();
      reorderRequests.push(payload);
      const byId = new Map(tutors.map((profile) => [profile.id, profile]));
      tutors = payload.ordered.map((entry, index) => ({
        ...byId.get(entry.id),
        sortOrder: (index + 1) * 10,
        profileVersion: byId.get(entry.id).profileVersion + 1,
      }));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, revision: { revision: "2" } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ leaders: [], tutors, people: [], admin: request.url().includes("includeDrafts=true") }),
    });
  });

  await page.goto("/team");
  await page.getByRole("button", { name: "Manage profiles" }).click();
  const handles = page.locator("[data-team-tutors] [data-team-drag='tutor']");
  await expect(handles).toHaveCount(2);
  await handles.nth(0).scrollIntoViewIfNeeded();
  const firstBox = await handles.nth(0).boundingBox();
  const secondCardBox = await page.locator("[data-team-tutors] [data-profile-id='tutor-two']").boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondCardBox).not.toBeNull();

  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    secondCardBox.x + secondCardBox.width / 2,
    secondCardBox.y + secondCardBox.height - 4,
    { steps: 8 },
  );
  await page.mouse.up();

  await expect.poll(() => reorderRequests.length).toBe(1);
  expect(reorderRequests[0].section).toBe("tutor");
  expect(reorderRequests[0].ordered.map((entry) => entry.id)).toEqual(["tutor-two", "tutor-one"]);
  const orderedCards = page.locator("[data-team-tutors] > [data-profile-id]");
  await expect(orderedCards.nth(0)).toHaveAttribute("data-profile-id", "tutor-two");
  await expect(orderedCards.nth(1)).toHaveAttribute("data-profile-id", "tutor-one");
  await expect(page.getByText("Team order saved.")).toBeVisible();
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
  await expect(page.locator("[data-latest-impact-label]")).toHaveText("Latest impact");
  await expect(page.locator("[data-latest-impact-period]")).toHaveText("January 2027");
  await expect(page.locator("[data-latest-impact-headline]")).toHaveText(
    "41+ volunteers · 63+ students · 1,299+ sessions",
  );
  await expect(page.locator("[data-latest-impact-description]")).toHaveText(
    "Current metrics fixture",
  );
  await expect(page.locator("[data-no-inline-edit] .ihear-inline-edit-button")).toHaveCount(0);

  await page.getByRole("button", { name: "繁" }).click();
  await expect(page.locator("[data-site-metric-asof]")).toHaveText("截至 2027 年 1 月");
  await expect(page.locator("[data-site-metric-country-names]")).toHaveText(
    "臺灣 · 中國 · 美國 · 加拿大 · 日本",
  );
  await expect(page.locator("[data-latest-impact-label]")).toHaveText("最新成果");
  await expect(page.locator("[data-latest-impact-period]")).toHaveText("2027 年 1 月");
  await expect(page.locator("[data-latest-impact-headline]")).toHaveText(
    "41+ 位志工 · 63+ 位學生 · 1,299+ 堂課",
  );
});

test("about marks only the latest published metrics as the latest impact", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/about");

  await expect(page.locator("[data-impact-id='impact-2027-01'] .impact-latest-badge")).toHaveText(
    "Latest impact",
  );
  await expect(page.locator("[data-impact-id='journey-2024-06'] .impact-latest-badge")).toHaveCount(0);
  await expect(page.locator("[data-impact-id='impact-2026-12'] .impact-latest-badge")).toHaveCount(0);
  await expect(page.locator("[data-impact-id='journey-2028-01'] .impact-latest-badge")).toHaveCount(0);

  await page.getByRole("button", { name: "繁" }).click();
  await expect(page.locator("[data-impact-id='impact-2027-01'] .impact-latest-badge")).toHaveText(
    "最新成果",
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
    await expect(page.locator("[data-latest-impact-headline]")).toHaveText(
      "35+ volunteers · 50+ students · 1,200+ sessions",
    );

    await page.getByRole("button", { name: "繁" }).click();
    await expect(page.locator("[data-latest-impact-label]")).toHaveText("最新成果");
    await expect(page.locator("[data-latest-impact-period]")).toHaveText("2026 年 6 月");
    await expect(page.locator("[data-latest-impact-headline]")).toHaveText(
      "35+ 位志工 · 50+ 位學生 · 1,200+ 堂課",
    );
    await expect(page.locator("[data-latest-impact-description]")).toContainText(
      "35+ 位活躍志工",
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

  await page.route("**/api/content/get**", async (route) => {
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 3,
        updatedAt: "2026-07-31T00:00:00.000Z",
        locales: {
          en: { pages: { "/about": { "about.mission.heading": "Production override loaded" } }, itemUpdatedAt: {} },
          zhHant: { pages: {}, itemUpdatedAt: {} },
          zhHans: { pages: {}, itemUpdatedAt: {} },
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
      body: JSON.stringify({ url: `${e2eOrigin}/about?oauth=started` }),
    });
  });

  await page.goto("/about");
  const signInButton = page.locator("[data-auth-desktop] [data-auth-signin]");
  await expect(signInButton).toBeVisible();
  await expect(signInButton).toContainText("Sign in");
  await expect(signInButton).not.toContainText("Admin sign in");
  const historyLength = await page.evaluate(() => window.history.length);
  await signInButton.click();
  await expect(page).toHaveURL(`${e2eOrigin}/about?oauth=started`);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  expect(authRequests).toEqual(["clear-stale", "csrf", "signin"]);
});

test("English-first impact editor previews Chinese and publishes all languages atomically", async ({ page }) => {
  const mocked = await mockApplication(page);
  await page.goto("/about");
  await page.getByRole("button", { name: "繁" }).click();

  await page.getByRole("button", { name: "新增歷程" }).click();
  await page.getByRole("textbox", { name: "標題 — English" }).fill("English-first translation test");
  await page.getByRole("textbox", { name: "說明文案 — English" }).fill("English text entered by an administrator.");
  await page.getByRole("button", { name: "發布" }).click();
  await expect(page.getByRole("textbox", { name: "標題 — 繁體中文" })).toHaveValue("繁中 English-first translation test");
  await expect(page.getByRole("textbox", { name: "說明文案 — 繁體中文" })).toHaveValue("繁中 English text entered by an administrator.");
  await page.getByRole("textbox", { name: "標題 — 繁體中文" }).fill("人工修正的翻譯測試");
  await page.getByRole("button", { name: "發布" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(mocked.getPublishedPayload()?.status).toBe("published");
  expect(mocked.getPublishedPayload()?.translationReceipt).toBe("e2e-signed-receipt");
  expect(mocked.getPublishedPayload()?.title.zhHant).toBe("人工修正的翻譯測試");
  expect(mocked.requests.some((request) => request.includes("/translate"))).toBe(false);
});

test("mobile editor has no horizontal overflow at supported narrow widths", async ({ page }) => {
  await mockApplication(page);
  for (const width of [390, 375, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/about");
    await page.locator("#navToggle").click();
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
    version: 3,
    updatedAt: "2026-07-31T00:00:00.000Z",
    locales: {
      en: {
        pages: { "/about": { "about.mission.heading": "Temporary override" } },
        itemUpdatedAt: { "/about": { "about.mission.heading": "2026-07-31T00:00:00.000Z" } },
      },
      zhHant: { pages: {}, itemUpdatedAt: {} },
      zhHans: { pages: {}, itemUpdatedAt: {} },
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
  await expect(page.locator("[data-latest-impact-description]")).toHaveText("Current metrics fixture");
  metrics = null;
  await page.evaluate(() => window.iHearLiveContent.announce("impact", { revision: "2" }));
  await expect(page.locator('[data-site-metric-value="sessions"]').first()).toHaveText("1,200+");
  await expect(page.locator("[data-latest-impact-description]")).toContainText(
    "Bringing together 35+ active volunteers",
  );

  await page.goto("/about");
  await expect(page.getByRole("heading", { name: /Temporary override/ })).toBeVisible();
  content = {
    version: 3,
    updatedAt: "",
    locales: {
      en: { pages: {}, itemUpdatedAt: {} },
      zhHant: { pages: {}, itemUpdatedAt: {} },
      zhHans: { pages: {}, itemUpdatedAt: {} },
    },
  };
  await page.evaluate(() => window.iHearLiveContent.announce("content", { revision: "2" }));
  await expect(page.getByRole("heading", { name: /Why iHear exists/ })).toBeVisible();
});

test("all source pages keep one h1 and avoid viewport overflow", async ({ page }) => {
  test.setTimeout(120_000);
  await mockApplication(page, { admin: false });
  const routes = [
    "/", "/about", "/programs", "/impact", "/team", "/submit-bio", "/stories",
    "/get-involved", "/academy", "/donate", "/resources", "/faq", "/contact",
  ];
  const viewports = [
    { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 900 },
    { width: 390, height: 844 }, { width: 320, height: 800 }, { width: 568, height: 320 },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route);
      const result = await page.evaluate(() => {
        const ids = Array.from(document.querySelectorAll("[id]"), (node) => node.id);
        return {
          h1: document.querySelectorAll("h1").length,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
          mainVisible: Boolean(document.querySelector("main")?.getBoundingClientRect().height),
          offenders: Array.from(document.querySelectorAll("body *")).filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.right > document.documentElement.clientWidth + 1;
          }).slice(0, 8).map((element) => ({ tag: element.tagName, className: element.className, right: Math.round(element.getBoundingClientRect().right), left: Math.round(element.getBoundingClientRect().left) })),
        };
      });
      expect(result, `${route} at ${viewport.width}x${viewport.height}`).toEqual({
        h1: 1, overflow: false, duplicateIds: [], mainVisible: true, offenders: [],
      });
      if (["/about", "/programs", "/impact", "/team", "/submit-bio", "/get-involved", "/resources", "/donate"].includes(route)) {
        await expect(page.locator('.nav-links [aria-current="page"]')).toHaveCount(1);
      }
    }
  }
});

test("skip link moves keyboard focus into the main content", async ({ page }) => {
  await mockApplication(page, { admin: false });
  await page.goto("/");

  const skipLink = page.getByRole("link", { name: "Skip to content" });
  const main = page.locator("#main");
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/#main$/);
  await expect(main).toHaveAttribute("tabindex", "-1");
  await expect(main).toBeFocused();
});

test("mobile drawer is safe with native inert and the tabindex fallback", async ({ context, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApplication(page, { admin: false });
  await page.goto("/about");
  const drawer = page.locator("#navLinks");
  const toggle = page.locator("#navToggle");
  await expect(drawer).toBeHidden();
  await expect(drawer).toHaveAttribute("aria-hidden", "true");
  expect(await toggle.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(48);

  await toggle.click();
  await expect(drawer).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();

  await page.goto("/");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.locator("#navToggle").click();
  await page.getByRole("link", { name: "iHear Initiative — home" }).click();
  await expect(page.locator("#navLinks")).toBeHidden();
  await expect(page.locator("#navToggle")).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  const legacyPage = await context.newPage();
  await legacyPage.addInitScript(() => { delete HTMLElement.prototype.inert; });
  await legacyPage.setViewportSize({ width: 568, height: 320 });
  await mockApplication(legacyPage, { admin: false });
  await legacyPage.goto("/about");
  const legacyDrawer = legacyPage.locator("#navLinks");
  await legacyPage.locator("#navToggle").click();
  await expect(legacyDrawer).toBeVisible();
  expect(await legacyDrawer.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  await legacyPage.locator("#navToggle").click();
  await expect(legacyDrawer).toHaveAttribute("aria-hidden", "true");
  expect(await legacyDrawer.locator("a").first().getAttribute("tabindex")).toBe("-1");
  await expect(legacyDrawer).toBeHidden();
  await legacyPage.close();
});

test("no-JavaScript fallback keeps content and mobile navigation visible", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/faq");
  await expect(page.locator("#navLinks")).toBeVisible();
  await expect(page.locator("[data-animate]").first()).toBeVisible();
  expect(await page.locator("[data-animate]").first().evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await context.close();
});

test("FAQ filtering and bio-form safeguards provide recoverable feedback", async ({ page }) => {
  await mockApplication(page, { admin: false });
  await page.goto("/faq");
  const search = page.getByRole("searchbox", { name: "Search frequently asked questions" });
  await search.fill("Zoom");
  await expect(page.locator(".faq-list details:visible")).not.toHaveCount(20);
  await expect(page.locator(".faq-search-status")).toContainText("found");
  await search.fill("no-match-phrase-xyz");
  await expect(page.locator(".faq-empty")).toBeVisible();

  await page.goto("/submit-bio");
  await page.getByLabel("Full name *").fill("   ");
  await page.getByLabel(/Short bio/).fill("   ");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Email My Bio" }).click();
  await expect(page.getByLabel("Full name *")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Full name *")).toBeFocused();
  await page.getByLabel("Full name *").fill("Test Tutor");
  await page.getByLabel(/Short bio/).fill("Patient and supportive tutor.");
  await page.getByRole("button", { name: "Copy full draft" }).click();
  await expect(page.getByText(/complete email draft was copied|Could not copy automatically/)).toBeVisible();
  await expect(page.getByLabel("Full name *")).toHaveValue("Test Tutor");
});

test("team editor protects dirty work and provides keyboard tabs", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/team");
  await page.getByRole("button", { name: "Manage profiles" }).click();
  await page.getByRole("button", { name: "Add profile" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Unsaved Tutor");
  const dialog = page.getByRole("dialog");
  page.once("dialog", async (confirmation) => confirmation.dismiss());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeVisible();
  const activeTab = page.getByRole("tab", { selected: true });
  await activeTab.press("ArrowRight");
  await expect(page.getByRole("tab", { selected: true })).toBeFocused();
  page.once("dialog", async (confirmation) => confirmation.accept());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});
