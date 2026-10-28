// Test A1: the P1 filing worker and the Google Drive adapter against Google Drive, with the P1
// test account, a test-only Desktop OAuth client (drive.file only), synthetic videos and one test
// folder. Steps and acceptance criteria: docs/a1-drive-test-runbook.md.
//
//   node tools/recording-pathway/drive-test/run-a1.mjs <command> [--config <file>]
//     init --account <test account> [--deny <account>...] [--browser-profile <dir>]
//                makes the private folder (only you can read it) and the config, outside the repo
//     auth       sign in (prints the consent URL; open it in the test account's browser profile)
//     media      make the synthetic videos (ffmpeg; every frame says 合成測試影片／非真實錄影)
//     run        D1–D9; stops at the first failed gate; evidence goes to <workDir>/evidence
//     cleanup    deletes the test folder and everything the tests put in it
//     revoke     revokes the grant, checks that a refresh is refused, deletes the token file
//     self-test  all of the above against a local stand-in of Google (no network, no account)
//
// Config (outside the repository, default %LOCALAPPDATA%\iHear-p1-drive-test\config.json):
//   { "expectedAccount": "<the P1 test account>", "forbiddenAccounts": ["<accounts never to use>"],
//     "clientFile": "<private dir>\\client.json", "tokenFile": "<private dir>\\token.json",
//     "workDir": "<dir for media and evidence>" }
// Nothing here reads real recordings, and nothing writes outside the test folder.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Core from '../apps-script/Core.js';
import { createGoogleDrive } from '../classroom/google-drive.mjs';
import { FAILURE, FilingError, fileRecording, processJobs, QUARANTINE_FOLDER, classifyDriveResponse } from '../classroom/recording-filing.mjs';
import { storeEvent } from '../classroom/webhook-ingest.mjs';
import { createClassroomStore, Killed } from '../test/fake-classroom-store.mjs';
import { authorize, DRIVE_FILE_SCOPE, ensurePrivateDir, GOOGLE, readClient, revokeSaved, tokenProvider } from './oauth.mjs';

export const ROOT_NAME = '[測試] iHear P1 自動歸檔 A1';
const ALWAYS_FORBIDDEN = ['ihearprogram@gmail.com'];
const KiB = 1024;
const MiB = 1024 * KiB;
const LESSON = {
  id: 'L-TEST-A1', code: 'TEST-A1', date: '2026-11-05', startsAt: '2026-11-05T08:00:00.000Z', endsAt: '2026-11-05T09:00:00.000Z',
  participants: [{ id: 'P-TEST-A1-T', code: 'TEST-T01', role: 'tutor' }, { id: 'P-TEST-A1-S', code: 'TEST-S01', role: 'student' }],
};
const MEDIA = { small: 'a1-small.mp4', medium: 'a1-medium.mp4' };
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// --- Setup --------------------------------------------------------------------------------

function checkConfig(config) {
  for (const key of ['expectedAccount', 'clientFile', 'tokenFile', 'workDir']) if (!config[key]) throw new Error(`config is missing ${key}`);
  const forbidden = [...ALWAYS_FORBIDDEN, ...(config.forbiddenAccounts ?? [])].map(entry => entry.toLowerCase());
  if (forbidden.includes(config.expectedAccount.toLowerCase())) throw new Error('the expected account is on the forbidden list');
  return { ...config, forbidden };
}

export async function loadConfig(file) {
  return checkConfig(JSON.parse(await readFile(file, 'utf8')));
}

function connect(config, { apiBase, endpoints }) {
  const answers = [];
  const accessToken = tokenProvider({ clientFile: config.clientFile, tokenFile: config.tokenFile, endpoint: endpoints.token });
  const drive = createGoogleDrive({ accessToken, apiBase, onAnswer: answer => answers.push({ ...answer, at: Date.now() }) });
  return { drive, answers, accessToken };
}

// The synthetic videos: a test pattern with the label burned into every frame, one small and one
// spread over three 8 MiB chunks. Without ffmpeg (self-test) the bytes are synthetic but not video.
export async function makeMedia(dir, { useFfmpeg = true } = {}) {
  await mkdir(dir, { recursive: true });
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  const font = ['C:/Windows/Fonts/msjh.ttc', 'C:/Windows/Fonts/msyh.ttc'].find(candidate => existsSync(candidate));
  const label = font ? `,drawtext=fontfile='${font.replace(':', '\\:')}':text='合成測試影片／非真實錄影':fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:x=20:y=20` : '';
  const made = {};
  for (const [kind, name] of Object.entries(MEDIA)) {
    const file = path.join(dir, name);
    if (useFfmpeg) {
      const args = kind === 'small'
        ? ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=10', '-vf', `format=yuv420p${label}`, '-c:v', 'libx264', '-b:v', '1M', file]
        : ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=12', '-vf', `noise=alls=60:allf=t,format=yuv420p${label}`, '-c:v', 'libx264', '-b:v', '16M', '-maxrate', '16M', '-bufsize', '16M', file];
      const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr || result.error}`);
    } else {
      const size = kind === 'small' ? MiB + 12_345 : 2 * 8 * MiB + 300 * KiB;
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 9)) & 0xff;
      await writeFile(file, bytes);
    }
    const bytes = await readFile(file);
    made[kind] = { file, size: bytes.length, md5: md5(bytes) };
  }
  if (made.medium.size <= 2 * 8 * MiB) throw new Error(`the medium video is ${made.medium.size} bytes; it must span three 8 MiB chunks`);
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(made, null, 2)}\n`);
  return made;
}

// Zoom's side for A1: byte ranges of a local synthetic file.
function localVendor(paths) {
  return async (record, { start, end }) => {
    const handle = await open(paths[record.providerFileId], 'r');
    try {
      const bytes = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(bytes, 0, end - start, start);
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };
}

// One recording handed to the real filing worker, with an in-memory database standing in for
// PostgreSQL (A1 tests Drive, not the database).
async function workerFor(drive, rootFolderId, files, paths) {
  const store = createClassroomStore({ lessons: [LESSON] });
  await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: LESSON.id, occurredAt: 0, receivedAt: 0, key: 'decide:A1', eligible: true }));
  const fact = {
    source: 'zoom_api', type: 'session.recording_completed', lessonId: LESSON.id, providerSessionId: 'SESSION-TEST-A1', receivedAt: Date.now(), occurredAt: Date.now(),
    files: files.map(entry => ({ providerFileId: entry.id, kind: 'shared_screen_with_speaker_view', extension: 'mp4', size: entry.size, status: 'completed', recordingStart: entry.startMs, recordingEnd: entry.startMs + 60_000 })),
  };
  fact.key = `session.recording_completed:A1:${files.map(entry => entry.id).join(',')}`;
  await store.transaction(tx => storeEvent(tx, fact));
  const download = localVendor(paths);
  // stopAfterChunks stands in for the function being stopped: after that many chunks, every
  // further call to the database or Drive fails, so nothing more is recorded.
  // laterByMs runs the call that much later, as the next scheduled call after a lease ran out would.
  const run = async ({ chunkBytes = undefined, budgetMs = 120_000, stopAfterChunks = null, laterByMs = 0 } = {}) => {
    const clock = () => Date.now() + laterByMs;
    let chunks = 0;
    let stopped = false;
    const guard = target => new Proxy(target, {
      get(object, property) {
        const value = object[property];
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (stopped) throw new Killed('function stopped');
          return value.apply(object, args);
        };
      },
    });
    const db = stopAfterChunks == null ? store : guard(store);
    const counted = stopAfterChunks == null ? drive : guard({
      ...drive,
      uploadChunk: async (...args) => {
        if (chunks >= stopAfterChunks) {
          stopped = true;
          throw new Killed('function stopped');
        }
        chunks += 1;
        return drive.uploadChunk(...args);
      },
    });
    try {
      return await processJobs({
        store: db, clock, deadline: clock() + budgetMs, workerId: 'a1', safetyMs: 5_000,
        handlers: {
          file_recording: ({ job, leaseVersion, clock: time, deadline, leaseMs }) => fileRecording({ store: db, drive: counted, download, job, leaseVersion, clock: time, deadline, leaseMs, rootFolderId, options: { ...(chunkBytes ? { chunkBytes } : {}), safetyMs: 5_000 } }),
          delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await db.completeJob({ jobId: job.id, leaseVersion })) ? 'ZOOM_COPY_WOULD_BE_DELETED' : 'LEASE_LOST' }),
        },
      });
    } catch (error) {
      if (error instanceof Killed) return [{ status: 'KILLED' }];
      throw error;
    }
  };
  return { store, run, record: id => store.fileRecord(id) };
}

// --- D1–D9 --------------------------------------------------------------------------------

export async function runTests(config, { apiBase = 'https://www.googleapis.com', endpoints = GOOGLE, media, log = console.log }) {
  const results = [];
  const record = (id, title, result, details) => {
    results.push({ id, title, result, details });
    log(`${result.padEnd(8)} ${id} ${title}`);
    if (result === 'FAIL') log(`         ${JSON.stringify(details)}`);
    return result;
  };
  const { drive, answers, accessToken } = connect(config, { apiBase, endpoints });
  const sessionAnswers = since => answers.filter(answer => answer.at >= since && answer.operation === 'session');
  const stop = () => ({ results, stopped: true });

  // D1: the grant is the test account's, drive.file only.
  const saved = JSON.parse(await readFile(config.tokenFile, 'utf8'));
  let who = null;
  try {
    await accessToken();
    who = await drive.whoAmI();
  } catch (error) {
    record('D1', '授權、權限範圍與帳號', 'FAIL', { error: error.message });
    return stop();
  }
  const d1 = { scope: saved.scope, accountMatches: String(who).toLowerCase() === config.expectedAccount.toLowerCase(), forbidden: config.forbidden.includes(String(who).toLowerCase()) };
  if (record('D1', '授權、權限範圍與帳號', d1.scope === DRIVE_FILE_SCOPE && d1.accountMatches && !d1.forbidden ? 'PASS' : 'FAIL', d1) !== 'PASS') return stop();

  // D2: the test folders, found again rather than duplicated.
  const rootId = await drive.ensureFolder('root', ROOT_NAME);
  const monthName = Core.monthlyFolderName(LESSON.date);
  const monthId = await drive.ensureFolder(rootId, monthName);
  const quarantineId = await drive.ensureFolder(rootId, QUARANTINE_FOLDER);
  // A second process (no memory of the first) must find the same folders through search, 3 s later.
  await sleep(3000);
  const fresh = connect(config, { apiBase, endpoints }).drive;
  const again = [await fresh.findFolders('root', ROOT_NAME), await fresh.findFolders(rootId, monthName), await fresh.findFolders(rootId, QUARANTINE_FOLDER)];
  const d2 = {
    rootFolderStartsWithTest: ROOT_NAME.startsWith('[測試]'),
    foundAgainBySearch: again.map(ids => ids.length),
    sameIdsFromAnotherProcess: again.map(ids => ids[0]).join() === [rootId, monthId, quarantineId].join(),
  };
  if (record('D2', '測試資料夾', d2.rootFolderStartsWithTest && d2.sameIdsFromAnotherProcess ? 'PASS' : 'FAIL', d2) !== 'PASS') return stop();

  const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const paths = {};
  const fileOf = (kind, suffix, startMs) => {
    const id = `TEST-A1-${run}-${suffix}`;
    paths[id] = media[kind].file;
    return { id, size: media[kind].size, md5: media[kind].md5, startMs };
  };
  const base = Date.parse(LESSON.startsAt);
  const checkStored = async (worker, file, part) => {
    const stored = worker.record(file.id);
    const copy = stored?.driveFileId ? await drive.getFile(stored.driveFileId) : null;
    return {
      status: stored?.status,
      sizeMatches: copy?.size === file.size,
      md5Matches: copy?.md5 === file.md5,
      name: copy?.name,
      // An exact part when given; otherwise P1's pattern (earlier steps already used the low parts).
      nameMatches: part ? copy?.name === `2026-11-05_TEST-S01_TEST-T01_P0${part}.mp4` : /^2026-11-05_TEST-S01_TEST-T01_P\d{2}\.mp4$/.test(copy?.name ?? ''),
      inMonthFolder: copy?.parentId === monthId,
    };
  };
  const good = check => check.status === 'STORED' && check.sizeMatches && check.md5Matches && check.nameMatches && check.inMonthFolder;

  // D3: chunked upload of both videos (256 KiB chunks, then the default 8 MiB).
  const small = fileOf('small', 'D3a', base);
  const medium = fileOf('medium', 'D3b', base + 120_000);
  // One worker per video, so each call files exactly one of them.
  const d3small = await workerFor(drive, rootId, [small], paths);
  let since = Date.now();
  await d3small.run({ chunkBytes: 256 * KiB });
  const smallSession = sessionAnswers(since);
  const d3medium = await workerFor(drive, rootId, [medium], paths);
  since = Date.now();
  await d3medium.run();
  const mediumSession = sessionAnswers(since);
  const d3 = {
    small: await checkStored(d3small, small, 1),
    // P01 is already in the folder (the small video), so the medium one must take P02.
    medium: await checkStored(d3medium, medium, 2),
    mediumChunks: mediumSession.length,
    smallAnswers: smallSession.map(answer => `${answer.status}${answer.range ? ` ${answer.range}` : ''}`),
    mediumAnswers: mediumSession.map(answer => `${answer.status}${answer.range ? ` ${answer.range}` : ''}`),
  };
  const rangesInclusive = smallSession.filter(answer => answer.status === 308).every((answer, i) => answer.range === `bytes=0-${(i + 1) * 256 * KiB - 1}`);
  d3.rangesInclusive = rangesInclusive;
  if (record('D3', '分段上傳與完整性', good(d3.small) && good(d3.medium) && rangesInclusive && [200, 201].includes(smallSession.at(-1)?.status) ? 'PASS' : 'FAIL', d3) !== 'PASS') return stop();

  // D4: stopped after two chunks; the next call asks Drive and carries on from there.
  const resumed = fileOf('small', 'D4', base);
  const d4worker = await workerFor(drive, rootId, [resumed], paths);
  since = Date.now();
  const first = await d4worker.run({ chunkBytes: 256 * KiB, stopAfterChunks: 2 });
  const held = d4worker.record(resumed.id).uploadedBytes;
  const statusSince = Date.now();
  // The stopped call's lease (2 minutes) has run out by the next call.
  await d4worker.run({ chunkBytes: 256 * KiB, laterByMs: 3 * 60_000 });
  const all = sessionAnswers(since);
  const statusQuery = sessionAnswers(statusSince)[0];
  const d4 = {
    firstCall: first.map(entry => entry.status),
    confirmedBeforeStop: held,
    statusQuery: statusQuery ? `${statusQuery.status} ${statusQuery.range ?? '(no Range)'}` : null,
    chunksSent: all.filter(answer => answer.status !== 308 || answer.range).length,
    sessionsOpened: answers.filter(answer => answer.at >= since && answer.operation === 'startUpload').length,
    ...(await checkStored(d4worker, resumed)),
  };
  if (record('D4', '中斷後續傳', good(d4) && d4.confirmedBeforeStop === 2 * 256 * KiB && d4.sessionsOpened === 1 && statusQuery?.status === 308 ? 'PASS' : 'FAIL', d4) !== 'PASS') return stop();

  // D5: an unknown session, and a chunk sent at the wrong place (what Drive answers is recorded).
  const sample = await readFile(media.small.file);
  const uri = await drive.startUpload({ name: `a1-d5-${run}.mp4`, parentId: rootId, size: sample.length, appProperties: { a1: `D5-${run}` } });
  const unknownState = await drive.uploadStatus(uri.replace(/upload_id=[^&]+/, 'upload_id=a1-unknown-session'));
  await drive.uploadChunk(uri, { offset: 0, bytes: sample.subarray(0, 256 * KiB), total: sample.length });
  let misplaced;
  try {
    misplaced = { answer: await drive.uploadChunk(uri, { offset: 512 * KiB, bytes: sample.subarray(512 * KiB, 768 * KiB), total: sample.length }) };
  } catch (error) {
    misplaced = { error: error.code, restartSession: error.restartSession };
  }
  // Finish the upload the way the worker would: ask Drive, then go on from there (or start over).
  let state = await drive.uploadStatus(uri);
  let target = uri;
  if (state.state === 'gone') {
    target = await drive.startUpload({ name: `a1-d5-${run}.mp4`, parentId: rootId, size: sample.length, appProperties: { a1: `D5-${run}` } });
    state = { state: 'active', received: 0 };
  }
  let fileId = state.fileId ?? null;
  let offset = state.received ?? 0;
  while (!fileId) {
    const answer = await drive.uploadChunk(target, { offset, bytes: sample.subarray(offset, Math.min(sample.length, offset + 256 * KiB)), total: sample.length });
    offset = answer.received;
    fileId = answer.fileId;
  }
  const d5copy = await drive.getFile(fileId);
  const d5 = { unknownSession: unknownState.state, misplacedChunk: misplaced, afterwards: state.state, md5Matches: d5copy?.md5 === media.small.md5 };
  record('D5', 'Session 失效與錯位的分段', unknownState.state === 'gone' && d5.md5Matches ? 'PASS' : 'FAIL', d5);

  // D6: how long a new file takes to show in searches; reading it by id must work at once.
  const lags = [];
  const one = sample.subarray(0, 256 * KiB);
  for (let i = 0; i < 5; i++) {
    const key = `D6-${run}-${i}`;
    const target6 = await drive.startUpload({ name: `a1-d6-${run}-${i}.bin`, parentId: rootId, size: one.length, appProperties: { providerFileId: key } });
    const { fileId: id6 } = await drive.uploadChunk(target6, { offset: 0, bytes: one, total: one.length });
    const started = Date.now();
    const direct = await drive.getFile(id6);
    let found = null;
    while (Date.now() - started < 60_000) {
      if ((await drive.findByAppProperty('providerFileId', key)).some(file => file.id === id6)) {
        found = Date.now() - started;
        break;
      }
      await sleep(500);
    }
    lags.push({ readById: Boolean(direct), searchVisibleAfterMs: found });
  }
  record('D6', '搜尋延遲（記錄）', lags.every(entry => entry.readById) ? (lags.every(entry => entry.searchVisibleAfterMs != null) ? 'PASS' : 'OBSERVED') : 'FAIL', { lags });

  // D7: the storage quota can be read.
  const quota = await drive.quota();
  const d7 = { limit: quota.limit, usage: quota.usage, freeBytes: quota.limit == null ? null : quota.limit - quota.usage };
  record('D7', '容量查詢', Number.isFinite(quota.usage) && (quota.limit == null || Number.isFinite(quota.limit)) ? 'PASS' : 'FAIL', d7);

  // D8: copies left by earlier attempts converge to the earliest verified one, nothing re-sent.
  const dup = fileOf('small', 'D8', base);
  const putCopy = async bytes => {
    const target8 = await drive.startUpload({ name: `leftover-${run}.mp4`, parentId: monthId, size: bytes.length, appProperties: { providerFileId: dup.id, lessonId: LESSON.id } });
    let at = 0;
    let id8 = null;
    while (!id8) {
      const answer = await drive.uploadChunk(target8, { offset: at, bytes: bytes.subarray(at, Math.min(bytes.length, at + 8 * MiB)), total: bytes.length });
      at = answer.received;
      id8 = answer.fileId;
    }
    return id8;
  };
  const earliest = await putCopy(sample);
  await sleep(1200);
  const later = await putCopy(sample);
  const broken = await putCopy(sample.subarray(0, 256 * KiB));
  const d8worker = await workerFor(drive, rootId, [dup], paths);
  since = Date.now();
  await d8worker.run();
  const kept = d8worker.record(dup.id);
  const d8 = {
    status: kept.status,
    keptEarliest: kept.driveFileId === earliest,
    laterTrashed: (await drive.getFile(later))?.trashed === true,
    brokenTrashed: (await drive.getFile(broken))?.trashed === true,
    uploadsStarted: answers.filter(answer => answer.at >= since && answer.operation === 'startUpload').length,
  };
  record('D8', '重複副本收斂', d8.status === 'STORED' && d8.keptEarliest && d8.laterTrashed && d8.brokenTrashed && d8.uploadsStarted === 0 ? 'PASS' : 'FAIL', d8);

  // D9: Drive's error answers carry the reasons our classification expects.
  const reasonOf = async (url, init) => {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => ({}));
    return { status: response.status, reason: body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null };
  };
  const token = await accessToken();
  const notFound = await reasonOf(`${apiBase}/drive/v3/files/a1-no-such-file?fields=id`, { headers: { Authorization: `Bearer ${token}` } });
  const badToken = await reasonOf(`${apiBase}/drive/v3/about?fields=user`, { headers: { Authorization: 'Bearer a1-invalid-token' } });
  const d9 = {
    notFound: { ...notFound, code: classifyDriveResponse({ status: notFound.status, reason: notFound.reason }).code },
    badToken: { ...badToken, code: classifyDriveResponse({ status: badToken.status, reason: badToken.reason }).code },
    getFileMissing: await drive.getFile('a1-no-such-file'),
  };
  record('D9', '錯誤原因對照', d9.notFound.code === FAILURE.DRIVE_FOLDER_MISSING && d9.badToken.code === FAILURE.DRIVE_AUTH && d9.getFileMissing === null ? 'PASS' : 'FAIL', d9);

  return { results, stopped: false, rootFolderId: rootId };
}

export async function cleanup(config, { apiBase = 'https://www.googleapis.com', endpoints = GOOGLE } = {}) {
  // Every test root, in case search lag ever let a second one be made; each takes its contents.
  const { drive } = connect(config, { apiBase, endpoints });
  const roots = await drive.findFolders('root', ROOT_NAME);
  for (const id of roots) await drive.remove(id);
  const left = await Promise.all(roots.map(id => drive.getFile(id)));
  return { removed: roots.length, rootGone: left.every(entry => entry === null) };
}

async function saveEvidence(dir, name, value) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/ya29\.|1\/\/|upload_id=|refresh_token|access_token/.test(text)) throw new Error('refusing to save evidence that looks like it holds a token or a session URI');
  await writeFile(file, text);
  return file;
}

// --- Self-test against the local stand-in ---------------------------------------------------

export async function selfTest({ log = console.log } = {}) {
  const { startMockDrive } = await import('./mock-drive-server.mjs');
  const mock = await startMockDrive({ account: 'synthetic-tester@example.test', pageSize: 2 });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ihear-a1-selftest-'));
  try {
    const secrets = path.join(dir, 'private');
    await ensurePrivateDir(secrets);
    const config = {
      expectedAccount: 'synthetic-tester@example.test', forbiddenAccounts: ['someone-else@example.test'],
      clientFile: path.join(secrets, 'client.json'), tokenFile: path.join(secrets, 'token.json'), workDir: path.join(dir, 'work'),
    };
    await writeFile(config.clientFile, JSON.stringify({ installed: { client_id: 'mock-client.apps.googleusercontent.com', client_secret: 'mock-not-secret' } }));
    const loaded = await loadConfig(await (async () => { const file = path.join(dir, 'config.json'); await writeFile(file, JSON.stringify(config)); return file; })());
    // The "browser": follows the consent URL back to the loopback listener.
    await authorize({ clientFile: loaded.clientFile, tokenFile: loaded.tokenFile, endpoints: mock.endpoints, openUrl: async url => { await fetch(url); } });
    const media = await makeMedia(path.join(loaded.workDir, 'media'), { useFfmpeg: false });
    const outcome = await runTests(loaded, { apiBase: mock.url, endpoints: mock.endpoints, media, log });
    const cleaned = await cleanup(loaded, { apiBase: mock.url, endpoints: mock.endpoints });
    const revoked = await revokeSaved({ clientFile: loaded.clientFile, tokenFile: loaded.tokenFile, endpoints: mock.endpoints });
    const evidence = await saveEvidence(path.join(loaded.workDir, 'evidence'), 'a1-self-test', { ...outcome, cleaned, revoked });
    const tokenFileGone = !existsSync(loaded.tokenFile);
    return { ...outcome, cleaned, revoked, tokenFileGone, evidence: await readFile(evidence, 'utf8') };
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// --- CLI ----------------------------------------------------------------------------------

async function main() {
  const [command] = process.argv.slice(2);
  const flag = process.argv.indexOf('--config');
  const configFile = flag > 0 ? process.argv[flag + 1] : path.join(process.env.LOCALAPPDATA || os.homedir(), 'iHear-p1-drive-test', 'config.json');
  if (command === 'self-test') {
    const outcome = await selfTest();
    const ok = !outcome.stopped && outcome.results.every(entry => entry.result !== 'FAIL') && outcome.cleaned.rootGone && outcome.revoked.refreshRefused && outcome.tokenFileGone;
    console.log(`\nSELF-TEST ${ok ? 'PASS' : 'FAIL'} (local stand-in of Google; no network, no account)`);
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command === 'init') {
    const value = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
    const account = value('--account');
    if (!account || !/^[^@\s]+@[^@\s]+$/.test(account)) throw new Error('init needs --account <the P1 test account>');
    const home = path.dirname(configFile);
    const secrets = path.join(home, 'private');
    const deny = process.argv.flatMap((arg, i) => (arg === '--deny' ? [process.argv[i + 1]] : [])).filter(Boolean);
    const config = {
      expectedAccount: account, forbiddenAccounts: deny, clientFile: path.join(secrets, 'client.json'), tokenFile: path.join(secrets, 'token.json'), workDir: path.join(home, 'work'),
      // The test account's own browser profile: the consent page opens there, never in the everyday browser.
      ...(value('--browser-profile') ? { browserProfile: value('--browser-profile') } : {}),
    };
    checkConfig(config);
    if (existsSync(configFile)) throw new Error(`${configFile} already exists; edit it or remove it first`);
    await ensurePrivateDir(home);
    await ensurePrivateDir(secrets);
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(`Config: ${configFile}\nPut the downloaded Desktop-client JSON at: ${config.clientFile}`);
    return;
  }
  const config = await loadConfig(configFile);
  if (command === 'auth') {
    await readClient(config.clientFile);
    // With a browser profile configured, the consent page opens straight in it, so the URL (with
    // the client id) does not need to be copied anywhere.
    const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(candidate => existsSync(candidate));
    const openUrl = config.browserProfile && chrome
      ? url => {
        spawn(chrome, [`--user-data-dir=${config.browserProfile}`, '--new-window', url], { detached: true, stdio: 'ignore' }).unref();
        console.log('The consent page is open in the test account\'s browser profile. Waiting for the answer (10 minutes at most)...');
      }
      : url => console.log(`Open this URL in the test account's browser profile:\n${url}\n`);
    const granted = await authorize({ clientFile: config.clientFile, tokenFile: config.tokenFile, openUrl });
    console.log(`Signed in. Scope: ${granted.scope}. The token is saved in the private folder and is not shown.`);
  } else if (command === 'media') {
    const made = await makeMedia(path.join(config.workDir, 'media'));
    for (const [kind, entry] of Object.entries(made)) console.log(`${kind}: ${entry.size} bytes, md5 ${entry.md5}`);
  } else if (command === 'run') {
    const media = JSON.parse(await readFile(path.join(config.workDir, 'media', 'manifest.json'), 'utf8'));
    for (const entry of Object.values(media)) if ((await stat(entry.file)).size !== entry.size) throw new Error(`${entry.file} changed since it was made`);
    const outcome = await runTests(config, { media });
    const file = await saveEvidence(path.join(config.workDir, 'evidence'), 'a1-run', outcome);
    console.log(`\nEvidence: ${file}`);
    process.exitCode = outcome.stopped || outcome.results.some(entry => entry.result === 'FAIL') ? 1 : 0;
  } else if (command === 'cleanup') {
    console.log(JSON.stringify(await cleanup(config)));
  } else if (command === 'revoke') {
    const outcome = await revokeSaved({ clientFile: config.clientFile, tokenFile: config.tokenFile });
    console.log(JSON.stringify(outcome));
    process.exitCode = outcome.refreshRefused ? 0 : 1;
  } else {
    console.log('Commands: init | auth | media | run | cleanup | revoke | self-test   (see the header of this file)');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof FilingError ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}
