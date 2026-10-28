// Filing finished recordings to Google Drive (synthetic prototype: the Drive and Zoom adapters
// are stand-ins until their accounts are approved).
//
// A serverless function can be stopped at any moment, and a lesson video is far larger than one
// function call can move. So no filing depends on one call finishing:
// - the job lives in the database and is claimed under a lease with a fencing number;
// - the video moves in chunks through one resumable Drive upload session; after every chunk the
//   session and the byte count Drive confirmed are saved and the lease is renewed;
// - before the call's time budget runs out the worker stops between chunks and puts the job back
//   (CONTINUE), so the next call carries on from the confirmed byte. A call that is killed anyway
//   only loses its lease, and the next worker resumes from what Drive confirms;
// - every outcome is one fenced write, so a worker that lost its lease changes nothing.
// Failures are told apart. Brief ones are retried with backoff, never before Retry-After. A full
// Drive or a revoked authorization blocks the job, without using up its attempts, until an
// administrator fixes it; the job looks again every 30 minutes. A recording Zoom no longer has
// fails at once. Zoom's copy is deleted only after a verified copy is in Drive.
//
// The store, Drive and the download may be synchronous (test fakes) or asynchronous (PostgreSQL,
// Google Drive and Zoom in the website); every call is awaited.
import Core from '../apps-script/Core.js';

export const JOB_LEASE_MS = 2 * 60 * 1000;      // renewed after every chunk
export const MAX_JOB_ATTEMPTS = 5;
export const QUARANTINE_FOLDER = '_待確認';
export const FILING_DEFAULTS = Object.freeze({
  // Drive wants chunks in multiples of 256 KiB, except the last one.
  chunkBytes: 8 * 1024 * 1024,
  // Never start a chunk closer than this to the deadline (or twice the slowest chunk so far).
  safetyMs: 15_000,
  // A blocked filing looks again this often.
  blockedRecheckMs: 30 * 60_000,
});
const FINAL_STATUSES = ['STORED', 'QUARANTINED', 'HOLD', 'FAILED'];

// What went wrong, in terms of what to do next. The Drive and Zoom adapters turn HTTP answers
// into these codes; see classifyDriveResponse and classifyVendorResponse.
export const FAILURE = Object.freeze({
  TRANSIENT: 'TRANSIENT',                       // retry with backoff
  RATE_LIMITED: 'RATE_LIMITED',                 // retry, not before Retry-After
  DRIVE_QUOTA: 'DRIVE_QUOTA',                   // blocked until there is room
  DRIVE_AUTH: 'DRIVE_AUTH',                     // blocked until access is restored
  DRIVE_FOLDER_MISSING: 'DRIVE_FOLDER_MISSING', // blocked: the destination is gone or not ours
  SESSION_GONE: 'SESSION_GONE',                 // the resumable session expired: start a new one
  VENDOR_AUTH: 'VENDOR_AUTH',                   // blocked until Zoom access is restored
  VENDOR_FILE_GONE: 'VENDOR_FILE_GONE',         // Zoom no longer has the file: fail now
  INVALID: 'INVALID',                           // a malformed request or a bug: retried, counted
});
const BLOCKING = new Set([FAILURE.DRIVE_QUOTA, FAILURE.DRIVE_AUTH, FAILURE.DRIVE_FOLDER_MISSING, FAILURE.VENDOR_AUTH]);

export class FilingError extends Error {
  constructor(code, message = code, { retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'FilingError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const retryAfterMsOf = value => {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(String(value ?? ''));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
};

// Google Drive API v3 answers, as its "Resolve errors" guide describes them. To be checked
// against real answers once a test account is approved. `operation` is 'session' for requests
// to an upload session URI, otherwise anything else.
export function classifyDriveResponse({ status, reason = '', retryAfter = null, operation = 'other' }) {
  const retryAfterMs = retryAfterMsOf(retryAfter);
  if (!status) return { code: FAILURE.TRANSIENT, retryAfterMs };
  if (status === 401) return { code: FAILURE.DRIVE_AUTH, retryAfterMs };
  if (status === 403) {
    if (reason === 'storageQuotaExceeded') return { code: FAILURE.DRIVE_QUOTA, retryAfterMs };
    if (['userRateLimitExceeded', 'rateLimitExceeded'].includes(reason)) return { code: FAILURE.RATE_LIMITED, retryAfterMs };
    if (reason === 'dailyLimitExceeded') return { code: FAILURE.RATE_LIMITED, retryAfterMs: Math.max(retryAfterMs, 60 * 60_000) };
    return { code: FAILURE.DRIVE_AUTH, retryAfterMs };
  }
  if (status === 404 || status === 410) return { code: operation === 'session' ? FAILURE.SESSION_GONE : FAILURE.DRIVE_FOLDER_MISSING, retryAfterMs };
  if (status === 429) return { code: FAILURE.RATE_LIMITED, retryAfterMs };
  if (status >= 500) return { code: FAILURE.TRANSIENT, retryAfterMs };
  return { code: FAILURE.INVALID, retryAfterMs };
}

// Zoom recording download answers. To be checked against real downloads, including whether
// Zoom honours Range requests at all.
export function classifyVendorResponse({ status, retryAfter = null }) {
  const retryAfterMs = retryAfterMsOf(retryAfter);
  if (!status || status >= 500) return { code: FAILURE.TRANSIENT, retryAfterMs };
  if (status === 401 || status === 403) return { code: FAILURE.VENDOR_AUTH, retryAfterMs };
  if (status === 404 || status === 410) return { code: FAILURE.VENDOR_FILE_GONE, retryAfterMs };
  if (status === 429) return { code: FAILURE.RATE_LIMITED, retryAfterMs };
  return { code: FAILURE.INVALID, retryAfterMs };
}

// Recorded at or after the moment protection started (a withdrawal, or someone unknown joining).
export const runsPast = (file, at) => at != null && (file.recordingEnd == null || file.recordingEnd > at);

// The P1 filing fact the overview reads. Final outcomes have one fixed key each; a block or a
// resumption can happen more than once, so their keys carry the time.
export function filingEvent(record, status, at, { reason = null, repeatable = false } = {}) {
  const event = {
    source: 'p1',
    type: 'p1.filing',
    lessonId: record.lessonId,
    providerFileId: record.providerFileId,
    status,
    occurredAt: at,
    receivedAt: at,
    key: `p1.filing:${record.providerFileId}:${status}${repeatable ? `:${reason ?? ''}:${at}` : ''}`,
  };
  if (reason) event.reason = reason;
  return event;
}

// Workers claim stored jobs one at a time under a lease, and stop claiming before the deadline.
// A worker that crashes simply loses its lease; the job becomes claimable again when the lease
// runs out. `clock` reads the time now (a long call outlives a fixed `now`).
//
// A job's attempts count the claims since its last byte of progress: saving progress resets
// them, so a long transfer over a flaky connection keeps going, while a job that is stopped
// mid-way again and again without moving a byte gives up instead of looping for ever.
/**
 * @param {{ store: any, now?: number | null, clock?: (() => number) | null, deadline?: number, workerId: string,
 *   handlers: Record<string, (input: any) => any>, leaseMs?: number, max?: number, safetyMs?: number }} input
 */
export async function processJobs({ store, now = null, clock = null, deadline = Infinity, workerId, handlers, leaseMs = JOB_LEASE_MS, max = 20, safetyMs = Number(FILING_DEFAULTS.safetyMs) }) {
  const time = clock ?? (() => now);
  const results = [];
  for (let i = 0; i < max; i++) {
    if (deadline - time() < safetyMs) break;
    const claim = await store.claimJob({ workerId, now: time(), leaseMs });
    if (!claim) break;
    const { job, leaseVersion } = claim;
    if (job.attempts > MAX_JOB_ATTEMPTS) {
      const stuck = new FilingError(FAILURE.TRANSIENT, `claimed ${job.attempts} times without progress; earlier calls were stopped mid-way`);
      results.push({ jobId: job.id, ...(await settleFailure({ store, job, leaseVersion, error: stuck, at: time() })) });
      continue;
    }
    let result;
    try {
      result = { jobId: job.id, ...(await handlers[job.type]({ job, leaseVersion, now: time(), clock: time, deadline, leaseMs })) };
    } catch (error) {
      result = { jobId: job.id, ...(await settleFailure({ store, job, leaseVersion, error, at: time() })) };
    }
    results.push(result);
    // This call's time is used up; the next call carries on.
    if (result.status === 'CONTINUE') break;
  }
  return results;
}

async function settleFailure({ store, job, leaseVersion, error, at }) {
  const code = error instanceof FilingError ? error.code : FAILURE.TRANSIENT;
  const message = `${code}: ${String(error?.message || error)}`.slice(0, 500);
  const filing = job.type === 'file_recording';
  if (BLOCKING.has(code)) {
    // Recorded once per stretch of being blocked, not at every recheck.
    const events = filing && job.blockedReason !== code ? [filingEvent(job, 'BLOCKED', at, { reason: code, repeatable: true })] : [];
    const ok = await store.rescheduleJob({ jobId: job.id, leaseVersion, availableAt: at + FILING_DEFAULTS.blockedRecheckMs, refundAttempt: true, blockedReason: code, error: message, events });
    return { status: ok ? 'BLOCKED' : 'LEASE_LOST', reason: code };
  }
  const gone = code === FAILURE.VENDOR_FILE_GONE;
  const giveUp = filing ? { fileChanges: { status: 'FAILED' }, events: [filingEvent(job, 'FAILED', at, { reason: code })] } : {};
  const ok = await store.failJob({
    jobId: job.id,
    leaseVersion,
    now: at,
    error: message,
    maxAttempts: gone ? 0 : MAX_JOB_ATTEMPTS,
    retryAfterMs: error?.retryAfterMs || 0,
    giveUp,
  });
  return { status: !ok ? 'LEASE_LOST' : gone ? 'FAILED' : 'RETRY', reason: code };
}

// One fenced write finishes a filing: the record's outcome, the P1 filing event the dashboard
// reads and, once a copy is safely stored, the job that may delete Zoom's copy. It only
// succeeds while the worker still holds the job's lease.
function finish(store, record, job, leaseVersion, status, driveFileId, now) {
  return store.finishFiling({
    jobId: job.id,
    leaseVersion,
    providerFileId: record.providerFileId,
    changes: { status, driveFileId, filedAt: now },
    events: [filingEvent(record, status, now)],
    jobs: status === 'STORED'
      ? [{ id: `delete-vendor:${record.providerFileId}`, type: 'delete_vendor_copy', lessonId: record.lessonId, providerFileId: record.providerFileId }]
      : [],
  });
}

// The planned name, unless a file that is not ours already uses it: then the next free part.
async function freeName(drive, folderId, plannedName, extension) {
  const taken = new Set(await drive.listNames(folderId));
  if (!taken.has(plannedName)) return plannedName;
  const base = plannedName.replace(/_P\d{2,}\.[a-z0-9]+$/, '');
  return Core.fileName(base, Core.nextPart([plannedName], name => taken.has(name), base, extension), extension);
}

// The copy that counts is the earliest verified one; every worker applies the same rule, so
// any duplicates converge to one copy. Drive's search can lag behind a fresh upload, so a copy
// we know by its id is read directly as well.
async function verifiedCopies(drive, record, knownIds = []) {
  const found = await drive.findByAppProperty('providerFileId', record.providerFileId);
  for (const id of knownIds) {
    if (!id || found.some(file => file.id === id)) continue;
    const file = await drive.getFile(id);
    if (file && !file.trashed && file.appProperties?.providerFileId === record.providerFileId) found.push(file);
  }
  return found
    .filter(file => file.size === record.size && (!record.md5 || file.md5 === record.md5))
    .sort((a, b) => a.createdTime - b.createdTime || a.id.localeCompare(b.id));
}

// Refuses to start an upload Drive has no room for, before a single byte moves.
async function ensureRoom(drive, bytes) {
  const quota = await drive.quota();
  if (quota.limit != null && quota.limit - quota.usage < bytes) {
    throw new FilingError(FAILURE.DRIVE_QUOTA, `Drive has ${quota.limit - quota.usage} bytes free; the recording needs ${bytes}`);
  }
}

// Moves the recording into Drive chunk by chunk through one resumable session. Returns
// UPLOADED with the Drive file, CONTINUE when the time budget is used up, or LEASE_LOST.
async function transfer({ store, drive, download, job, leaseVersion, record, folderName, time, deadline, leaseMs, chunkBytes, safetyMs, rootFolderId }) {
  let resumed = job.blockedReason ? [filingEvent(job, 'RESUMED', time(), { repeatable: true })] : [];
  let uri = record.uploadSessionUri || null;
  let offset = 0;
  const save = async uploadedBytes => {
    const ok = await store.recordTransfer({ jobId: job.id, leaseVersion, providerFileId: record.providerFileId, uri, uploadedBytes, now: time(), leaseMs, events: resumed });
    if (ok) resumed = [];
    return ok;
  };
  if (uri) {
    const status = await drive.uploadStatus(uri);
    if (status.state === 'complete') return { status: 'UPLOADED', fileId: status.fileId };
    if (status.state === 'active') offset = status.received;
    else uri = null;
  }
  if (!uri) {
    await ensureRoom(drive, record.size);
    const folderId = await drive.ensureFolder(rootFolderId, folderName);
    const name = await freeName(drive, folderId, record.plannedName, record.extension);
    uri = await drive.startUpload({ name, parentId: folderId, size: record.size, appProperties: { providerFileId: record.providerFileId, lessonId: record.lessonId } });
    if (!(await save(0))) return { status: 'LEASE_LOST', fileId: null };
  }
  let slowestChunkMs = 0;
  let stalled = 0;
  for (;;) {
    if (deadline - time() < Math.max(safetyMs, 2 * slowestChunkMs)) {
      const ok = await store.rescheduleJob({ jobId: job.id, leaseVersion, availableAt: time(), refundAttempt: true, blockedReason: null, error: null, events: resumed });
      return ok ? { status: 'CONTINUE', uploadedBytes: offset } : { status: 'LEASE_LOST', fileId: null };
    }
    const started = time();
    const end = Math.min(record.size, offset + chunkBytes);
    const bytes = await download(record, { start: offset, end });
    if (bytes.length !== end - offset) throw new FilingError(FAILURE.TRANSIENT, `short read from Zoom: ${bytes.length} of ${end - offset} bytes`);
    const answer = await drive.uploadChunk(uri, { offset, bytes, total: record.size });
    // Drive may keep fewer bytes than were sent, or report where another worker already got to:
    // always continue from what Drive confirms. If it keeps confirming no progress, stop this
    // attempt instead of sending the same bytes until the deadline.
    stalled = answer.received > offset || answer.fileId ? 0 : stalled + 1;
    if (stalled >= 2) throw new FilingError(FAILURE.TRANSIENT, `Drive confirmed no progress at byte ${answer.received}`);
    offset = answer.received;
    slowestChunkMs = Math.max(slowestChunkMs, time() - started);
    if (!(await save(offset))) return { status: 'LEASE_LOST', fileId: answer.fileId ?? null };
    if (answer.fileId) return { status: 'UPLOADED', fileId: answer.fileId };
  }
}

/**
 * @param {{ store: any, drive: any, download: (record: any, range: { start: number, end: number }) => any, job: any, leaseVersion: number,
 *   now?: number | null, clock?: (() => number) | null, deadline?: number, leaseMs?: number, rootFolderId: string,
 *   options?: { chunkBytes?: number, safetyMs?: number } }} input
 */
export async function fileRecording({ store, drive, download, job, leaseVersion, now = null, clock = null, deadline = Infinity, leaseMs = JOB_LEASE_MS, rootFolderId, options = {} }) {
  const time = clock ?? (() => now);
  const { chunkBytes, safetyMs } = { ...FILING_DEFAULTS, ...options };
  const record = await store.fileRecord(job.providerFileId);
  if (!record) throw new FilingError(FAILURE.INVALID, 'unknown recording file');
  if (FINAL_STATUSES.includes(record.status)) {
    await finish(store, record, job, leaseVersion, record.status, record.driveFileId, time());
    return { status: 'ALREADY_DONE' };
  }
  // A withdrawal or an unknown participant reported after the recording was registered still
  // applies.
  const withdrawnAt = await store.withdrawalAt(record.lessonId);
  if (runsPast(record, withdrawnAt) || runsPast(record, await store.unknownJoinAt(record.lessonId))) {
    await finish(store, record, job, leaseVersion, 'HOLD', null, time());
    return { status: 'HOLD' };
  }
  const quarantine = record.hold === 'CONSENT_WITHDRAWN' || withdrawnAt != null;
  const outcome = quarantine ? 'QUARANTINED' : 'STORED';

  // Already uploaded, for example by a worker that was stopped after its upload but before
  // writing to the database: adopt that copy, upload nothing.
  let copies = await verifiedCopies(drive, record);
  let mine = null;
  if (!copies.length) {
    const lesson = await store.lesson(record.lessonId);
    const folderName = quarantine ? QUARANTINE_FOLDER : Core.monthlyFolderName(lesson.date);
    const moved = await transfer({ store, drive, download, job, leaseVersion, record, folderName, time, deadline, leaseMs, chunkBytes, safetyMs, rootFolderId });
    if (moved.status === 'CONTINUE') return moved;
    if (moved.status === 'LEASE_LOST') return dropOurExtraCopy(store, drive, record, moved.fileId);
    mine = moved.fileId;
    copies = await verifiedCopies(drive, record, [mine]);
    if (!copies.length) {
      // Drive holds something that does not match Zoom's file: throw it away and start over.
      await drive.trash(mine);
      if (!(await store.recordTransfer({ jobId: job.id, leaseVersion, providerFileId: record.providerFileId, uri: null, uploadedBytes: 0, now: time(), leaseMs, events: [] }))) return { status: 'LEASE_LOST' };
      throw new FilingError(FAILURE.TRANSIENT, 'uploaded copy failed verification');
    }
  }
  const keep = copies[0];
  if (await finish(store, record, job, leaseVersion, outcome, keep.id, time())) {
    for (const copy of await drive.findByAppProperty('providerFileId', record.providerFileId)) if (copy.id !== keep.id) await drive.trash(copy.id);
    return { status: outcome, driveFileId: keep.id };
  }
  return dropOurExtraCopy(store, drive, record, mine);
}

// The fencing check failed: our lease ran out and another worker owns the job now. If that
// worker already stored a copy, the one we just uploaded is extra and goes to the trash;
// otherwise the new owner finds ours and keeps the earliest verified copy.
async function dropOurExtraCopy(store, drive, record, mine) {
  const latest = await store.fileRecord(record.providerFileId);
  if (mine && latest?.driveFileId && latest.driveFileId !== mine) await drive.trash(mine);
  return { status: 'LEASE_LOST' };
}
