(function () {
  "use strict";

  const VALID_SCOPES = new Set(["content", "impact", "team"]);
  const CHANNEL_NAME = "ihear-content-updates";
  const STORAGE_KEY = "ihear-content-update";
  const NORMAL_INTERVAL = 10000;
  const BACKOFFS = [15000, 30000, 60000];
  const handlers = new Map();
  const revisions = new Map();
  const seenMessages = new Set();
  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let timer = 0;
  let inFlight = null;
  let lastCheckStartedAt = 0;
  let backoffIndex = 0;
  let channel = null;

  function schedule(delay) {
    window.clearTimeout(timer);
    if (document.hidden || !handlers.size) return;
    timer = window.setTimeout(() => checkNow(), delay);
  }

  function rememberMessage(id) {
    if (!id || seenMessages.has(id)) return false;
    seenMessages.add(id);
    if (seenMessages.size > 100) seenMessages.delete(seenMessages.values().next().value);
    return true;
  }

  async function refreshHandler(scope, record, revision, external) {
    if (record.handler.isDirty && record.handler.isDirty()) {
      record.pending = { revision, external };
      if (!record.blockedNotified && record.handler.onBlocked) {
        record.blockedNotified = true;
        record.handler.onBlocked();
      }
      return;
    }

    try {
      await record.handler.refresh({ revision, external });
      record.pending = null;
      record.blockedNotified = false;
    } catch {
      record.pending = { revision, external };
    }
  }

  async function refreshScope(scope, revision, external) {
    const records = handlers.get(scope);
    if (!records) return;
    await Promise.all(
      Array.from(records).map((record) => refreshHandler(scope, record, revision, external)),
    );
  }

  async function flushPending() {
    const work = [];
    handlers.forEach((records, scope) => {
      records.forEach((record) => {
        if (record.pending) {
          work.push(
            refreshHandler(
              scope,
              record,
              record.pending.revision || revisions.get(scope) || "",
              true,
            ),
          );
        }
      });
    });
    await Promise.all(work);
  }

  async function fetchRevisions() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/api/live-revisions", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("revision request failed");
      const data = await response.json();
      if (!data || data.version !== 1 || !data.revisions) throw new Error("invalid revision response");
      return data.revisions;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function runCheck(force) {
    if (document.hidden && !force) return;
    lastCheckStartedAt = Date.now();
    try {
      const latest = await fetchRevisions();
      const refreshes = [];
      VALID_SCOPES.forEach((scope) => {
        const next = latest[scope] && String(latest[scope].revision || "");
        if (!next) return;
        const previous = revisions.get(scope);
        revisions.set(scope, next);
        if (previous && previous !== next) refreshes.push(refreshScope(scope, next, true));
      });
      await Promise.all(refreshes);
      await flushPending();
      backoffIndex = 0;
      schedule(NORMAL_INTERVAL);
    } catch {
      const delay = BACKOFFS[Math.min(backoffIndex, BACKOFFS.length - 1)];
      backoffIndex = Math.min(backoffIndex + 1, BACKOFFS.length - 1);
      schedule(delay);
    }
  }

  function checkNow(options) {
    const force = Boolean(options && options.force);
    if (inFlight) return inFlight;
    if (!force && Date.now() - lastCheckStartedAt < 1000) return Promise.resolve();
    inFlight = runCheck(force).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function receive(message) {
    if (!message || message.clientId === clientId || !VALID_SCOPES.has(message.scope)) return;
    if (!rememberMessage(message.id)) return;
    const revision = String(message.revision || "");
    if (revision) revisions.set(message.scope, revision);
    refreshScope(message.scope, revision, true);
  }

  function announce(scope, revision) {
    if (!VALID_SCOPES.has(scope)) return;
    const revisionValue = String((revision && revision.revision) || revision || "");
    if (revisionValue) revisions.set(scope, revisionValue);
    const message = {
      id: `${clientId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      clientId,
      scope,
      revision: revisionValue,
      timestamp: Date.now(),
    };
    rememberMessage(message.id);
    refreshScope(scope, revisionValue, false);
    if (channel) channel.postMessage(message);
    else {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Local refresh still succeeds when storage is unavailable.
      }
    }
  }

  function register(scope, handler) {
    if (!VALID_SCOPES.has(scope) || !handler || typeof handler.refresh !== "function") {
      throw new Error("Invalid live content handler");
    }
    const record = { handler, pending: null, blockedNotified: false };
    if (!handlers.has(scope)) handlers.set(scope, new Set());
    handlers.get(scope).add(record);
    schedule(0);
    return function unregister() {
      const records = handlers.get(scope);
      if (!records) return;
      records.delete(record);
      if (!records.size) handlers.delete(scope);
    };
  }

  if ("BroadcastChannel" in window) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", (event) => receive(event.data));
  } else {
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        receive(JSON.parse(event.newValue));
      } catch {
        // Ignore malformed cross-tab messages.
      }
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) window.clearTimeout(timer);
    else {
      backoffIndex = 0;
      checkNow({ force: true });
    }
  });
  window.addEventListener("focus", () => checkNow({ force: true }));
  window.addEventListener("online", () => {
    backoffIndex = 0;
    checkNow({ force: true });
  });

  window.iHearLiveContent = { register, announce, checkNow };
})();
