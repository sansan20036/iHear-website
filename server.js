const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "db.json");
const port = Number(process.env.PORT || 4173);
const adminPassword = process.env.ADMIN_PASSWORD || "ihear-admin-local";

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function now() {
  return new Date().toISOString();
}

function createSeedDb() {
  return {
    meta: {
      createdAt: now(),
      updatedAt: now(),
      note: "Local functional replica data. This is not copied from the original production database.",
    },
    settings: {
      adminEmails: ["ihearprogram@gmail.com"],
      integrations: {
        sendgrid: { enabled: false },
        twilio: { enabled: false },
        firebase: { enabled: false },
      },
    },
    sessions: [],
    tutors: [
      {
        id: 1,
        name: "Zoe Lu",
        email: "zoe.local@example.com",
        status: "active",
        role: "Founder & Co-President",
        showOnPublicPage: true,
        displayOrder: 1,
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: 2,
        name: "Howard M. Ren",
        email: "howard.local@example.com",
        status: "active",
        role: "Co-President",
        showOnPublicPage: true,
        displayOrder: 2,
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    tutees: [],
    enrollments: [],
    contacts: [],
    faqQuestions: [],
    teamMembers: [
      {
        id: 1,
        name: "Zoe Lu",
        primaryRole: "Founder & Co-President",
        category: "Leadership",
        displayOrder: 1,
        showFullProfile: true,
        showOnPublicPage: true,
        createdAt: now(),
        updatedAt: now(),
      },
      {
        id: 2,
        name: "Howard M. Ren",
        primaryRole: "Co-President",
        category: "Leadership",
        displayOrder: 2,
        showFullProfile: true,
        showOnPublicPage: true,
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    photos: [],
    donations: [],
    emailTasks: [],
    messageTasks: [],
    notifications: [],
    integrationEvents: [],
    auditLog: [],
  };
}

function ensureDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(createSeedDb(), null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeDb(db) {
  db.meta.updatedAt = now();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function updateDb(mutator) {
  const db = readDb();
  const result = mutator(db);
  writeDb(db);
  return result;
}

function nextId(items) {
  return items.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0) + 1;
}

function addAudit(db, action, payload = {}) {
  db.auditLog.push({
    id: nextId(db.auditLog),
    action,
    payload,
    createdAt: now(),
  });
}

function send(res, status, body, type = "text/plain; charset=utf-8", extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendJson(res, status, value, headers) {
  send(res, status, JSON.stringify(value), types[".json"], headers);
}

function sendError(res, status, message, code = "ERROR") {
  sendJson(res, status, { error: { code, message } });
}

function safeFilePath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const filePath = path.normalize(path.join(root, cleanPath));
  if (!filePath.startsWith(root)) return null;
  return filePath;
}

function resolveStaticFile(urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const candidates = [cleanPath];

  if (!path.extname(cleanPath)) {
    candidates.push(`${cleanPath}.html`);
    candidates.push(path.join(cleanPath, "index.html"));
  }

  for (const candidate of candidates) {
    const filePath = safeFilePath(candidate);
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return filePath;
    }
  }

  return null;
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1
          ? [part, ""]
          : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function isAdmin(req) {
  const headerPassword = req.headers["x-admin-password"];
  const cookies = parseCookies(req.headers.cookie);
  return headerPassword === adminPassword || cookies.ihear_admin === adminPassword;
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  sendError(res, 401, "Admin password required", "UNAUTHORIZED");
  return false;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const type = req.headers["content-type"] || "";
  if (type.includes("application/json") || raw.trim().startsWith("{") || raw.trim().startsWith("[")) {
    return JSON.parse(raw);
  }
  return { raw };
}

function decodeSuperJson(value) {
  if (value && typeof value === "object" && "json" in value) return value.json;
  return value;
}

function trpcSuccess(data) {
  return { result: { data: { json: data } } };
}

function trpcError(message, code = -32603) {
  return { error: { message, code } };
}

function normalizeSession(input = {}) {
  return {
    id: input.id,
    date: input.date || input.sessionDate || input.startDate || "",
    startTime: input.startTime || input.time || "",
    endTime: input.endTime || "",
    timezone: input.timezone || "Asia/Taipei",
    tutorName: input.tutorName || input.tutor || "",
    tutorEmail: input.tutorEmail || "",
    coTutorName: input.coTutorName || input.coTutor || "",
    tuteeName: input.tuteeName || input.tutee || "",
    tuteeEmail: input.tuteeEmail || "",
    zoomLink: input.zoomLink || "",
    notes: input.notes || "",
    status: input.status || "scheduled",
    lineReminderSent: Boolean(input.lineReminderSent),
    wechatReminderSent: Boolean(input.wechatReminderSent),
    createdAt: input.createdAt || now(),
    updatedAt: now(),
  };
}

function filterBySearch(items, input = {}, fields = ["name", "email", "studentEnglishName", "studentChineseName"]) {
  const search = (input.search || "").toString().toLowerCase();
  const status = input.status;
  return items.filter((item) => {
    if (status && item.status !== status) return false;
    if (!search) return true;
    return fields.some((field) => (item[field] || "").toString().toLowerCase().includes(search));
  });
}

function stats(items) {
  const active = items.filter((item) => item.status === "active").length;
  return { total: items.length, active };
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function recordsToCsv(records) {
  const keys = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return [keys.join(","), ...records.map((record) => keys.map((key) => csvEscape(record[key])).join(","))].join("\n");
}

function parseTrpcInput(url, body) {
  const batch = url.searchParams.get("batch") === "1";
  if (body && Object.keys(body).length > 0) return { batch, body };
  const input = url.searchParams.get("input");
  if (!input) return { batch, body: batch ? {} : undefined };
  return { batch, body: JSON.parse(input) };
}

function getProcedureInput(parsedInput, index) {
  if (parsedInput.batch) return decodeSuperJson(parsedInput.body?.[index] || {});
  return decodeSuperJson(parsedInput.body);
}

async function sendEmail(to, subject, text) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.SENDGRID_FROM_EMAIL;
  if (!apiKey || !from) {
    return updateDb((db) => {
      const event = {
        id: nextId(db.integrationEvents),
        provider: "sendgrid",
        mode: "mock",
        to,
        subject,
        text,
        createdAt: now(),
      };
      db.integrationEvents.push(event);
      return event;
    });
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
  });
  return { provider: "sendgrid", mode: "live", status: response.status };
}

async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    return updateDb((db) => {
      const event = {
        id: nextId(db.integrationEvents),
        provider: "twilio",
        mode: "mock",
        to,
        body,
        createdAt: now(),
      };
      db.integrationEvents.push(event);
      return event;
    });
  }

  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  return { provider: "twilio", mode: "live", status: response.status };
}

async function handleProcedure(name, input, req) {
  const db = readDb();
  const protectedProcedure =
    name.startsWith("admin.") ||
    name.startsWith("scheduling.") ||
    name.startsWith("schedulingAI.") ||
    name.startsWith("photo.") ||
    name.startsWith("emailValidation.") ||
    name.startsWith("tutee.") ||
    (name.startsWith("tutor.") && name !== "tutor.submitBio") ||
    (name.startsWith("team.") && !["team.verifyPassword", "team.getAll"].includes(name));

  if (protectedProcedure && !isAdmin(req)) {
    const error = new Error("Admin password required");
    error.code = "UNAUTHORIZED";
    throw error;
  }

  switch (name) {
    case "auth.me":
      return isAdmin(req) ? { id: "local-admin", role: "admin", email: "local-admin@ihear.local" } : null;
    case "auth.logout":
      return { ok: true };
    case "team.verifyPassword":
      return { valid: input?.password === adminPassword };
    case "contact.submit":
      return updateDb((store) => {
        const record = { id: nextId(store.contacts), ...input, status: "new", createdAt: now() };
        store.contacts.push(record);
        addAudit(store, "contact.submit", { id: record.id });
        return { success: true, message: "Message submitted successfully.", id: record.id };
      });
    case "contact.submitQuestion":
      return updateDb((store) => {
        const record = { id: nextId(store.faqQuestions), ...input, status: "pending", createdAt: now(), updatedAt: now() };
        store.faqQuestions.push(record);
        addAudit(store, "contact.submitQuestion", { id: record.id });
        return { success: true, message: "Question submitted successfully.", id: record.id };
      });
    case "enrollment.submitEnrollment":
      return updateDb((store) => {
        const record = { id: nextId(store.enrollments), ...input, status: "pending", createdAt: now(), updatedAt: now() };
        store.enrollments.push(record);
        addAudit(store, "enrollment.submitEnrollment", { id: record.id });
        return { success: true, message: "Application submitted successfully.", id: record.id };
      });
    case "donation.getDonationStatus":
      return { enabled: false, message: "Donation processing is not connected in the local replica.", donations: db.donations };
    case "public.getTeamTutors":
      return db.teamMembers.filter((member) => member.showOnPublicPage !== false).sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    case "team.getAll":
      return db.teamMembers.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    case "team.create":
      return updateDb((store) => {
        const record = { id: nextId(store.teamMembers), ...input, createdAt: now(), updatedAt: now() };
        store.teamMembers.push(record);
        return record;
      });
    case "team.update":
    case "team.bulkUpdate":
      return updateRecord("teamMembers", input);
    case "team.delete":
      return deleteRecord("teamMembers", input?.id);
    case "team.batchUpdateOrder":
      return updateOrder("teamMembers", input?.items || input || []);
    case "team.sortAlphabetically":
      return updateDb((store) => {
        store.teamMembers.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        store.teamMembers.forEach((member, index) => {
          member.displayOrder = index + 1;
          member.updatedAt = now();
        });
        return store.teamMembers;
      });
    case "team.importCSV":
    case "team.bulkUploadPhotos":
      return { success: true, message: "Imported into local replica mock.", count: 0 };
    case "admin.getTutors":
    case "tutor.getAll":
      return filterBySearch(db.tutors, input);
    case "admin.getTutorStats":
      return stats(db.tutors);
    case "admin.createTutor":
    case "tutor.create":
      return createRecord("tutors", input);
    case "admin.updateTutor":
    case "tutor.update":
      return updateRecord("tutors", input);
    case "admin.deleteTutor":
    case "tutor.delete":
      return deleteRecord("tutors", input?.id);
    case "admin.bulkImportTutors":
      return bulkCreate("tutors", input?.tutors || input?.items || []);
    case "admin.bulkToggleTutorVisibility":
      return { success: true };
    case "admin.reorderTutors":
      return updateOrder("tutors", input?.items || input || []);
    case "tutor.submitBio":
      return createRecord("contacts", { type: "tutor-bio", ...input, status: "new" });
    case "admin.getTutees":
    case "tutee.getAll":
      return filterBySearch(db.tutees, input);
    case "admin.getTuteeStats":
      return stats(db.tutees);
    case "admin.createTutee":
    case "tutee.create":
      return createRecord("tutees", input);
    case "admin.updateTutee":
    case "tutee.update":
      return updateRecord("tutees", input);
    case "admin.deleteTutee":
    case "tutee.delete":
      return deleteRecord("tutees", input?.id);
    case "admin.bulkImportTutees":
      return bulkCreate("tutees", input?.tutees || input?.items || []);
    case "tutor.merge":
    case "tutee.merge":
    case "tutor.mergeAllDuplicates":
    case "tutee.mergeAllDuplicates":
      return { success: true, message: "Merge completed in local mock.", merged: 0 };
    case "tutor.getSessionsForMergePreview":
    case "tutee.getSessionsForMergePreview":
      return [];
    case "admin.getEnrollments":
      return filterBySearch(db.enrollments, input, ["email", "studentEnglishName", "studentChineseName", "contactPersonName"]);
    case "admin.getEnrollmentStats":
      return {
        total: db.enrollments.length,
        pending: db.enrollments.filter((item) => item.status === "pending").length,
        accepted: db.enrollments.filter((item) => item.status === "accepted").length,
      };
    case "admin.exportEnrollmentsCSV":
      return recordsToCsv(filterBySearch(db.enrollments, input, ["email", "studentEnglishName", "studentChineseName", "contactPersonName"]));
    case "admin.getFaqQuestions":
      return db.faqQuestions.filter((item) => !input?.status || item.status === input.status);
    case "admin.getFaqStats":
      return {
        total: db.faqQuestions.length,
        pending: db.faqQuestions.filter((item) => item.status === "pending").length,
        responded: db.faqQuestions.filter((item) => item.status === "responded").length,
      };
    case "admin.respondToFaqQuestion":
      return updateRecord("faqQuestions", { id: input?.questionId || input?.id, response: input?.response, status: "responded", respondedBy: input?.respondedBy });
    case "admin.updateFaqQuestionStatus":
      return updateRecord("faqQuestions", { id: input?.questionId || input?.id, status: input?.status });
    case "admin.getAllPhotos":
    case "photo.list":
      return db.photos;
    case "admin.uploadTutorPhoto":
    case "photo.bulkUpload":
      return createRecord("photos", { ...input, status: "uploaded" });
    case "admin.deletePhoto":
    case "photo.delete":
      return deleteRecord("photos", input?.id);
    case "admin.bulkDeletePhotos":
      return bulkDelete("photos", input?.ids || []);
    case "photo.reorder":
      return updateOrder("photos", input?.items || input || []);
    case "admin.sendBioFormEmails":
      return { successful: 0, failed: 0, mode: "mock" };
    case "scheduling.getAllSessions":
    case "scheduling.getSessions":
    case "schedulingAI.getScheduledSessions":
      return db.sessions;
    case "scheduling.getAllContacts":
      return { tutors: db.tutors, tutees: db.tutees };
    case "scheduling.getAdminEmails":
      return db.settings.adminEmails;
    case "scheduling.saveAdminEmails":
      return updateDb((store) => {
        store.settings.adminEmails = input?.emails || input || [];
        return store.settings.adminEmails;
      });
    case "scheduling.updateSession":
      return updateRecord("sessions", normalizeSession(input));
    case "scheduling.updateSessionStatus":
    case "schedulingAI.updateSessionStatus":
      return updateRecord("sessions", { id: input?.sessionId || input?.id, status: input?.status });
    case "scheduling.deleteAllSessions":
      return updateDb((store) => {
        const count = store.sessions.length;
        store.sessions = [];
        return { success: true, deleted: count };
      });
    case "scheduling.importFromCSV":
    case "scheduling.importFromExcelV3":
    case "scheduling.importFromSheets":
    case "scheduling.uploadContactsExcel":
      return importSessions(input);
    case "scheduling.syncSessionEmails":
      return { success: true, updated: 0 };
    case "scheduling.markLineReminderSent":
      return updateRecord("sessions", { id: input?.sessionId || input?.id, lineReminderSent: true });
    case "scheduling.markWechatReminderSent":
      return updateRecord("sessions", { id: input?.sessionId || input?.id, wechatReminderSent: true });
    case "scheduling.generateCalendarEventsText":
    case "scheduling.generateCalendarInvites":
      return generateCalendarEvents(input);
    case "scheduling.sendCalendarEmails":
      return { successful: 0, failed: 0, mode: "mock", sessionIds: input?.sessionIds || [] };
    case "scheduling.generateTutorSessionLists":
      return { lists: [] };
    case "schedulingAI.parseSessionText":
    case "schedulingAI.parseBulkSessions":
      return { sessions: [], message: "Parser mock ready. Add NLP rules or provider credentials for live extraction." };
    case "schedulingAI.parseContactList":
      return { contacts: [], message: "Contact parser mock ready." };
    case "schedulingAI.lookupTutorEmails":
      return lookupEmails(db.tutors, input?.names || input || []);
    case "schedulingAI.lookupTuteeEmails":
      return lookupEmails(db.tutees, input?.names || input || []);
    case "schedulingAI.generateSessionICS":
    case "schedulingAI.generateBulkICS":
    case "schedulingAI.generateAllSessionsICS":
      return { filename: "ihear-sessions.ics", content: "BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR" };
    case "schedulingAI.saveEmailTask":
      return createRecord("emailTasks", input);
    case "schedulingAI.saveMessageTask":
      return createRecord("messageTasks", input);
    case "schedulingAI.loadEmailTasks":
      return db.emailTasks;
    case "schedulingAI.loadMessageTasks":
      return db.messageTasks;
    case "emailValidation.checkDuplicates":
    case "emailValidation.getAllDuplicates":
      return [];
    case "resources.downloadResourcePDF":
      return { success: true, url: null, message: "PDF generation is mocked in the local replica." };
    case "tutorialVideos.list":
    case "videos.getAll":
      return [];
    default:
      return { success: true, procedure: name, data: null, message: "Local fallback procedure." };
  }
}

function createRecord(collection, input = {}) {
  return updateDb((db) => {
    const record = { ...input, id: input.id ?? nextId(db[collection]), createdAt: now(), updatedAt: now() };
    db[collection].push(record);
    addAudit(db, `${collection}.create`, { id: record.id });
    return record;
  });
}

function updateRecord(collection, input = {}) {
  return updateDb((db) => {
    const id = Number(input.id);
    const index = db[collection].findIndex((item) => Number(item.id) === id);
    if (index === -1) {
      const record = { id: id || nextId(db[collection]), ...input, createdAt: now(), updatedAt: now() };
      db[collection].push(record);
      return record;
    }
    db[collection][index] = { ...db[collection][index], ...input, updatedAt: now() };
    addAudit(db, `${collection}.update`, { id: db[collection][index].id });
    return db[collection][index];
  });
}

function deleteRecord(collection, id) {
  return updateDb((db) => {
    const before = db[collection].length;
    db[collection] = db[collection].filter((item) => Number(item.id) !== Number(id));
    addAudit(db, `${collection}.delete`, { id });
    return { success: true, deleted: before - db[collection].length };
  });
}

function bulkCreate(collection, records = []) {
  return updateDb((db) => {
    const created = records.map((item) => {
      const record = { id: nextId(db[collection]), ...item, createdAt: now(), updatedAt: now() };
      db[collection].push(record);
      return record;
    });
    return { success: true, count: created.length, items: created };
  });
}

function bulkDelete(collection, ids = []) {
  return updateDb((db) => {
    const set = new Set(ids.map(Number));
    const before = db[collection].length;
    db[collection] = db[collection].filter((item) => !set.has(Number(item.id)));
    return { success: true, deleted: before - db[collection].length };
  });
}

function updateOrder(collection, items = []) {
  return updateDb((db) => {
    items.forEach((item, index) => {
      const id = Number(item.id || item);
      const record = db[collection].find((entry) => Number(entry.id) === id);
      if (record) {
        record.displayOrder = item.displayOrder || index + 1;
        record.updatedAt = now();
      }
    });
    return db[collection];
  });
}

function importSessions(input = {}) {
  const sessions = input?.sessions || [];
  return updateDb((db) => {
    const created = sessions.map((session) => {
      const record = normalizeSession({ id: nextId(db.sessions), ...session });
      db.sessions.push(record);
      return record;
    });
    return { success: true, imported: created.length, sessions: created };
  });
}

function generateCalendarEvents(input = {}) {
  const db = readDb();
  const ids = new Set((input.sessionIds || []).map(Number));
  const sessions = ids.size ? db.sessions.filter((session) => ids.has(Number(session.id))) : db.sessions;
  return {
    events: sessions.map((session) => ({
      sessionId: session.id,
      title: `iHear Tutoring Session - ${session.tuteeName || "Student"}`,
      description: [input.customMessage, session.notes, session.zoomLink].filter(Boolean).join("\n\n"),
      attendees: [session.tutorEmail, session.tuteeEmail, ...(input.adminEmails || [])].filter(Boolean),
      startTimeET: session.date && session.startTime ? `${session.date}T${session.startTime}:00` : now(),
      endTimeET: session.date && session.endTime ? `${session.date}T${session.endTime}:00` : now(),
    })),
  };
}

function lookupEmails(records, names = []) {
  const list = Array.isArray(names) ? names : [names];
  return list.map((name) => {
    const record = records.find((item) => String(item.name || item.studentEnglishName || "").toLowerCase() === String(name).toLowerCase());
    return { name, email: record?.email || record?.studentEmail || null, found: Boolean(record) };
  });
}

async function handleTrpc(req, res, url) {
  const route = decodeURIComponent(url.pathname.replace(/^\/api\/trpc\/?/, ""));
  const procedures = route ? route.split(",") : ["unknown"];
  const body = req.method === "GET" ? {} : await readBody(req);
  const parsedInput = parseTrpcInput(url, body);

  try {
    const results = await Promise.all(
      procedures.map(async (procedure, index) => {
        const input = getProcedureInput(parsedInput, String(index));
        const data = await handleProcedure(procedure, input, req);
        return trpcSuccess(data);
      }),
    );
    sendJson(res, 200, parsedInput.batch || procedures.length > 1 ? results : results[0]);
  } catch (error) {
    const status = error.code === "UNAUTHORIZED" ? 401 : 500;
    sendJson(res, status, trpcError(error.message));
  }
}

async function handleRestApi(req, res, url) {
  const method = req.method;
  const pathName = url.pathname;
  const body = method === "GET" ? {} : await readBody(req);

  if (pathName === "/api/health") {
    sendJson(res, 200, { ok: true, mode: "local-functional-replica", time: now() });
    return true;
  }

  if (pathName === "/api/admin/login" && method === "POST") {
    if (body.password !== adminPassword) {
      sendError(res, 401, "Invalid admin password", "INVALID_PASSWORD");
      return true;
    }
    sendJson(
      res,
      200,
      { ok: true, user: { id: "local-admin", role: "admin" } },
      { "Set-Cookie": `ihear_admin=${encodeURIComponent(adminPassword)}; Path=/; HttpOnly; SameSite=Lax` },
    );
    return true;
  }

  if (pathName === "/api/admin/me") {
    sendJson(res, 200, { authenticated: isAdmin(req), user: isAdmin(req) ? { id: "local-admin", role: "admin" } : null });
    return true;
  }

  if (pathName === "/api/integrations/status") {
    sendJson(res, 200, {
      sendgrid: Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL),
      twilio: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER),
      firebase: Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY),
      mode: "missing credentials use mock event logging",
    });
    return true;
  }

  if (pathName === "/api/integrations/test-email" && method === "POST") {
    const result = await sendEmail(body.to, body.subject || "iHear test email", body.text || "Test email from local replica.");
    sendJson(res, 200, result);
    return true;
  }

  if (pathName === "/api/integrations/test-sms" && method === "POST") {
    const result = await sendSms(body.to, body.body || "Test SMS from local iHear replica.");
    sendJson(res, 200, result);
    return true;
  }

  if (pathName.startsWith("/api/forms/") && method === "POST") {
    const type = pathName.replace("/api/forms/", "");
    const collection = type === "enrollment" ? "enrollments" : type === "faq-question" ? "faqQuestions" : "contacts";
    const record = createRecord(collection, { type, ...body, status: "new" });
    sendJson(res, 201, { success: true, record });
    return true;
  }

  const collectionRoutes = {
    "/api/sessions": "sessions",
    "/api/tutors": "tutors",
    "/api/tutees": "tutees",
    "/api/enrollments": "enrollments",
    "/api/faq-questions": "faqQuestions",
    "/api/contacts": "contacts",
    "/api/team": "teamMembers",
  };
  const collection = collectionRoutes[pathName];
  if (collection) {
    if ((method !== "GET" || collection !== "teamMembers") && !requireAdmin(req, res)) return true;
    if (method === "GET") {
      sendJson(res, 200, readDb()[collection]);
      return true;
    }
    if (method === "POST") {
      const record = collection === "sessions" ? createRecord(collection, normalizeSession(body)) : createRecord(collection, body);
      sendJson(res, 201, record);
      return true;
    }
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const urlPath = url.pathname;

    if (urlPath.startsWith("/api/trpc")) {
      await handleTrpc(req, res, url);
      return;
    }

    if (urlPath.startsWith("/api/")) {
      const handled = await handleRestApi(req, res, url);
      if (!handled) sendError(res, 404, "API route not found", "NOT_FOUND");
      return;
    }

    const filePath = resolveStaticFile(urlPath);
    if (filePath) {
      const ext = path.extname(filePath).toLowerCase();
      send(res, 200, fs.readFileSync(filePath), types[ext] || "application/octet-stream");
      return;
    }

    send(res, 200, fs.readFileSync(path.join(root, "index.html")), types[".html"]);
  } catch (error) {
    console.error(error);
    sendError(res, 500, error.message || "Internal server error");
  }
});

ensureDb();

server.listen(port, () => {
  console.log(`iHear functional replica running at http://localhost:${port}`);
  console.log(`Local admin password: ${adminPassword}`);
});
