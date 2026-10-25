// Test-only preload for a local `next start` (NODE_OPTIONS=--import). It answers
// Resend API calls inside the server process, so no request leaves this machine,
// and follows Resend's documented idempotency rules: within a run, the same key
// with an identical body replays the first result; the same key with a different
// body, or while the first request is still in progress, is a 409. The test
// queues one behavior per Resend request in FAKE_RESEND_CONTROL and reads every
// event from the JSON-lines FAKE_RESEND_LOG. Any other non-local request is refused.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const logFile = process.env.FAKE_RESEND_LOG;
const controlFile = process.env.FAKE_RESEND_CONTROL;
if (!logFile || !controlFile) throw new Error("fake-resend needs FAKE_RESEND_LOG and FAKE_RESEND_CONTROL");

const realFetch = globalThis.fetch;
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function events() {
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function record(event) {
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

// "accept" (the default), "accept-then-hang", or { status, name } for an error.
function nextBehavior() {
  const queue = JSON.parse(readFileSync(controlFile, "utf8") || "[]");
  const behavior = queue.shift() ?? "accept";
  writeFileSync(controlFile, JSON.stringify(queue));
  return behavior;
}

function resendError(status, name) {
  return Response.json({ statusCode: status, name, message: "fake-resend" }, { status });
}

globalThis.fetch = async function fakeResendFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (localHosts.has(url.hostname)) return realFetch(input, init);
  const request = new Request(input, init);
  if (url.origin !== "https://api.resend.com" || url.pathname !== "/emails" || request.method !== "POST") {
    record({ type: "blocked", origin: url.origin });
    throw new TypeError(`fake-resend refused a request to ${url.origin}`);
  }

  const key = request.headers.get("idempotency-key") || "";
  const text = await request.text();
  const digest = createHash("sha256").update(text).digest("hex");
  const history = events().filter(event => event.key === key);
  const inFlight = history.filter(event => event.type === "inflight").length > history.filter(event => event.type === "settled").length;
  if (key && inFlight) {
    record({ type: "concurrent", key });
    return resendError(409, "concurrent_idempotent_requests");
  }

  const behavior = nextBehavior();
  record({ type: "request", key, authorization: request.headers.get("authorization"), body: JSON.parse(text), behavior });
  if (typeof behavior === "object") return resendError(behavior.status, behavior.name);

  const earlier = history.find(event => event.type === "accepted");
  if (earlier && earlier.digest !== digest) return resendError(409, "invalid_idempotent_request");
  if (earlier) {
    record({ type: "replayed", key, id: earlier.id });
    return Response.json({ id: earlier.id });
  }

  const id = randomUUID();
  record({ type: "accepted", key, digest, id });
  if (behavior !== "accept-then-hang") return Response.json({ id });

  // Accepted, but the answer never comes back: only the caller's timeout ends it.
  // Listen on the caller's own signal: the copy on `request` follows it only
  // through a weak reference and can stop following once collected.
  record({ type: "inflight", key });
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return new Promise((_, reject) => {
    const settle = () => {
      record({ type: "settled", key });
      reject(signal.reason);
    };
    if (!signal) return;
    if (signal.aborted) settle();
    else signal.addEventListener("abort", settle, { once: true });
  });
};

record({ type: "ready", pid: process.pid });
