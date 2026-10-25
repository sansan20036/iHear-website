export const ACADEMY_INQUIRY_DEFAULT_RECIPIENT = "ihearprogram@gmail.com";
export const ACADEMY_INQUIRY_MAX_BYTES = 16_384;
export const ACADEMY_INQUIRY_RATE_LIMIT = {
  scope: "academy-inquiry",
  limit: 5,
  windowSeconds: 600,
} as const;

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const NOT_PROVIDED = "未填寫 / Not provided";

// Both pages submit the same values; the email shows the Chinese and English labels.
const GRADE_LEVELS = {
  elementary: ["國小", "Elementary (K–5)"],
  middle: ["國中", "Middle school (6–8)"],
  high: ["高中", "High school (9–12)"],
  college: ["大學", "College"],
  adult: ["成人學習者", "Adult learner"],
  other: ["其他或尚不確定", "Other or not sure"],
} as const;

const SUBJECTS = {
  "english-communication": ["英文口說與聽力", "English communication"],
  "reading-writing": ["英文閱讀與寫作", "Writing & reading"],
  "academic-support": ["課業輔導（含數學）", "Math & academic support"],
  "sat-psat": ["SAT／PSAT 考試準備", "SAT & PSAT preparation"],
  "not-sure": ["尚不確定", "Not sure yet"],
} as const;

const SESSION_FORMATS = {
  "online-one-on-one": ["線上一對一（Zoom）", "Online one-on-one (Zoom)"],
  "small-group": ["想詢問小班", "Ask about small groups"],
  "not-sure": ["尚不確定", "Not sure yet"],
} as const;

const START_TIMES = {
  asap: ["儘快開始", "As soon as possible"],
  "within-weeks": ["未來幾週內", "Within a few weeks"],
  "next-term": ["下學期", "Next school term"],
  exploring: ["先了解看看", "Just exploring"],
} as const;

const CONTACT_METHODS = {
  email: ["電子郵件", "Email"],
  phone: ["電話", "Phone"],
  "no-preference": ["皆可", "No preference"],
} as const;

type Choices = Record<string, readonly [string, string]>;

export type AcademyInquiry = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  gradeLevel: keyof typeof GRADE_LEVELS | "";
  subject: keyof typeof SUBJECTS;
  sessionFormat: keyof typeof SESSION_FORMATS | "";
  startTime: keyof typeof START_TIMES | "";
  contactMethod: keyof typeof CONTACT_METHODS | "";
  availability: string;
  message: string;
  locale: "en" | "zh-Hant";
  requestId: string;
};

export type AcademyInquiryErrorCode =
  | "INVALID_INPUT"
  | "EMAIL_UNAVAILABLE"
  | "DELIVERY_FAILED"
  | "DELIVERY_IN_PROGRESS"
  | "DELIVERY_UNCONFIRMED";

export class AcademyInquiryError extends Error {
  constructor(
    public readonly code: AcademyInquiryErrorCode,
    public readonly status: number,
  ) {
    super(code);
  }
}

function invalidInput(status = 400): never {
  throw new AcademyInquiryError("INVALID_INPUT", status);
}

export function academyInquiryOriginAllowed(request: Request) {
  const raw = request.headers.get("origin");
  if (!raw || raw === "null") return false;
  try {
    const origin = new URL(raw);
    // Origin is a serialized origin, never a URL with a path or credentials.
    if (raw !== origin.origin || !["http:", "https:"].includes(origin.protocol)) return false;
    return origin.origin === new URL(request.url).origin
      || origin.origin === "https://www.ihearus.org"
      || origin.origin === "https://ihearus.org";
  } catch {
    return false;
  }
}

export async function readAcademyInquiryBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get("content-type") || "")) {
    invalidInput(415);
  }
  const declaredSize = request.headers.get("content-length");
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > ACADEMY_INQUIRY_MAX_BYTES)) {
    invalidInput(413);
  }
  if (!request.body) invalidInput();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > ACADEMY_INQUIRY_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        invalidInput(413);
      }
      chunks.push(chunk.value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch (error) {
    if (error instanceof AcademyInquiryError) throw error;
    invalidInput();
  } finally {
    reader.releaseLock();
  }
}

function validEmail(value: string) {
  if (value.length > 254) return false;
  const [local] = value.split("@");
  return local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
    && /^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(value);
}

// Bidirectional controls could reorder how a name reads in the email subject.
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/;

export function validateAcademyInquiry(value: unknown): AcademyInquiry {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidInput();
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "firstName", "lastName", "email", "phone", "location", "gradeLevel", "subject", "sessionFormat",
    "startTime", "contactMethod", "availability", "message", "website", "locale", "requestId",
  ]);
  if (Object.keys(body).some(key => !allowed.has(key))) invalidInput();

  function field(name: string, max: number, required = false, multiline = false) {
    const value = body[name] ?? "";
    if (typeof value !== "string") invalidInput();
    const text = value.trim();
    const disallowed = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
    if ((required && !text) || text.length > max || disallowed.test(text) || BIDI_CONTROLS.test(text)) invalidInput();
    return text.replace(/\r\n?/g, "\n");
  }

  function choice<T extends Choices>(name: string, choices: T, required = false) {
    const value = field(name, 40, required);
    if (value && !Object.hasOwn(choices, value)) invalidInput();
    return value as keyof T & string;
  }

  // Reject bots without sending mail or reporting a successful delivery.
  if (field("website", 200)) invalidInput();
  const email = field("email", 254, true);
  if (!validEmail(email)) invalidInput();
  const contactMethod = choice("contactMethod", CONTACT_METHODS);
  const phone = field("phone", 60);
  const phoneDigits = phone.replace(/\D/g, "").length;
  if ((phone && (!/^[+\d\s().-]+$/.test(phone) || phoneDigits < 5 || phoneDigits > 25))
    || (contactMethod === "phone" && !phone)) invalidInput();
  if (body.locale !== "en" && body.locale !== "zh-Hant") invalidInput();
  const requestId = field("requestId", 36, true);
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(requestId)) invalidInput();

  return {
    firstName: field("firstName", 100, true),
    lastName: field("lastName", 100),
    email,
    phone,
    location: field("location", 100),
    gradeLevel: choice("gradeLevel", GRADE_LEVELS),
    subject: choice("subject", SUBJECTS, true),
    sessionFormat: choice("sessionFormat", SESSION_FORMATS),
    startTime: choice("startTime", START_TIMES),
    contactMethod,
    availability: field("availability", 300),
    message: field("message", 2000, false, true),
    locale: body.locale,
    requestId: requestId.toLowerCase(),
  };
}

function label(choices: Choices, value: string) {
  return value ? `${choices[value][0]} / ${choices[value][1]}` : NOT_PROVIDED;
}

export function academyInquirySubject(inquiry: AcademyInquiry) {
  const name = [...[inquiry.firstName, inquiry.lastName].filter(Boolean).join(" ")].slice(0, 60).join("");
  // The short reference lets staff spot a repeated inquiry in the inbox list.
  return `iHear Academy 課程詢問 / Course inquiry · ${name} · ${SUBJECTS[inquiry.subject][1]} · Ref ${inquiry.requestId.slice(0, 8)}`;
}

// The text depends only on the answers: Resend's idempotency check compares
// request bodies, so it must never include the time of sending.
export function academyInquiryText(inquiry: AcademyInquiry) {
  const optional = (value: string) => value || NOT_PROVIDED;
  return [
    "iHear Academy 課程詢問 / Course inquiry",
    `詢問編號 / Reference: ${inquiry.requestId}`,
    `表單語言 / Form language: ${inquiry.locale === "zh-Hant" ? "繁體中文 / Traditional Chinese" : "英文 / English"}`,
    "",
    "聯絡資料 / Contact",
    `名字 / First name: ${inquiry.firstName}`,
    `姓氏 / Last name: ${optional(inquiry.lastName)}`,
    `電子信箱 / Email: ${inquiry.email}`,
    `聯絡電話 / Phone: ${optional(inquiry.phone)}`,
    `偏好的聯繫方式 / Preferred contact method: ${label(CONTACT_METHODS, inquiry.contactMethod)}`,
    `所在城市或時區 / City or time zone: ${optional(inquiry.location)}`,
    "",
    "學生與課程 / Student and tutoring",
    `學生年級 / Student's grade level: ${label(GRADE_LEVELS, inquiry.gradeLevel)}`,
    `想了解的課程 / Subject: ${label(SUBJECTS, inquiry.subject)}`,
    `上課形式 / Session format: ${label(SESSION_FORMATS, inquiry.sessionFormat)}`,
    `希望何時開始 / Preferred start: ${label(START_TIMES, inquiry.startTime)}`,
    `可上課的星期與時段 / Available days and times: ${optional(inquiry.availability)}`,
    "",
    "還有什麼想讓我們知道 / Anything else:",
    optional(inquiry.message),
    "",
    "直接回覆這封信即可聯絡填表人。 / Reply to this email to contact the sender.",
  ].join("\n");
}

// Server configuration only: "address" or "Display Name <address>".
function configuredSender(value: string | undefined) {
  const text = value?.trim() || "";
  const named = /^[A-Za-z0-9 .'&()-]{1,64} <([^<>\s]+)>$/.exec(text);
  return validEmail(named ? named[1] : text) ? text : "";
}

function configuredRecipient(value: string | undefined) {
  const text = value?.trim() || ACADEMY_INQUIRY_DEFAULT_RECIPIENT;
  return validEmail(text) ? text : "";
}

// Maps a Resend error to what the visitor may safely do next. Only the two
// DELIVERY_IN_PROGRESS / DELIVERY_UNCONFIRMED outcomes mean the email may
// already have been sent; the browser keeps its reference only for those.
function deliveryError(status: number, name: string) {
  if (status === 409 && name === "concurrent_idempotent_requests") {
    return new AcademyInquiryError("DELIVERY_IN_PROGRESS", 409);
  }
  // Same reference with a different body: this request was refused, and only a
  // new reference can send the current answers.
  if (status === 409 && name === "invalid_idempotent_request") {
    return new AcademyInquiryError("DELIVERY_FAILED", 502);
  }
  if (status === 401 || status === 403 || (status === 429 && /^(?:daily|monthly)_quota_exceeded$/.test(name))) {
    return new AcademyInquiryError("EMAIL_UNAVAILABLE", 503);
  }
  if (status === 409 || status >= 500) return new AcademyInquiryError("DELIVERY_UNCONFIRMED", 502);
  if (status >= 400) return new AcademyInquiryError("DELIVERY_FAILED", 502);
  return new AcademyInquiryError("DELIVERY_UNCONFIRMED", 502);
}

async function providerErrorName(response: Response) {
  try {
    const text = await response.text();
    const body = text.length <= 4096 ? JSON.parse(text) : null;
    return body && typeof body.name === "string" ? body.name : "";
  } catch {
    return "";
  }
}

export async function sendAcademyInquiry(inquiry: AcademyInquiry) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = configuredSender(process.env.ACADEMY_INQUIRY_FROM);
  const to = configuredRecipient(process.env.ACADEMY_INQUIRY_TO);
  if (!apiKey || !from || !to) {
    throw new AcademyInquiryError("EMAIL_UNAVAILABLE", 503);
  }

  const reference = inquiry.requestId.slice(0, 8);
  const body = JSON.stringify({
    from,
    to: [to],
    reply_to: inquiry.email,
    subject: academyInquirySubject(inquiry),
    text: academyInquiryText(inquiry),
  });
  let response: Response;
  try {
    // Resend replays the first result for the same key and an identical body
    // for 24 hours. That narrows duplicates but cannot rule them out, so this
    // request is never retried automatically.
    response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `academy-inquiry/${inquiry.requestId}`,
      },
      body,
    });
  } catch (error) {
    // A timeout or broken connection can happen after Resend accepted the email.
    console.warn("Academy inquiry delivery unconfirmed", {
      reference,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
    throw new AcademyInquiryError("DELIVERY_UNCONFIRMED", 502);
  }

  if (response.ok) {
    // Resend confirms acceptance with the new email's id, not inbox delivery.
    const id = await response.json().then(body => body?.id, () => "");
    if (typeof id === "string" && id) return;
    console.warn("Academy inquiry delivery unconfirmed", { reference, status: response.status, reason: "missing id" });
    throw new AcademyInquiryError("DELIVERY_UNCONFIRMED", 502);
  }
  // Log only the status and Resend's error name, never the answers.
  const name = await providerErrorName(response);
  console.warn("Academy inquiry not delivered", { reference, status: response.status, name: name || "unknown" });
  throw deliveryError(response.status, name);
}
