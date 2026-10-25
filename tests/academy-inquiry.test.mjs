import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/rate-limit", async original => ({
  ...await original(),
  enforceRateLimit: vi.fn(),
}));

import { POST } from "../app/api/academy-inquiry/route";
import { ACADEMY_INQUIRY_MAX_BYTES, ACADEMY_INQUIRY_RATE_LIMIT } from "../lib/academy-inquiry";
import { enforceRateLimit, rateLimitExceededResponse } from "../lib/rate-limit";

const fixture = {
  firstName: "Jordan",
  lastName: "Chen",
  email: "parent@example.com",
  phone: "",
  location: "Taipei (UTC+8)",
  gradeLevel: "elementary",
  subject: "english-communication",
  sessionFormat: "online-one-on-one",
  startTime: "within-weeks",
  contactMethod: "email",
  availability: "Saturday 10:00–12:00",
  message: "Beginner. Build confidence in conversation.",
  website: "",
  locale: "en",
  requestId: "a2dd1a14-42ef-4e30-bc1d-9b59eebfc7df",
};

function request(body = fixture, options = {}) {
  const headers = { "Content-Type": "application/json", Origin: "https://www.ihearus.org", ...options.headers };
  if (options.omitOrigin) delete headers.Origin;
  return new Request(options.url || "https://www.ihearus.org/api/academy-inquiry", {
    method: "POST", headers, body: options.raw ?? JSON.stringify(body),
  });
}

function providerResponse(status, body) {
  return body === undefined ? new Response(null, { status }) : Response.json(body, { status });
}

let mailFetch;
let warn;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_test_key_never_used_for_network");
  vi.stubEnv("ACADEMY_INQUIRY_FROM", "iHear Academy <academy@notify.example.org>");
  vi.stubEnv("ACADEMY_INQUIRY_TO", "");
  enforceRateLimit.mockResolvedValue({
    limited: false,
    result: { allowed: true, limit: 5, remaining: 4, retryAfter: 600, resetAt: "2026-10-25T12:00:00.000Z" },
  });
  mailFetch = vi.fn(async () => providerResponse(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
  vi.stubGlobal("fetch", mailFetch);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  warn.mockRestore();
});

function sent(call = 0) {
  const [url, init] = mailFetch.mock.calls[call];
  return { url, init, payload: JSON.parse(init.body) };
}

describe("Academy inquiry delivery through Resend", () => {
  test("accepts a valid inquiry only after Resend returns the new email id", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("ratelimit-limit")).toBe("5");
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.any(Request), ACADEMY_INQUIRY_RATE_LIMIT);
    expect(mailFetch).toHaveBeenCalledTimes(1);
    const { url, init, payload } = sent();
    expect(url).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer re_test_key_never_used_for_network",
        "Content-Type": "application/json",
        "Idempotency-Key": `academy-inquiry/${fixture.requestId}`,
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(payload).sort()).toEqual(["from", "reply_to", "subject", "text", "to"]);
    expect(payload.from).toBe("iHear Academy <academy@notify.example.org>");
    expect(payload.to).toEqual(["ihearprogram@gmail.com"]);
    expect(payload.reply_to).toBe(fixture.email);
    expect(payload.subject).toBe("iHear Academy 課程詢問 / Course inquiry · Jordan Chen · English communication · Ref a2dd1a14");
    for (const line of [
      `詢問編號 / Reference: ${fixture.requestId}`,
      "表單語言 / Form language: 英文 / English",
      "名字 / First name: Jordan",
      "姓氏 / Last name: Chen",
      "電子信箱 / Email: parent@example.com",
      "聯絡電話 / Phone: 未填寫 / Not provided",
      "偏好的聯繫方式 / Preferred contact method: 電子郵件 / Email",
      "所在城市或時區 / City or time zone: Taipei (UTC+8)",
      "學生年級 / Student's grade level: 國小 / Elementary (K–5)",
      "想了解的課程 / Subject: 英文口說與聽力 / English communication",
      "上課形式 / Session format: 線上一對一（Zoom） / Online one-on-one (Zoom)",
      "希望何時開始 / Preferred start: 未來幾週內 / Within a few weeks",
      "可上課的星期與時段 / Available days and times: Saturday 10:00–12:00",
      fixture.message,
    ]) expect(payload.text).toContain(line);
  });

  test("identical answers produce an identical body and key, with no sending time", async () => {
    await POST(request());
    await POST(request());
    expect(mailFetch).toHaveBeenCalledTimes(2);
    expect(sent(0).init.body).toBe(sent(1).init.body);
    expect(sent(0).init.headers["Idempotency-Key"]).toBe(sent(1).init.headers["Idempotency-Key"]);
    expect(sent(0).payload.text).not.toMatch(/\d{4}-\d{2}-\d{2}T|\d{1,2}:\d{2}:\d{2}/);
  });

  test("accepts first name, email and subject without the optional details", async () => {
    const minimal = Object.fromEntries(["firstName", "email", "subject", "locale", "requestId"].map(key => [key, fixture[key]]));
    const response = await POST(request(minimal));
    expect(response.status).toBe(200);
    const { payload } = sent();
    expect(payload.subject).toBe("iHear Academy 課程詢問 / Course inquiry · Jordan · English communication · Ref a2dd1a14");
    expect(payload.text).toContain("學生年級 / Student's grade level: 未填寫 / Not provided");
    expect(payload.text).toContain("偏好的聯繫方式 / Preferred contact method: 未填寫 / Not provided");
  });

  test("accepts empty optional fields", async () => {
    const body = { ...fixture };
    for (const key of ["lastName", "phone", "location", "gradeLevel", "sessionFormat", "startTime", "contactMethod", "availability", "message"]) body[key] = "";
    expect((await POST(request(body))).status).toBe(200);
    expect(mailFetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["gradeLevel", ["elementary", "middle", "high", "college", "adult", "other"]],
    ["subject", ["english-communication", "reading-writing", "academic-support", "sat-psat", "not-sure"]],
    ["sessionFormat", ["online-one-on-one", "small-group", "not-sure"]],
    ["startTime", ["asap", "within-weeks", "next-term", "exploring"]],
    ["contactMethod", ["email", "phone", "no-preference"]],
  ])("accepts every %s choice shown on the pages", async (field, values) => {
    for (const value of values) {
      expect((await POST(request({ ...fixture, [field]: value, phone: "+1 (415) 555-0100" }))).status).toBe(200);
    }
  });

  test.each(["12345", "+886 912 345 678", "+1 (415) 555-0100", "1".repeat(25)])("accepts the phone number %s", async phone => {
    expect((await POST(request({ ...fixture, phone }))).status).toBe(200);
  });

  test("requires a phone number when phone contact is preferred", async () => {
    const response = await POST(request({ ...fixture, contactMethod: "phone", phone: "" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test("keeps Chinese and multiline answers in the bilingual email", async () => {
    const response = await POST(request({
      ...fixture, locale: "zh-Hant", firstName: "小明", lastName: "林", subject: "sat-psat",
      message: "目前初學\r\n希望更有自信開口", gradeLevel: "",
    }));
    expect(response.status).toBe(200);
    const { payload } = sent();
    expect(payload.subject).toBe("iHear Academy 課程詢問 / Course inquiry · 小明 林 · SAT & PSAT preparation · Ref a2dd1a14");
    expect(payload.text).toContain("目前初學\n希望更有自信開口");
    expect(payload.text).toContain("表單語言 / Form language: 繁體中文 / Traditional Chinese");
    expect(payload.text).toContain("想了解的課程 / Subject: SAT／PSAT 考試準備 / SAT & PSAT preparation");
  });

  test("shortens long names in the subject line", async () => {
    await POST(request({ ...fixture, firstName: "名".repeat(100), lastName: "" }));
    expect(sent().payload.subject).toContain(`· ${"名".repeat(60)} ·`);
  });
});

describe("Academy inquiry validation and abuse protection", () => {
  test.each(["to", "recipient", "from", "cc", "bcc", "reply_to", "headers", "text", "html", "contactName"])("rejects the caller-supplied field %s", async field => {
    const response = await POST(request({ ...fixture, [field]: "other@example.com" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test.each(["firstName", "email", "subject", "locale", "requestId"])("requires %s", async field => {
    const body = { ...fixture };
    delete body[field];
    expect((await POST(request(body))).status).toBe(400);
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test.each([
    { email: "bad-address" },
    { email: "parent@example.com,other@example.com" },
    { email: "parent@example.com\r\nBcc:other@example.com" },
    { email: { to: "someone@example.com" } },
    { firstName: "Jordan\nBcc: other@example.com" },
    { firstName: "   " },
    { firstName: "‮Jordan" },
    { lastName: "Chen\nBcc: other@example.com" },
    { location: "Taipei\nUTC+8" },
    { availability: "Saturday\nSunday" },
    { subject: "" },
    { subject: "other@example.com" },
    { subject: "constructor" },
    { subject: "__proto__" },
    { gradeLevel: "grade-4" },
    { sessionFormat: "in-person" },
    { startTime: "tomorrow" },
    { contactMethod: "fax" },
    { phone: "1234" },
    { phone: "1".repeat(26) },
    { phone: "Call me at 12345678" },
    { phone: "+12345\nBcc:other@example.com" },
    { firstName: "x".repeat(101) },
    { lastName: "x".repeat(101) },
    { location: "x".repeat(101) },
    { availability: "x".repeat(301) },
    { message: "x".repeat(2001) },
    { message: "Hello\u0000" },
    { locale: "zh" },
    { requestId: "not-a-uuid" },
  ])("rejects invalid field values %j", async changes => {
    const response = await POST(request({ ...fixture, ...changes }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test.each([null, [], "text", 123])("rejects non-object JSON %j", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test("rejects malformed JSON and non-JSON content types", async () => {
    expect((await POST(request(fixture, { raw: "{" }))).status).toBe(400);
    expect((await POST(request(fixture, { headers: { "Content-Type": "text/plain" } }))).status).toBe(415);
    expect((await POST(request(fixture, { headers: { "Content-Type": "application/x-www-form-urlencoded" } }))).status).toBe(415);
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test("limits actual UTF-8 bytes even with a misleading Content-Length", async () => {
    const body = { ...fixture, message: "漢".repeat(6000) };
    expect(JSON.stringify(body).length).toBeLessThan(ACADEMY_INQUIRY_MAX_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeGreaterThan(ACADEMY_INQUIRY_MAX_BYTES);
    const response = await POST(request(body, { headers: { "Content-Length": "1" } }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test("cancels an oversized chunked body without consuming the remaining stream", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(ACADEMY_INQUIRY_MAX_BYTES + 1)); },
      cancel,
    }, { highWaterMark: 0 });
    const req = new Request("https://www.ihearus.org/api/academy-inquiry", {
      method: "POST", headers: { Origin: "https://www.ihearus.org", "Content-Type": "application/json" },
      body: stream, duplex: "half",
    });
    expect((await POST(req)).status).toBe(413);
    expect(reads).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test.each(["https://evil.example", "https://www.ihearus.org.evil.example", "https://www.ihearus.org/path", "null", "not a url"])("rejects the untrusted Origin %s", async origin => {
    const response = await POST(request(fixture, { headers: { Origin: origin } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "ORIGIN_NOT_ALLOWED" });
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test("requires Origin and does not trust forwarded host headers", async () => {
    expect((await POST(request(fixture, { omitOrigin: true }))).status).toBe(403);
    const forged = await POST(request(fixture, { headers: { Origin: "https://evil.example", "x-forwarded-host": "evil.example" } }));
    expect(forged.status).toBe(403);
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test.each(["https://www.ihearus.org", "https://ihearus.org"])("accepts the production Origin %s behind Vercel's internal URL", async origin => {
    const response = await POST(request(fixture, { url: "https://internal.vercel.app/api/academy-inquiry", headers: { Origin: origin } }));
    expect(response.status).toBe(200);
  });

  test("accepts a same-origin local submission", async () => {
    const response = await POST(request(fixture, { url: "http://localhost:3216/api/academy-inquiry", headers: { Origin: "http://localhost:3216" } }));
    expect(response.status).toBe(200);
  });

  test("rejects a filled honeypot without sending or pretending to succeed", async () => {
    const response = await POST(request({ ...fixture, website: "https://spam.example" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test("enforces the request limit before reading or validating the body", async () => {
    enforceRateLimit.mockResolvedValueOnce({ limited: true, response: rateLimitExceededResponse({
      allowed: false, limit: 5, remaining: 0, retryAfter: 100, resetAt: "2026-10-25T12:00:00.000Z",
    }) });
    const req = request(fixture, { raw: "invalid JSON" });
    const response = await POST(req);
    expect(req.bodyUsed).toBe(false);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("100");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test("fails closed when shared request protection is unavailable", async () => {
    enforceRateLimit.mockResolvedValueOnce({ limited: true, response: new Response(null, { status: 503 }) });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "EMAIL_UNAVAILABLE" });
    expect(mailFetch).not.toHaveBeenCalled();
  });
});

describe("Academy inquiry mail configuration", () => {
  test.each(["RESEND_API_KEY", "ACADEMY_INQUIRY_FROM"])("reports a missing %s without contacting Resend", async key => {
    vi.stubEnv(key, "");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "EMAIL_UNAVAILABLE" });
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test.each(["academy@notify.example.org", "iHear Academy <academy@notify.example.org>"])("accepts the sender %s", async from => {
    vi.stubEnv("ACADEMY_INQUIRY_FROM", from);
    expect((await POST(request())).status).toBe(200);
    expect(sent().payload.from).toBe(from);
  });

  test.each(["not-an-address", 'Evil "Name" <academy@notify.example.org>', "iHear <a@example.org>, <b@example.org>", "iHear Academy <academy@notify.example.org> x"])("rejects the misconfigured sender %s", async from => {
    vi.stubEnv("ACADEMY_INQUIRY_FROM", from);
    expect((await POST(request())).status).toBe(503);
    expect(mailFetch).not.toHaveBeenCalled();
  });

  test("sends to the configured test recipient instead of the default", async () => {
    vi.stubEnv("ACADEMY_INQUIRY_TO", "test-inbox@example.org");
    expect((await POST(request())).status).toBe(200);
    expect(sent().payload.to).toEqual(["test-inbox@example.org"]);
  });

  test.each(["a@example.org,b@example.org", "Test <a@example.org>", "not-an-address"])("rejects the misconfigured recipient %s", async to => {
    vi.stubEnv("ACADEMY_INQUIRY_TO", to);
    expect((await POST(request())).status).toBe(503);
    expect(mailFetch).not.toHaveBeenCalled();
  });
});

describe("Academy inquiry Resend outcomes", () => {
  test.each([
    ["the concurrent request with the same key", 409, { name: "concurrent_idempotent_requests" }, "DELIVERY_IN_PROGRESS", 409],
    ["the same key with a different body", 409, { name: "invalid_idempotent_request" }, "DELIVERY_FAILED", 502],
    ["another 409", 409, { name: "resource_locked" }, "DELIVERY_UNCONFIRMED", 502],
    ["a 409 without an error name", 409, undefined, "DELIVERY_UNCONFIRMED", 502],
    ["an invalid idempotency key", 400, { name: "invalid_idempotency_key" }, "DELIVERY_FAILED", 502],
    ["a validation error", 422, { name: "missing_required_field" }, "DELIVERY_FAILED", 502],
    ["the per-second limit", 429, { name: "rate_limit_exceeded" }, "DELIVERY_FAILED", 502],
    ["an unnamed 429", 429, undefined, "DELIVERY_FAILED", 502],
    ["the daily quota", 429, { name: "daily_quota_exceeded" }, "EMAIL_UNAVAILABLE", 503],
    ["the monthly quota", 429, { name: "monthly_quota_exceeded" }, "EMAIL_UNAVAILABLE", 503],
    ["a missing key", 401, { name: "missing_api_key" }, "EMAIL_UNAVAILABLE", 503],
    ["an unverified sender domain", 403, { name: "validation_error" }, "EMAIL_UNAVAILABLE", 503],
    ["an application error", 500, { name: "application_error" }, "DELIVERY_UNCONFIRMED", 502],
    ["a temporary outage", 503, { name: "service_unavailable" }, "DELIVERY_UNCONFIRMED", 502],
    ["success without an id", 200, {}, "DELIVERY_UNCONFIRMED", 502],
    ["success without a body", 200, undefined, "DELIVERY_UNCONFIRMED", 502],
  ])("maps %s without retrying or exposing provider details", async (_label, status, body, code, expected) => {
    mailFetch.mockResolvedValueOnce(providerResponse(status, body && { ...body, message: "provider detail must not be exposed" }));
    const response = await POST(request());
    expect(response.status).toBe(expected);
    expect(await response.json()).toEqual({ code });
    expect(mailFetch).toHaveBeenCalledTimes(1);
  });

  test("ignores an oversized provider error body and falls back to its status", async () => {
    mailFetch.mockResolvedValueOnce(new Response(JSON.stringify({ name: "concurrent_idempotent_requests", padding: "x".repeat(5000) }), { status: 409 }));
    const response = await POST(request());
    expect(await response.json()).toEqual({ code: "DELIVERY_UNCONFIRMED" });
  });

  test.each([new DOMException("Timed out", "TimeoutError"), new TypeError("Network unavailable")])("reports an uncertain network outcome without retrying (%s)", async error => {
    mailFetch.mockRejectedValueOnce(error);
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "DELIVERY_UNCONFIRMED" });
    expect(mailFetch).toHaveBeenCalledTimes(1);
  });

  test("logs delivery problems without any of the answers", async () => {
    mailFetch.mockResolvedValueOnce(providerResponse(500, { name: "application_error" }));
    await POST(request({ ...fixture, contactMethod: "phone", phone: "+886 912 345 678" }));
    mailFetch.mockRejectedValueOnce(new TypeError("Network unavailable"));
    await POST(request());
    expect(warn).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("a2dd1a14");
    for (const value of [fixture.firstName, fixture.lastName, fixture.email, "912 345 678", fixture.location, fixture.availability, fixture.message, "re_test_key"]) {
      expect(logged).not.toContain(value);
    }
  });
});
