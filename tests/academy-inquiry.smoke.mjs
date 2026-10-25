// Built application, browser and real API route; no email can leave this machine.
// Part 1 runs with every Resend setting blank: browser outcomes are simulated per
// request, and the real route must refuse delivery. Part 2 loads
// tests/helpers/fake-resend.mjs into the server, which answers Resend API calls
// in-process, so the complete path from both pages to the email is exercised.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const shots = path.resolve("output/playwright/academy-inquiry");
await mkdir(shots, { recursive: true });

const pages = {
  en: {
    path: "/academy/courses",
    privacy: ["Purpose:", "Who receives it:", "How long we keep it:", "Questions, corrections or deletion:", "ihearprogram@gmail.com", "Resend", "under 18"],
    text: {
      invalid: "Please check the highlighted fields and try again.",
      invalidServer: "Please check your email address and answers, then try again.",
      success: "Thank you! Your inquiry has been sent.",
      unavailable: "Online inquiries are temporarily unavailable.",
      rateLimited: "Too many attempts.",
      failed: "Your inquiry was not sent.",
      inProgress: "Your inquiry is still being processed.",
      unconfirmed: "the team may then receive it twice",
    },
  },
  "zh-Hant": {
    path: "/academy/courses/zh",
    privacy: ["用途：", "接收對象：", "保存原則：", "查詢、更正或刪除：", "ihearprogram@gmail.com", "Resend", "未滿 18 歲"],
    text: {
      invalid: "請確認標示的欄位後再送出。",
      invalidServer: "請確認電子信箱與填寫內容是否正確",
      success: "謝謝您！詢問已送出",
      unavailable: "線上詢問暫時無法使用",
      rateLimited: "送出次數較多",
      failed: "這次詢問沒有送出",
      inProgress: "詢問仍在處理中",
      unconfirmed: "團隊可能會收到重複的詢問",
    },
  },
};
const fieldNames = ["availability", "contactMethod", "email", "firstName", "gradeLevel", "lastName", "locale", "location", "message", "phone", "requestId", "sessionFormat", "startTime", "subject", "website"];

// `next start` reports route request URLs as localhost, so the same-origin check
// only recognizes pages opened on localhost (127.0.0.1 counts as a foreign origin).
async function startServer(port, env = {}) {
  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "localhost", "--port", String(port)], {
    env: {
      ...process.env, NODE_ENV: "production", VERCEL: "", NETLIFY: "", CONTEXT: "", IHEAR_FORCE_FILE_STORE: "1", NEXT_TELEMETRY_DISABLED: "1",
      RATE_LIMIT_SECRET: "academy-inquiry-smoke-only", RESEND_API_KEY: "", ACADEMY_INQUIRY_FROM: "", ACADEMY_INQUIRY_TO: "", ...env,
    },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { if ((await fetch(`${base}/academy/courses`)).ok) return { base, stop: () => child.kill() }; } catch { /* starting */ }
    await new Promise(resolve => { setTimeout(resolve, 500); });
  }
  child.kill();
  throw new Error(`Built server did not start: ${logs}`);
}

// Nothing outside the given local server may load: no Google Form, no Resend.
async function isolatedContext(browser, base, external) {
  const context = await browser.newContext();
  await context.route(url => url.origin !== base, route => { external.push(route.request().url()); return route.abort(); });
  return context;
}

async function fillValid(form, lang) {
  await form.locator('[name="firstName"]').fill(lang === "en" ? "Jordan" : "小明");
  await form.locator('[name="lastName"]').fill(lang === "en" ? "Chen" : "林");
  await form.locator('[name="email"]').fill("parent@example.com");
  await form.locator('[name="location"]').fill("Taipei (UTC+8)");
  await form.locator('[name="gradeLevel"]').selectOption("elementary");
  await form.locator('[name="subject"]').selectOption("english-communication");
  await form.locator('[name="sessionFormat"]').selectOption("online-one-on-one");
  await form.locator('[name="startTime"]').selectOption("asap");
  await form.locator('[name="contactMethod"]').selectOption("email");
  await form.locator('[name="availability"]').fill("Saturday mornings");
  await form.locator('[name="message"]').fill("Synthetic browser check only.");
}

// Each simulated response is used once, in order; request bodies are recorded.
async function simulate(page, outcomes, bodies) {
  await page.route("**/api/academy-inquiry", async route => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.headers()["content-type"]).toBe("application/json");
    bodies.push(request.postDataJSON());
    const next = outcomes.shift();
    if (!next) throw new Error("Unexpected inquiry request");
    if (next.delay) await new Promise(resolve => { setTimeout(resolve, next.delay); });
    if (next === "abort") return route.abort("failed");
    if (next.html) return route.fulfill({ status: next.status, contentType: "text/html", body: "<!doctype html><title>Gateway</title>" });
    return route.fulfill({ status: next.status, json: next.json });
  });
}

async function open(context, base, lang, width) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${base}${pages[lang].path}?entry=official`);
  const form = page.locator("form[data-inquiry-form]");
  // Playwright's toBeEnabled ignores <fieldset disabled>; read the DOM property.
  await expect(form.locator("fieldset")).toHaveJSProperty("disabled", false);
  await expect(form.locator('button[type="submit"]')).toBeEnabled();
  return { page, form, status: form.locator("[data-inquiry-status]") };
}

// Clip #start from a full-page capture taken at the top of the page, where the
// sticky header cannot cover the section.
async function shoot(page, name) {
  const clip = await page.locator("#start").evaluate(node => {
    const rect = node.getBoundingClientRect();
    const box = { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    return box;
  });
  await page.screenshot({ path: path.join(shots, name), fullPage: true, clip });
}

async function submitAndExpect(form, status, message, bodies) {
  const count = bodies.length;
  await form.locator('button[type="submit"]').click();
  // Wait for this request's own answer: consecutive outcomes may share a message.
  await expect.poll(() => bodies.length).toBe(count + 1);
  await expect(status).not.toHaveAttribute("data-state", "pending");
  await expect(status).toContainText(message);
  await expect(form.locator("fieldset")).toHaveJSProperty("disabled", false);
  // Users are never promised that a resend cannot reach the team twice.
  await expect(status).not.toHaveText(/不會重複|no duplicate|won.t (?:be )?(?:sent|receive)/i);
}

const step = async (name, run) => { await run(); console.log(`ok - ${name}`); };
let browser, server;
try {
  browser = await chromium.launch({ headless: true });

  // Part 1: every Resend setting blank.
  server = await startServer(3216);
  const origin = server.base;
  const external = [];
  const context = await isolatedContext(browser, origin, external);

  for (const lang of ["en", "zh-Hant"]) {
    await step(`${lang}: layout, privacy notice and spam trap at 320–1440px`, async () => {
      for (const width of [320, 390, 768, 1440]) {
        const { page, form } = await open(context, origin, lang, width);
        await form.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${lang} ${width}px overflow`).toBeLessThanOrEqual(1);
        const box = await form.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        const privacy = form.locator("#inquiry-privacy");
        await expect(privacy).toBeVisible();
        for (const item of pages[lang].privacy) await expect(privacy).toContainText(item);
        const honeypot = form.locator('[name="website"]');
        await expect(honeypot).toHaveAttribute("tabindex", "-1");
        expect((await honeypot.boundingBox()).x).toBeLessThan(0);
        if (width <= 390) {
          for (const name of ["firstName", "email", "subject", "message"]) {
            expect(await form.locator(`[name="${name}"]`).evaluate(node => parseFloat(getComputedStyle(node).fontSize)), `${name} avoids iOS zoom`).toBeGreaterThanOrEqual(16);
          }
        }
        if (width === 390 || width === 1440) await shoot(page, `${lang}-${width}-form.png`);
        await page.close();
      }
    });

    await step(`${lang}: missing answers are flagged before any request`, async () => {
      const bodies = [];
      const { page, form, status } = await open(context, origin, lang, 390);
      await simulate(page, [], bodies);
      await form.locator('button[type="submit"]').click();
      await expect(status).toHaveText(pages[lang].text.invalid);
      await expect(form.locator('[name="firstName"]')).toBeFocused();
      for (const name of ["firstName", "email", "subject"]) await expect(form.locator(`[name="${name}"]`)).toHaveAttribute("aria-invalid", "true");
      await shoot(page, `${lang}-390-errors.png`);
      // Phone contact makes the phone number required.
      await fillValid(form, lang);
      await form.locator('[name="contactMethod"]').selectOption("phone");
      await expect(form.locator("[data-phone-required]")).toBeVisible();
      await expect(form.locator("[data-phone-hint]")).toBeVisible();
      await form.locator('button[type="submit"]').click();
      await expect(form.locator('[name="phone"]')).toHaveAttribute("aria-invalid", "true");
      await form.locator('[name="contactMethod"]').selectOption("email");
      await expect(form.locator("[data-phone-required]")).toBeHidden();
      await form.locator('[name="email"]').fill("not-an-email");
      await form.locator('button[type="submit"]').click();
      await expect(form.locator('[name="email"]')).toHaveAttribute("aria-invalid", "true");
      expect(bodies).toHaveLength(0);
      await page.close();
    });
  }

  await step("en: every server outcome shows its own message and keeps the reference only when the email may have been sent", async () => {
    const bodies = [];
    const { text } = pages.en;
    const { page, form, status } = await open(context, origin, "en", 1440);
    await simulate(page, [
      { status: 502, json: { code: "DELIVERY_UNCONFIRMED" } },
      { status: 409, json: { code: "DELIVERY_IN_PROGRESS" } },
      { status: 502, json: { code: "DELIVERY_FAILED" } },
      { status: 503, json: { code: "EMAIL_UNAVAILABLE" } },
      { status: 429, json: { code: "RATE_LIMITED", retryAfter: 60 } },
      { status: 400, json: { code: "INVALID_INPUT" } },
      "abort",
      { status: 504, html: true },
      { status: 404, html: true },
      { status: 200, json: { ok: true }, delay: 600 },
    ], bodies);
    await fillValid(form, "en");
    const expected = [
      [text.unconfirmed, "new"],
      [text.inProgress, "same"],
      [text.failed, "same"],
      [text.unavailable, "new"],
      [text.rateLimited, "new"],
      [text.invalidServer, "new"],
      [text.unconfirmed, "new"],
      [text.unconfirmed, "same"],
      [text.unavailable, "same"],
    ];
    for (const [message, reference] of expected) {
      await submitAndExpect(form, status, message, bodies);
      await expect(form.locator('[name="firstName"]')).toHaveValue("Jordan");
      const [previous, current] = bodies.slice(-2);
      if (bodies.length > 1) expect(current.requestId === previous.requestId, `${message}: ${reference} reference`).toBe(reference === "same");
      else await shoot(page, "en-1440-unconfirmed.png");
    }
    expect(Object.keys(bodies[0]).sort()).toEqual(fieldNames);
    expect(bodies[0]).toMatchObject({ locale: "en", website: "", firstName: "Jordan", subject: "english-communication" });
    expect(bodies[0].requestId).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
    // Changed answers are a new inquiry; a second submit while sending is ignored.
    const before = bodies.length;
    const lastReference = bodies.at(-1).requestId;
    await form.locator('[name="message"]').fill("Synthetic browser check, changed answer.");
    await form.evaluate(node => { node.requestSubmit(); node.requestSubmit(); });
    await expect(status).toContainText(text.success);
    expect(bodies).toHaveLength(before + 1);
    expect(bodies.at(-1).requestId).not.toBe(lastReference);
    await expect(form.locator('[name="firstName"]')).toHaveValue("");
    await expect(status).toBeFocused();
    await expect(form.locator('button[type="submit"]')).toHaveText("Send inquiry");
    await shoot(page, "en-1440-success.png");
    await page.close();
  });

  await step("zh-Hant: Chinese messages, reference reuse and success at 390px", async () => {
    const bodies = [];
    const { text } = pages["zh-Hant"];
    const { page, form, status } = await open(context, origin, "zh-Hant", 390);
    await simulate(page, [
      { status: 502, json: { code: "DELIVERY_UNCONFIRMED" } },
      { status: 409, json: { code: "DELIVERY_IN_PROGRESS" } },
      { status: 200, json: { ok: true } },
    ], bodies);
    await fillValid(form, "zh-Hant");
    await submitAndExpect(form, status, text.unconfirmed, bodies);
    await shoot(page, "zh-Hant-390-unconfirmed.png");
    await submitAndExpect(form, status, text.inProgress, bodies);
    await submitAndExpect(form, status, text.success, bodies);
    expect(new Set(bodies.map(body => body.requestId)).size).toBe(1);
    expect(bodies[0]).toMatchObject({ locale: "zh-Hant", firstName: "小明", lastName: "林" });
    await expect(form.locator('button[type="submit"]')).toHaveText("送出詢問");
    await shoot(page, "zh-Hant-390-success.png");
    // The registration form is a separate Google Form: check the link, never open it.
    const registration = page.locator('a[href="https://forms.gle/NoTSzGmf4nW2aWPT7"]');
    await expect(registration).toBeVisible();
    await expect(registration).toHaveAttribute("target", "_blank");
    await expect(registration).toHaveAttribute("rel", "noopener noreferrer");
    await page.close();
  });

  for (const lang of ["en", "zh-Hant"]) {
    await step(`${lang}: the real route refuses delivery without Resend settings`, async () => {
      const { page, form, status } = await open(context, origin, lang, 1440);
      await fillValid(form, lang);
      const answer = page.waitForResponse(response => response.url() === `${origin}/api/academy-inquiry`);
      await form.locator('button[type="submit"]').click();
      const response = await answer;
      expect(response.status()).toBe(503);
      expect(await response.json()).toEqual({ code: "EMAIL_UNAVAILABLE" });
      // Request-limit headers prove the refusal came from the missing mail settings.
      expect(response.headers()["ratelimit-limit"]).toBe("5");
      expect(response.headers()["cache-control"]).toContain("no-store");
      await expect(status).toContainText(pages[lang].text.unavailable);
      await expect(form.locator('[name="email"]')).toHaveValue("parent@example.com");
      await page.close();
    });
  }

  await step("API: other methods and foreign origins are refused", async () => {
    expect((await fetch(`${origin}/api/academy-inquiry`)).status).toBe(405);
    const foreign = await fetch(`${origin}/api/academy-inquiry`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}",
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ code: "ORIGIN_NOT_ALLOWED" });
  });

  await step("without JavaScript the form stays disabled and offers email", async () => {
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    const page = await noScript.newPage();
    await page.goto(`${origin}/academy/courses?entry=official`);
    await expect(page.locator("form[data-inquiry-form] fieldset")).toHaveJSProperty("disabled", true);
    await expect(page.locator('form[data-inquiry-form] [name="firstName"]')).toBeDisabled();
    await expect(page.locator('form[data-inquiry-form] button[type="submit"]')).toBeDisabled();
    // Playwright's text locators skip <noscript>, so check the rendered paragraph directly.
    const fallback = page.locator("form[data-inquiry-form] noscript p");
    await expect(fallback).toBeVisible();
    expect(await fallback.textContent()).toContain("Please enable JavaScript to use this form");
    await expect(fallback.locator('a[href^="mailto:ihearprogram@gmail.com"]')).toBeVisible();
    await noScript.close();
  });

  expect(external, "No request may leave the local server").toEqual([]);
  await context.close();
  server.stop();
  server = null;

  // Part 2: the real route with a simulated Resend inside the server process.
  const fakeDir = path.resolve("output/playwright/academy-inquiry-fake-resend");
  await mkdir(fakeDir, { recursive: true });
  const fakeControl = path.join(fakeDir, "control.json");
  let fakeLog, sessions = 0;
  const events = async () => (await readFile(fakeLog, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  const queue = behaviors => writeFile(fakeControl, JSON.stringify(behaviors));
  // Each server session stays within the request limit of 5 per 10 minutes and
  // keeps its own event log for review.
  async function fakeSession(run) {
    fakeLog = path.join(fakeDir, `resend-session-${++sessions}.jsonl`);
    await writeFile(fakeLog, "");
    await queue([]);
    server = await startServer(3219, {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(path.resolve("tests/helpers/fake-resend.mjs")).href}`].filter(Boolean).join(" "),
      FAKE_RESEND_LOG: fakeLog,
      FAKE_RESEND_CONTROL: fakeControl,
      RESEND_API_KEY: "re_synthetic_not_a_real_key",
      ACADEMY_INQUIRY_FROM: "iHear Academy <academy@notify.example.org>",
    });
    // Never submit unless the simulated Resend is active in the server.
    expect((await events()).some(event => event.type === "ready"), "fake Resend preload is active").toBe(true);
    const outside = [];
    const fakeContext = await isolatedContext(browser, server.base, outside);
    try {
      await run(fakeContext, server.base);
    } finally {
      await fakeContext.close();
      server.stop();
      server = null;
    }
    expect(outside, "No browser request may leave the local server").toEqual([]);
    expect((await events()).filter(event => event.type === "blocked"), "The server made no other outside request").toEqual([]);
  }

  await fakeSession(async (fakeContext, base) => {
    await step("simulated Resend: English and Chinese inquiries become the expected email, and a double submit sends once", async () => {
      for (const lang of ["en", "zh-Hant"]) {
        const before = (await events()).filter(event => event.type === "request").length;
        const { page, form, status } = await open(fakeContext, base, lang, lang === "en" ? 1440 : 390);
        await fillValid(form, lang);
        await form.evaluate(node => { node.requestSubmit(); node.requestSubmit(); });
        await expect(status).toContainText(pages[lang].text.success);
        await expect(form.locator('[name="firstName"]')).toHaveValue("");
        const requests = (await events()).filter(event => event.type === "request").slice(before);
        expect(requests).toHaveLength(1);
        const [{ key, authorization, body }] = requests;
        const reference = key.replace(/^academy-inquiry\//, "");
        expect(key).toMatch(/^academy-inquiry\/[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
        expect(authorization).toBe("Bearer re_synthetic_not_a_real_key");
        expect(Object.keys(body).sort()).toEqual(["from", "reply_to", "subject", "text", "to"]);
        expect(body).toMatchObject({ from: "iHear Academy <academy@notify.example.org>", to: ["ihearprogram@gmail.com"], reply_to: "parent@example.com" });
        const name = lang === "en" ? "Jordan Chen" : "小明 林";
        expect(body.subject).toBe(`iHear Academy 課程詢問 / Course inquiry · ${name} · English communication · Ref ${reference.slice(0, 8)}`);
        for (const line of [
          `詢問編號 / Reference: ${reference}`,
          `表單語言 / Form language: ${lang === "en" ? "英文 / English" : "繁體中文 / Traditional Chinese"}`,
          `名字 / First name: ${lang === "en" ? "Jordan" : "小明"}`,
          "電子信箱 / Email: parent@example.com",
          "想了解的課程 / Subject: 英文口說與聽力 / English communication",
          "Synthetic browser check only.",
        ]) expect(body.text).toContain(line);
        await page.close();
      }
      expect((await events()).filter(event => event.type === "accepted")).toHaveLength(2);
    });

    await step("simulated Resend: after a timeout, a simultaneous duplicate is refused and the unchanged resend delivers one email", async () => {
      await queue(["accept-then-hang"]);
      const { page, form, status } = await open(fakeContext, base, "en", 390);
      await fillValid(form, "en");
      await form.locator('[name="message"]').fill("Synthetic timeout check.");
      let payload;
      page.on("request", request => { if (request.url() === `${base}/api/academy-inquiry`) payload ??= request.postData(); });
      const started = Date.now();
      const answer = page.waitForResponse(response => response.url() === `${base}/api/academy-inquiry`, { timeout: 30000 });
      await form.locator('button[type="submit"]').click();
      // While Resend has accepted but not yet answered, the same inquiry arrives again.
      await expect.poll(async () => (await events()).some(event => event.type === "inflight")).toBe(true);
      const duplicate = await fetch(`${base}/api/academy-inquiry`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: payload });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({ code: "DELIVERY_IN_PROGRESS" });
      // The server's own 10-second limit ends the first request, not the browser's.
      const response = await answer;
      expect(response.status()).toBe(502);
      expect(await response.json()).toEqual({ code: "DELIVERY_UNCONFIRMED" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(9000);
      expect(Date.now() - started).toBeLessThan(20000);
      await expect(status).toContainText(pages.en.text.unconfirmed);
      await shoot(page, "en-390-timeout-unconfirmed.png");
      // Resending the unchanged answers reuses the reference, so Resend answers with the first result.
      const resent = page.waitForRequest(request => request.url() === `${base}/api/academy-inquiry`);
      const resentAnswer = page.waitForResponse(response => response.url() === `${base}/api/academy-inquiry`);
      await form.locator('button[type="submit"]').click();
      expect((await resent).postData()).toBe(payload);
      expect((await resentAnswer).status()).toBe(200);
      await expect(status).toContainText(pages.en.text.success);
      const key = `academy-inquiry/${JSON.parse(payload).requestId}`;
      const log = (await events()).filter(event => event.key === key);
      expect(log.filter(event => event.type === "accepted")).toHaveLength(1);
      expect(log.filter(event => event.type === "concurrent")).toHaveLength(1);
      expect(log.filter(event => event.type === "replayed")).toHaveLength(1);
      expect((await events()).filter(event => event.type === "accepted")).toHaveLength(3);
      await page.close();
    });
  });

  await fakeSession(async (fakeContext, base) => {
    await step("simulated Resend: a refused request is not sent, and the retry uses a new reference", async () => {
      await queue([{ status: 422, name: "validation_error" }]);
      const { page, form, status } = await open(fakeContext, base, "zh-Hant", 1440);
      await fillValid(form, "zh-Hant");
      await form.locator('button[type="submit"]').click();
      await expect(status).toContainText(pages["zh-Hant"].text.failed);
      await form.locator('button[type="submit"]').click();
      await expect(status).toContainText(pages["zh-Hant"].text.success);
      const requests = (await events()).filter(event => event.type === "request");
      expect(requests).toHaveLength(2);
      expect(requests[0].key).not.toBe(requests[1].key);
      const accepted = (await events()).filter(event => event.type === "accepted");
      expect(accepted.map(event => event.key)).toEqual([requests[1].key]);
      await page.close();
    });

    await step("simulated Resend: a used-up daily quota pauses the form without sending", async () => {
      await queue([{ status: 429, name: "daily_quota_exceeded" }]);
      const { page, form, status } = await open(fakeContext, base, "en", 768);
      await fillValid(form, "en");
      await form.locator('[name="message"]').fill("Synthetic quota check.");
      await form.locator('button[type="submit"]').click();
      await expect(status).toContainText(pages.en.text.unavailable);
      await expect(form.locator('[name="message"]')).toHaveValue("Synthetic quota check.");
      expect((await events()).filter(event => event.type === "accepted")).toHaveLength(1);
      await page.close();
    });
  });

  console.log(`Academy inquiry browser checks passed. Screenshots: ${shots}`);
} finally {
  server?.stop();
  await browser?.close();
}
