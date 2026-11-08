// In-memory stand-ins for the classroom database, Google Drive and Zoom's recording download,
// for synthetic tests only. The store keeps the guarantees the design relies on from
// PostgreSQL: a transaction is all or nothing, event keys and job ids are unique, a job is
// claimed under a lease, and the writes that move or finish a job only succeed with the current
// lease number (fencing). The Drive fake knows appProperties, a storage quota and chunked
// resumable uploads. All of them can inject faults, and killSwitch stands in for a serverless
// function being stopped mid-way.
// Passing here shows our logic holds under these guarantees; it does not test PostgreSQL,
// Google Drive or Zoom themselves.
import { FAILURE, FilingError } from '../classroom/recording-filing.mjs';

export function createClassroomStore({ lessons = [] } = {}) {
  let state = { events: new Map(), jobs: new Map(), files: new Map() };
  const lessonById = new Map(lessons.map(lesson => [lesson.id, lesson]));
  const faults = { failTransactions: 0, delayMs: 0 };
  const counters = { transactions: 0, failedTransactions: 0, transfers: 0 };

  const readers = current => ({
    lesson: id => lessonById.get(id) ?? null,
    fileRecord: id => (current.files.has(id) ? { ...current.files.get(id) } : null),
    fileRecordsForLesson: id => [...current.files.values()].filter(record => record.lessonId === id).map(record => ({ ...record })),
    eligibility: id => [...current.events.values()]
      .filter(event => event.lessonId === id && event.type === 'server.recording_eligibility')
      .sort((a, b) => a.occurredAt - b.occurredAt).pop() ?? null,
    withdrawalAt: id => earliestAt(current, event => event.lessonId === id && ['server.consent_withdrawn', 'server.emergency_stop'].includes(event.type)),
    unknownJoinAt: id => {
      const roster = new Set((lessonById.get(id)?.participants ?? []).map(entry => entry.id));
      return earliestAt(current, event => event.lessonId === id
        && (event.type === 'session.user_joined' || event.type === 'host.user_added') && !roster.has(event.participantId));
    },
  });

  const writer = current => ({
    ...readers(current),
    insertEvent(event) {
      if (current.events.has(event.key)) return false;
      current.events.set(event.key, structuredClone(event));
      return true;
    },
    // For values where only the newest matters (the tutor's heartbeat): replace when newer.
    keepLatest(event) {
      const kept = current.events.get(event.key);
      if (kept && kept.occurredAt >= event.occurredAt) return false;
      current.events.set(event.key, structuredClone(event));
      return true;
    },
    insertJob(job) {
      if (current.jobs.has(job.id)) return false;
      current.jobs.set(job.id, newJob(job));
      return true;
    },
    insertFileRecord(record) {
      if (current.files.has(record.providerFileId)) return false;
      current.files.set(record.providerFileId, { ...record });
      return true;
    },
    updateFileRecord(id, changes) {
      Object.assign(current.files.get(id), changes);
    },
  });

  const holds = (jobId, leaseVersion) => {
    const job = state.jobs.get(jobId);
    return !!job && job.status === 'running' && job.leaseVersion === leaseVersion;
  };
  const insertEvents = (events = []) => {
    for (const event of events) if (!state.events.has(event.key)) state.events.set(event.key, structuredClone(event));
  };
  // Transactions run one after another, as row locks would make them, so an asynchronous
  // callback never sees another transaction's half-finished draft.
  let queue = Promise.resolve();

  return {
    faults,
    counters,
    transaction(fn) {
      const run = queue.then(async () => {
        counters.transactions += 1;
        if (faults.delayMs) await new Promise(resolve => { setTimeout(resolve, faults.delayMs); });
        if (faults.failTransactions > 0) {
          faults.failTransactions -= 1;
          counters.failedTransactions += 1;
          throw new Error('synthetic database failure');
        }
        const draft = structuredClone(state);
        const result = await fn(writer(draft));
        state = draft;
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    // Claim one job that is due, or whose previous lease ran out. Taking the lease bumps the
    // lease number, so the previous holder's later writes are refused.
    claimJob({ workerId, now, leaseMs }) {
      const job = [...state.jobs.values()]
        .filter(entry => (entry.status === 'pending' && entry.availableAt <= now) || (entry.status === 'running' && entry.leaseUntil <= now))
        .sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id))[0];
      if (!job) return null;
      Object.assign(job, { status: 'running', leaseOwner: workerId, leaseUntil: now + leaseMs, leaseVersion: job.leaseVersion + 1, attempts: job.attempts + 1 });
      return { job: { ...job }, leaseVersion: job.leaseVersion };
    },
    // A failed attempt: retried after a backoff (never before Retry-After), or given up.
    failJob({ jobId, leaseVersion, now, error, maxAttempts, retryAfterMs = 0, giveUp = {} }) {
      if (!holds(jobId, leaseVersion)) return false;
      const job = state.jobs.get(jobId);
      job.error = error;
      job.leaseOwner = null;
      if (job.attempts >= maxAttempts) {
        job.status = 'dead';
        if (giveUp.fileChanges && state.files.has(job.providerFileId)) Object.assign(state.files.get(job.providerFileId), giveUp.fileChanges);
        insertEvents(giveUp.events);
      } else {
        job.status = 'pending';
        job.availableAt = now + Math.max(retryAfterMs, Math.min(30 * 60_000, 30_000 * 2 ** (job.attempts - 1)));
      }
      return true;
    },
    // Puts a job back without counting the attempt: to carry on in the next call (CONTINUE) or
    // to look again later while it is blocked.
    rescheduleJob({ jobId, leaseVersion, availableAt, refundAttempt = false, blockedReason = null, error = null, events = [] }) {
      if (!holds(jobId, leaseVersion)) return false;
      const job = state.jobs.get(jobId);
      Object.assign(job, { status: 'pending', leaseOwner: null, availableAt, blockedReason, error, attempts: refundAttempt ? Math.max(0, job.attempts - 1) : job.attempts });
      insertEvents(events);
      return true;
    },
    completeJob({ jobId, leaseVersion }) {
      if (!holds(jobId, leaseVersion)) return false;
      Object.assign(state.jobs.get(jobId), { status: 'done', leaseOwner: null });
      return true;
    },
    // Progress through the upload session, saved after every chunk. It renews the lease, clears
    // a block the job had (getting here means the block is over) and, when bytes moved, starts
    // the attempt count again.
    recordTransfer({ jobId, leaseVersion, providerFileId, uri, uploadedBytes, now, leaseMs, events = [] }) {
      if (!holds(jobId, leaseVersion)) return false;
      const file = state.files.get(providerFileId);
      const job = state.jobs.get(jobId);
      if (uploadedBytes > (file.uploadedBytes ?? 0)) job.attempts = 0;
      Object.assign(file, { uploadSessionUri: uri, uploadedBytes });
      Object.assign(job, { leaseUntil: now + leaseMs, blockedReason: null });
      insertEvents(events);
      counters.transfers += 1;
      return true;
    },
    // Fenced and all or nothing. A record that is already final only gets its job closed.
    finishFiling({ jobId, leaseVersion, providerFileId, changes, events = [], jobs = [] }) {
      if (!holds(jobId, leaseVersion)) return false;
      const record = state.files.get(providerFileId);
      const job = state.jobs.get(jobId);
      if (!['STORED', 'QUARANTINED', 'HOLD', 'FAILED'].includes(record.status)) {
        Object.assign(record, changes);
        insertEvents(events);
        for (const entry of jobs) if (!state.jobs.has(entry.id)) state.jobs.set(entry.id, newJob(entry));
      }
      Object.assign(job, { status: 'done', leaseOwner: null });
      return true;
    },
    // Reads outside a transaction always see the latest committed state.
    fileRecord: id => readers(state).fileRecord(id),
    fileRecords: () => [...state.files.values()].map(record => ({ ...record })),
    lesson: id => lessonById.get(id) ?? null,
    withdrawalAt: id => readers(state).withdrawalAt(id),
    unknownJoinAt: id => readers(state).unknownJoinAt(id),
    events: () => [...state.events.values()].map(event => ({ ...event })),
    eventsFor: id => [...state.events.values()].filter(event => event.lessonId === id).map(event => ({ ...event })),
    jobs: () => [...state.jobs.values()].map(job => ({ ...job })),
  };
}

function earliestAt(current, test) {
  const times = [...current.events.values()].filter(test).map(event => event.occurredAt);
  return times.length ? Math.min(...times) : null;
}

function newJob(job) {
  return { status: 'pending', attempts: 0, leaseVersion: 0, leaseOwner: null, leaseUntil: 0, availableAt: 0, blockedReason: null, ...job };
}

// A clock the fakes move forward as bytes move, so time budgets can be tested without waiting.
export function createClock(start) {
  let now = start;
  return { now: () => now, advance: ms => { now += ms; }, set: at => { now = at; } };
}

// Google Drive as the filing logic uses it: folders, appProperties, a storage quota, and
// resumable upload sessions that take a file in chunks and say how much they hold. Like Drive,
// a chunk that does not start where the session stands writes nothing and the answer says where
// it stands. Faults: planned failures for named operations (failNext), a crash after some good
// chunks, a crash right after the last chunk created the file, a status check reporting the
// session gone, a chunk held at a gate, Drive keeping only part of a chunk, other files filling
// the Drive, and search lagging behind new files.
export function createDrive({ quotaLimit = null, clock = null, msPerByte = 0 } = {}) {
  const files = new Map();
  const folders = new Map();
  const sessions = new Map();
  let ids = 0;
  let created = 0;
  const faults = { failures: [], crashAfterChunks: null, crashAfterComplete: 0, reportGoneOnce: 0, holdUpload: null, keepPartialOnce: 0, otherUsage: 0, searchLagging: false, hiddenFromSearch: new Set() };
  const counters = { sessionsStarted: 0, uploadsFinished: 0, chunks: 0, bytesUploaded: 0 };
  const usage = () => faults.otherUsage + [...files.values()].filter(file => !file.trashed).reduce((sum, file) => sum + file.size, 0);
  const planned = op => {
    const index = faults.failures.findIndex(entry => entry.op === op);
    if (index < 0) return;
    const [entry] = faults.failures.splice(index, 1);
    throw new FilingError(entry.code, `synthetic Drive ${op} failure`, { retryAfterMs: entry.retryAfterMs });
  };
  const createFile = session => {
    const id = `drive-file-${++ids}`;
    files.set(id, {
      id,
      name: session.meta.name,
      parentId: session.meta.parentId,
      appProperties: { ...session.meta.appProperties },
      size: session.received,
      md5: null,
      createdTime: ++created,
      trashed: false,
      content: Buffer.concat(session.chunks),
    });
    counters.uploadsFinished += 1;
    // While search is lagging, a new file is found by its id but not yet by a search.
    if (faults.searchLagging) faults.hiddenFromSearch.add(id);
    return id;
  };
  const view = ({ content: _content, ...file }) => file;
  return {
    faults,
    counters,
    failNext(op, code, { retryAfterMs = 0, times = 1 } = {}) {
      for (let i = 0; i < times; i++) faults.failures.push({ op, code, retryAfterMs });
    },
    setQuotaLimit(limit) {
      quotaLimit = limit;
    },
    ensureFolder(parentId, name) {
      planned('ensureFolder');
      const key = `${parentId}/${name}`;
      if (!folders.has(key)) folders.set(key, `folder-${++ids}`);
      return folders.get(key);
    },
    folderName(id) {
      return [...folders.entries()].find(([, value]) => value === id)?.[0].split('/').slice(1).join('/') ?? null;
    },
    // The folder's names from below the root down to it, joined like the overview shows them.
    folderPath(id) {
      const names = [];
      for (let current = id; ;) {
        const entry = [...folders.entries()].find(([, value]) => value === current);
        if (!entry) break;
        const cut = entry[0].indexOf('/');
        names.unshift(entry[0].slice(cut + 1));
        current = entry[0].slice(0, cut);
      }
      return names.join(' / ');
    },
    listNames(folderId) {
      return [...files.values()].filter(file => !file.trashed && file.parentId === folderId).map(file => file.name);
    },
    findByAppProperty(key, value) {
      planned('findByAppProperty');
      return [...files.values()].filter(file => !file.trashed && !faults.hiddenFromSearch.has(file.id) && file.appProperties[key] === value).map(view);
    },
    getFile(id) {
      planned('getFile');
      return files.has(id) ? view(files.get(id)) : null;
    },
    quota() {
      planned('quota');
      return { limit: quotaLimit, usage: usage() };
    },
    startUpload(meta) {
      planned('startUpload');
      const uri = `upload://session-${++ids}`;
      sessions.set(uri, { meta, chunks: [], received: 0, fileId: null, gone: false });
      counters.sessionsStarted += 1;
      return uri;
    },
    uploadStatus(uri) {
      planned('uploadStatus');
      const session = sessions.get(uri);
      if (!session || session.gone) return { state: 'gone' };
      if (faults.reportGoneOnce > 0) {
        faults.reportGoneOnce -= 1;
        return { state: 'gone' };
      }
      return session.fileId ? { state: 'complete', fileId: session.fileId } : { state: 'active', received: session.received };
    },
    // holdUpload = { gate, reached }: the next chunk calls reached() and then waits for gate.
    async uploadChunk(uri, { offset, bytes, total }) {
      const session = sessions.get(uri);
      if (!session || session.gone) throw new FilingError(FAILURE.SESSION_GONE, 'upload session not found');
      if (faults.holdUpload) {
        const hold = faults.holdUpload;
        faults.holdUpload = null;
        hold.reached?.();
        await hold.gate;
      }
      // As Drive's upload guide says, a 4xx on a session (a full Drive, a rate limit...) ends it:
      // the upload has to start again in a new session. A 5xx leaves it to be resumed.
      const spent = error => {
        if (error.code !== FAILURE.TRANSIENT) {
          error.restartSession = true;
          session.gone = true;
        }
        return error;
      };
      try {
        planned('uploadChunk');
      } catch (error) {
        throw spent(error);
      }
      if (faults.crashAfterChunks === 0) {
        faults.crashAfterChunks = null;
        throw new Error('synthetic crash during upload');
      }
      if (session.fileId) return { received: session.received, fileId: session.fileId };
      if (offset !== session.received) return { received: session.received, fileId: null };
      if (quotaLimit != null && usage() + session.received + bytes.length > quotaLimit) throw spent(new FilingError(FAILURE.DRIVE_QUOTA, 'synthetic storageQuotaExceeded'));
      let kept = bytes;
      if (faults.keepPartialOnce > 0 && bytes.length > 1) {
        faults.keepPartialOnce -= 1;
        kept = bytes.subarray(0, Math.floor(bytes.length / 2));
      }
      session.chunks.push(Buffer.from(kept));
      session.received += kept.length;
      counters.chunks += 1;
      counters.bytesUploaded += kept.length;
      clock?.advance(kept.length * msPerByte);
      if (faults.crashAfterChunks != null) faults.crashAfterChunks -= 1;
      if (session.received < total) return { received: session.received, fileId: null };
      session.fileId = createFile(session);
      if (faults.crashAfterComplete > 0) {
        faults.crashAfterComplete -= 1;
        throw new Error('synthetic crash after upload');
      }
      return { received: session.received, fileId: session.fileId };
    },
    // Drive drops an unfinished session after about a week.
    expireSessions() {
      for (const session of sessions.values()) if (!session.fileId) session.gone = true;
    },
    trash(id) {
      files.get(id).trashed = true;
    },
    // Stands in for an upload made some other way, for example by a worker that lost track of it.
    addFile({ name, parentId, appProperties, size }) {
      const id = `drive-file-${++ids}`;
      files.set(id, { id, name, parentId, appProperties: { ...appProperties }, size, md5: null, createdTime: ++created, trashed: false, content: Buffer.alloc(size, 7) });
      return id;
    },
    contentOf(id) {
      return files.get(id).content;
    },
    activeFiles() {
      return [...files.values()].filter(file => !file.trashed).map(view);
    },
    trashedFiles() {
      return [...files.values()].filter(file => file.trashed).map(view);
    },
  };
}

// The bytes Zoom would serve for a file: a fixed pattern per file id, so a test can check that
// every byte that reached Drive is right and in the right place.
export function syntheticContent(providerFileId, start, end) {
  let seed = 0;
  for (const char of String(providerFileId)) seed = (seed * 31 + char.charCodeAt(0)) & 0xff;
  const bytes = Buffer.alloc(end - start);
  for (let i = start; i < end; i++) bytes[i - start] = (seed + i * 7 + (i >> 8)) & 0xff;
  return bytes;
}

// Zoom's recording download as the filing logic uses it: byte ranges of a file. Faults: planned
// failures, files Zoom no longer has, a short read; every byte read moves the clock.
export function createVendor({ clock = null, msPerByte = 0 } = {}) {
  const faults = { failures: [], gone: new Set(), shortReadOnce: 0 };
  const counters = { downloads: 0, bytesRead: 0 };
  return {
    faults,
    counters,
    failNext(code, { retryAfterMs = 0, times = 1 } = {}) {
      for (let i = 0; i < times; i++) faults.failures.push({ code, retryAfterMs });
    },
    async download(record, { start = 0, end = record.size } = {}) {
      counters.downloads += 1;
      if (faults.gone.has(record.providerFileId)) throw new FilingError(FAILURE.VENDOR_FILE_GONE, 'synthetic 404 from Zoom');
      const failure = faults.failures.shift();
      if (failure) throw new FilingError(failure.code, 'synthetic Zoom download failure', { retryAfterMs: failure.retryAfterMs });
      let bytes = syntheticContent(record.providerFileId, start, end);
      if (faults.shortReadOnce > 0 && bytes.length > 1) {
        faults.shortReadOnce -= 1;
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      counters.bytesRead += bytes.length;
      clock?.advance(bytes.length * msPerByte);
      return bytes;
    },
  };
}

export const syntheticDownload = async (record, { start = 0, end = record.size } = {}) => Buffer.alloc(end - start, 7);

// Stands in for a serverless function being stopped: after `ops` more calls into the store,
// Drive or Zoom, every call from this invocation throws, as if the process were gone. Writes
// already committed stay; nothing the invocation tries afterwards reaches anything.
export class Killed extends Error {}

export function killSwitch(ops) {
  const gate = { left: ops, killed: false };
  const check = () => {
    if (!gate.killed && gate.left-- > 0) return;
    gate.killed = true;
    throw new Killed('function stopped');
  };
  return {
    gate,
    wrap: target => new Proxy(target, {
      get(object, property) {
        const value = object[property];
        if (typeof value !== 'function') return value;
        return (...args) => {
          check();
          return value.apply(object, args);
        };
      },
    }),
    wrapFn: fn => (...args) => {
      check();
      return fn(...args);
    },
  };
}
