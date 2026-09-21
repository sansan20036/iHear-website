// Built application and real API, isolated files and test-only authentication.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { encode } from "next-auth/jwt";

const origin = "http://localhost:3214", secret = "isolated-team-visibility-test-secret";
await mkdir("output/playwright", { recursive: true });
const directory = await mkdtemp(path.resolve("output/playwright/team-visibility-"));
const person = { id: "person-visibility", name: "Visibility Tutor", initials: "VT", version: 1, publicationConsentAt: "2026-09-01T00:00:00Z", publicationConsentBy: "test@example.com" };
const localized = { en: "Test biography", zhHant: "保留人工介紹", zhHans: "保留人工介绍" };
const profile = { id: "tutor-visibility", personId: person.id, section: "tutor", status: "published", sortOrder: 10, version: 1, school: "School", grade: "10", showSchool: true, showGrade: true, role: localized, schoolDisplay: localized, languages: localized, strengths: localized, summary: localized, bio: localized, hobbies: localized };
const initial = { people: [person], profiles: [profile, { ...profile, id: "leader-visibility", section: "leader" }, { ...profile, id: "tutor-draft", status: "draft", sortOrder: 20 }] };
await writeFile(path.join(directory, "team-profiles.json"), JSON.stringify(initial));
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "localhost", "--port", "3214"], {
  env: { ...process.env, NODE_ENV: "production", VERCEL: "", NETLIFY: "", CONTEXT: "", IHEAR_FORCE_FILE_STORE: "1", IHEAR_TEST_DATA_DIR: directory, AUTH_SECRET: secret, AUTH_OWNER_EMAILS: "visibility@example.com", AUTH_URL: origin, AUTH_TRUST_HOST: "true" },
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "", browser, page;
child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
try {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(origin + "/api/team-profiles")).ok) break; } catch { /* starting */ }
    await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const token = await encode({ secret, salt: "authjs.session-token", token: { name: "Visibility test", email: "visibility@example.com", sub: "visibility-test" } });
  await context.addCookies([{ name: "authjs.session-token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  page = await context.newPage();
  let translationRequests = 0;
  page.on("request", request => { if (request.url().includes("/translations/preview")) translationRequests++; });
  const publicData = async () => (await (await fetch(origin + "/api/team-profiles")).json());
  const adminData = async () => (await (await context.request.get(origin + "/api/team-profiles?includeDrafts=true")).json());
  const row = page.locator('[data-profile-id="tutor-visibility"]');
  await page.goto(origin + "/admin/team");
  await expect(row).toBeVisible();
  const status = page.locator(".admin-toolbar select").nth(1);
  await status.selectOption("published");
  await row.getByRole("button", { name: "隱藏", exact: true }).click();
  await expect(row).toHaveAttribute("data-team-hidden", "true");
  await expect(row).toContainText("已隱藏，訪客已看不到");
  expect((await publicData()).tutors).toHaveLength(0);
  expect((await publicData()).leaders).toHaveLength(1);
  // External refresh must retain the local success feedback.
  await page.evaluate(() => window.iHearLiveContent?.announce("team", { revision: "100" }));
  await expect(row.getByRole("button", { name: "重新顯示" })).toBeVisible();
  await expect(row.getByTitle("上移")).toBeDisabled();
  await page.screenshot({ path: path.join(directory, "admin-hidden-390.png"), fullPage: true });
  await status.selectOption("all"); await status.selectOption("published");
  await expect(row).toHaveCount(0);
  await status.selectOption("hidden"); await expect(row).toBeVisible();
  await row.getByRole("button", { name: "重新顯示" }).click();
  await expect(row).toHaveAttribute("data-team-hidden", "false");
  expect((await publicData()).tutors).toHaveLength(1);
  await page.reload(); await status.selectOption("hidden"); await expect(row).toHaveCount(0);
  await status.selectOption("all");
  // Editor checkbox: cancel is local; save visibility bypasses translations.
  await row.getByRole("button", { name: "編輯", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("暫時隱藏此卡片").check();
  await dialog.getByRole("button", { name: "儲存變更", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(row).toHaveAttribute("data-team-hidden", "true");
  expect(translationRequests).toBe(0);
  const persisted = JSON.parse(await readFile(path.join(directory, "team-profiles.json"), "utf8"));
  expect(persisted.people).toEqual(initial.people);
  expect(persisted.profiles[0].bio).toEqual(localized);
  expect(persisted.profiles[0].sortOrder).toBe(10);
  expect(persisted.profiles.slice(1)).toEqual(initial.profiles.slice(1));
  // Locales and narrow screens: no overflow, target sizes and keyboard activation.
  for (const locale of ["en", "zhHant", "zhHans"]) {
    await page.setViewportSize({width:1440,height:900});
    await page.getByRole("button",{name:locale==="en"?"EN":locale==="zhHant"?"繁":"简",exact:true}).click();
    await expect(row.getByRole("button",{name:locale==="en"?"Show again":locale==="zhHant"?"重新顯示":"重新显示",exact:true})).toBeVisible();
    await expect(row).toBeVisible();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await row.locator(".admin-card-actions button").first().evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
  }
  await page.goto(origin + "/admin/team");
  await row.getByRole("button", { name: "重新顯示" }).focus(); await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-team-hidden", "false");
  // Simulated conflict must not change the card or claim success.
  await page.route("**/tutor-visibility/visibility", route => route.fulfill({ status: 409, json: { error: "changed" } }), { times: 1 });
  await row.getByRole("button", { name: "隱藏", exact: true }).click();
  await expect(page.locator(".admin-page [role=alert]")).toContainText("其他管理員");
  await expect(row).toHaveAttribute("data-team-hidden", "false");
  // Public-page inline management, and an anonymous visitor in a separate context.
  const visitor = await browser.newContext(); const visitorPage = await visitor.newPage();
  await visitorPage.goto(origin + "/team");
  await expect(visitorPage.locator('[data-profile-id="tutor-visibility"]')).toBeVisible();
  await expect(visitorPage.locator("[data-team-toggle]")).toHaveCount(0);
  await page.goto(origin + "/team");
  await page.locator("[data-team-toggle]").click();
  await row.locator("[data-visibility]").click();
  await expect(row).toHaveAttribute("data-hidden", "true");
  await page.locator("[data-team-toggle]").click(); await expect(row).toHaveCount(0);
  await visitorPage.reload(); await expect(visitorPage.locator('[data-profile-id="tutor-visibility"]')).toHaveCount(0);
  // A delayed administrator response cannot restore hidden content after exiting.
  let release, captured;
  const hold = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { captured = resolve; });
  await page.route("**/api/team-profiles?includeDrafts=true", async route => { const response = await route.fetch(); captured(); await hold; await route.fulfill({ response }); }, { times: 1 });
  await page.locator("[data-team-toggle]").click(); await arrived;
  const releasedResponse=page.waitForResponse(response => response.url().includes("includeDrafts=true"));
  await page.locator("[data-team-toggle]").click(); release(); await releasedResponse;
  await expect(row).toHaveCount(0); await expect(page.locator('[data-profile-id="tutor-draft"]')).toHaveCount(0);
  await page.locator("[data-team-toggle]").click(); await expect(row).toBeVisible();
  await row.locator("[data-edit]").click();
  await page.locator('[name="isHidden"]').uncheck();
  // Cancel leaves the saved visibility unchanged, then reopen and save.
  page.once("dialog", confirmation => confirmation.accept());
  await page.locator("[data-cancel]").click();
  expect((await publicData()).tutors).toHaveLength(0);
  await row.locator("[data-edit]").click(); await page.locator('[name="isHidden"]').uncheck();
  await page.getByRole("button", { name: /儲存變更|Save changes/ }).click();
  await expect(page.locator(".team-profile-dialog[open]")).toHaveCount(0);
  await expect(row).toHaveAttribute("data-hidden", "false");
  expect(translationRequests).toBe(0);
  // Unchecking visibility never publishes a draft.
  const draft = (await adminData()).tutors.find(item => item.id === "tutor-draft");
  const result = await context.request.patch(origin + "/api/team-profiles/tutor-draft/visibility", { data: { isHidden: false, profileVersion: draft.profileVersion }, headers: { Origin: origin } });
  expect(result.status()).toBe(200); expect((await publicData()).tutors.map(p => p.id)).toEqual([profile.id]);
  // Logout removes management-only DOM immediately even with an old request in flight.
  await row.locator("[data-visibility]").click(); await expect(row).toHaveAttribute("data-hidden","true");
  await page.route("**/api/team-profiles",route=>route.fulfill({status:503,json:{error:"unavailable"}}),{times:1});
  await page.evaluate(()=>{
    const originalFetch=window.fetch;
    window.fetch=async(...args)=>{
      const response=await originalFetch(...args);
      if(String(args[0]).includes("live=logout-test")){
        window.testTeamWaiting=true;
        await new Promise(resolve=>{window.testTeamRelease=resolve});
      }
      return response;
    };
    window.testTeamRefresh=window.iHearTeamProfiles.refresh({revision:"logout-test"});
  });
  await expect.poll(()=>page.evaluate(()=>Boolean(window.testTeamWaiting))).toBe(true);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent("ihear:auth",{detail:{session:null}})));
  await expect(row).toHaveCount(0);await expect(page.locator('[data-profile-id="tutor-draft"]')).toHaveCount(0);
  await page.evaluate(async()=>{window.testTeamRelease();await window.testTeamRefresh});
  await expect(page.locator("[data-team-retry]").first()).toBeVisible();
  await expect(page.locator("[data-team-toggle]")).toBeHidden();
  await page.locator("[data-team-retry]").first().click();
  await expect(page.locator('[data-profile-id="leader-visibility"]')).toBeVisible();await expect(row).toHaveCount(0);
  await visitor.close();
  console.log("Team visibility smoke passed: real API, inline/admin editors, retained feedback, independent placements, preservation, conflict, stale response, visitor filtering, three locales and 320/390/1440px.");
} catch (error) {
  if (page) { console.error((await page.locator("body").innerText()).slice(-8000)); await page.screenshot({ path: path.join(directory, "failure.png"), fullPage: true }); }
  console.error(logs.slice(-2000)); throw error;
} finally { await browser?.close(); child.kill(); }
