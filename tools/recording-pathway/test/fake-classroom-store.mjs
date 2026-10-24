// In-memory stand-ins for the classroom database and Google Drive, for synthetic tests only.
// The store keeps the guarantees the design relies on from PostgreSQL: a transaction is all or
// nothing, event keys and job ids are unique, a job is claimed under a lease, and the writes
// that finish a job only succeed with the current lease number (fencing). The Drive fake knows
// appProperties and resumable uploads. Both can inject faults: failing or slow transactions,
// a crash in the middle of an upload or right after it, an upload held at a gate.
// Passing here shows our logic holds under these guarantees; it does not test PostgreSQL,
// Google Drive or Zoom themselves.

export function createClassroomStore({ lessons = [] } = {}) {
  let state = { events: new Map(), jobs: new Map(), files: new Map() };
  const lessonById = new Map(lessons.map(lesson => [lesson.id, lesson]));
  const faults = { failTransactions: 0, delayMs: 0 };
  const counters = { transactions: 0, failedTransactions: 0 };

  const readers = current => ({
    lesson: id => lessonById.get(id) ?? null,
    fileRecord: id => (current.files.has(id) ? { ...current.files.get(id) } : null),
    fileRecordsForLesson: id => [...current.files.values()].filter(record => record.lessonId === id).map(record => ({ ...record })),
    eligibility: id => [...current.events.values()]
      .filter(event => event.lessonId === id && event.type === 'server.recording_eligibility')
      .sort((a, b) => a.occurredAt - b.occurredAt).pop() ?? null,
    withdrawalAt: id => earliestAt(current, event => event.lessonId === id && event.type === 'server.consent_withdrawn'),
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
    failJob({ jobId, leaseVersion, now, error, maxAttempts, giveUp = {} }) {
      if (!holds(jobId, leaseVersion)) return false;
      const job = state.jobs.get(jobId);
      job.error = error;
      job.leaseOwner = null;
      if (job.attempts >= maxAttempts) {
        job.status = 'dead';
        if (giveUp.fileChanges && state.files.has(job.providerFileId)) Object.assign(state.files.get(job.providerFileId), giveUp.fileChanges);
        for (const event of giveUp.events ?? []) if (!state.events.has(event.key)) state.events.set(event.key, structuredClone(event));
      } else {
        job.status = 'pending';
        job.availableAt = now + Math.min(30 * 60_000, 30_000 * 2 ** (job.attempts - 1));
      }
      return true;
    },
    completeJob({ jobId, leaseVersion }) {
      if (!holds(jobId, leaseVersion)) return false;
      Object.assign(state.jobs.get(jobId), { status: 'done', leaseOwner: null });
      return true;
    },
    setUploadSession({ providerFileId, jobId, leaseVersion, uri }) {
      if (!holds(jobId, leaseVersion)) return false;
      state.files.get(providerFileId).uploadSessionUri = uri;
      return true;
    },
    // Fenced and all or nothing. A record that is already final only gets its job closed.
    finishFiling({ jobId, leaseVersion, providerFileId, changes, events = [], jobs = [] }) {
      if (!holds(jobId, leaseVersion)) return false;
      const record = state.files.get(providerFileId);
      const job = state.jobs.get(jobId);
      if (!['STORED', 'QUARANTINED', 'HOLD', 'FAILED'].includes(record.status)) {
        Object.assign(record, changes);
        for (const event of events) if (!state.events.has(event.key)) state.events.set(event.key, structuredClone(event));
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
  return { status: 'pending', attempts: 0, leaseVersion: 0, leaseOwner: null, leaseUntil: 0, availableAt: 0, ...job };
}

export function createDrive({ chunkSize = 16 } = {}) {
  const files = new Map();
  const folders = new Map();
  const sessions = new Map();
  let ids = 0;
  let clock = 0;
  const faults = { crashAfterChunks: null, crashAfterFinish: 0, reportExpiredOnce: 0, holdUpload: null };
  const counters = { sessionsStarted: 0, uploadsFinished: 0 };
  return {
    faults,
    counters,
    ensureFolder(parentId, name) {
      const key = `${parentId}/${name}`;
      if (!folders.has(key)) folders.set(key, `folder-${++ids}`);
      return folders.get(key);
    },
    folderName(id) {
      return [...folders.entries()].find(([, value]) => value === id)?.[0].split('/').slice(1).join('/') ?? null;
    },
    listNames(folderId) {
      return [...files.values()].filter(file => !file.trashed && file.parentId === folderId).map(file => file.name);
    },
    findByAppProperty(key, value) {
      return [...files.values()].filter(file => !file.trashed && file.appProperties[key] === value).map(file => ({ ...file }));
    },
    startUpload(meta) {
      const uri = `upload://session-${++ids}`;
      sessions.set(uri, { meta, received: 0, fileId: null });
      counters.sessionsStarted += 1;
      return uri;
    },
    // A resumable session URI stays usable; the fault makes one check report it as expired.
    sessionAlive(uri) {
      if (!sessions.has(uri)) return false;
      if (faults.reportExpiredOnce > 0) {
        faults.reportExpiredOnce -= 1;
        return false;
      }
      return true;
    },
    // holdUpload = { gate, reached }: the next upload calls reached() and then waits for gate.
    async upload(uri, bytes) {
      const session = sessions.get(uri);
      if (faults.holdUpload) {
        const hold = faults.holdUpload;
        faults.holdUpload = null;
        hold.reached?.();
        await hold.gate;
      }
      while (session.received < bytes.length) {
        if (faults.crashAfterChunks === 0) {
          faults.crashAfterChunks = null;
          throw new Error('synthetic crash during upload');
        }
        session.received = Math.min(bytes.length, session.received + chunkSize);
        if (faults.crashAfterChunks != null) faults.crashAfterChunks -= 1;
      }
    },
    // Completing a finished session again returns the same file, as Drive does.
    finishUpload(uri) {
      const session = sessions.get(uri);
      if (!session.fileId) {
        const id = `drive-file-${++ids}`;
        files.set(id, {
          id,
          name: session.meta.name,
          parentId: session.meta.parentId,
          appProperties: { ...session.meta.appProperties },
          size: session.received,
          md5: null,
          createdTime: ++clock,
          trashed: false,
        });
        session.fileId = id;
        counters.uploadsFinished += 1;
      }
      if (faults.crashAfterFinish > 0) {
        faults.crashAfterFinish -= 1;
        throw new Error('synthetic crash after upload');
      }
      return session.fileId;
    },
    trash(id) {
      files.get(id).trashed = true;
    },
    // Stands in for an upload made some other way, for example by a worker that lost track of it.
    addFile({ name, parentId, appProperties, size }) {
      const id = `drive-file-${++ids}`;
      files.set(id, { id, name, parentId, appProperties: { ...appProperties }, size, md5: null, createdTime: ++clock, trashed: false });
      return id;
    },
    activeFiles() {
      return [...files.values()].filter(file => !file.trashed).map(file => ({ ...file }));
    },
    trashedFiles() {
      return [...files.values()].filter(file => file.trashed).map(file => ({ ...file }));
    },
  };
}

export const syntheticDownload = async record => Buffer.alloc(record.size, 7);
