// P1 automatic filing, end to end, as one acceptance run on synthetic data:
// recording-completed notice → download → resumable Drive upload → filed → recovery from
// problems. Each step prints what was expected, what happened and PASS or FAIL.
// The Zoom download and Google Drive here are the in-memory stand-ins from the tests; nothing
// connects to Zoom, Google, a database or Vercel. The same steps are the checklist for the real
// run once the test accounts are approved (docs/p1-integration-test-plan.md).
//   node tools/recording-pathway/dryrun/auto-filing-acceptance.mjs
import { createHash } from 'node:crypto';
import { deriveLesson } from '../classroom/lesson-state.mjs';
import { lessonCard } from '../classroom/live-dashboard.mjs';
import { FAILURE, fileRecording, processJobs } from '../classroom/recording-filing.mjs';
import { ingestWebhook, signZoomRequest, storeEvent } from '../classroom/webhook-ingest.mjs';
import { createClassroomStore, createClock, createDrive, createVendor, Killed, killSwitch, syntheticContent } from '../test/fake-classroom-store.mjs';

const SECRET = 'synthetic-webhook-secret-not-real';
const MIN = 60_000;
const START = Date.parse('2026-11-03T02:00:00Z');
const ROOT = 'root:[測試] iHear 錄影存放區';
const CHUNK = 64;
const SIZE = 12 * CHUNK + 17;
const iso = value => new Date(value).toISOString();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const lesson = {
  id: 'L-TEST-901', code: 'TEST-L901', date: '2026-11-03', startsAt: iso(START), endsAt: iso(START + 60 * MIN),
  participants: [{ id: 'P-TEST-T01', code: 'TEST-T01', role: 'tutor' }, { id: 'P-TEST-S01', code: 'TEST-S01', role: 'student' }],
};
const notice = {
  event: 'session.recording_completed',
  event_ts: START + 70 * MIN,
  payload: { object: { id: 'sess-TEST-901', session_id: 'sess-TEST-901', session_key: lesson.id, recording_files: [{
    id: 'f-TEST-901', recording_start: iso(START + MIN), recording_end: iso(START + 59 * MIN), file_type: 'MP4', file_extension: 'MP4',
    file_size: SIZE, status: 'completed', recording_type: 'shared_screen_with_speaker_view',
  }] } },
};

const clock = createClock(START + 70 * MIN);
const store = createClassroomStore({ lessons: [lesson] });
const drive = createDrive({ quotaLimit: 100_000, clock, msPerByte: 50 });
const vendor = createVendor({ clock, msPerByte: 50 });
await store.transaction(tx => storeEvent(tx, { source: 'server', type: 'server.recording_eligibility', lessonId: lesson.id, occurredAt: START - 15 * MIN, receivedAt: START - 15 * MIN, key: 'decide:L-TEST-901', eligible: true }));

const steps = [];
const step = (name, expected, observed, ok) => steps.push({ name, expected, observed, ok: Boolean(ok) });
// Every object with its keys in reverse order: the same notice in different bytes.
const reversed = value => (Array.isArray(value) ? value.map(reversed)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reversed(entry)])) : value);
const deliver = async (body, reorder = false) => {
  const raw = JSON.stringify(reorder ? reversed(body) : body, null, reorder ? 2 : 0);
  const timestamp = Math.floor(clock.now() / 1000);
  return ingestWebhook({ headers: { 'x-zm-request-timestamp': String(timestamp), 'x-zm-signature': signZoomRequest(SECRET, timestamp, raw) }, rawBody: raw, secret: SECRET, now: clock.now(), store });
};
// One serverless call with a time budget; `kill` stops it after that many calls.
const call = async ({ budgetMs = 40_000, kill = null } = {}) => {
  const stop = kill == null ? null : killSwitch(kill);
  const s = stop ? stop.wrap(store) : store;
  const d = stop ? stop.wrap(drive) : drive;
  const download = stop ? stop.wrapFn(vendor.download) : vendor.download;
  const deadline = clock.now() + budgetMs;
  try {
    const results = await processJobs({
      store: s, clock: clock.now, deadline, workerId: 'acceptance',
      handlers: {
        file_recording: ({ job, leaseVersion, clock: time, deadline: until, leaseMs }) => fileRecording({ store: s, drive: d, download, job, leaseVersion, clock: time, deadline: until, leaseMs, rootFolderId: ROOT, options: { chunkBytes: CHUNK } }),
        delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await s.completeJob({ jobId: job.id, leaseVersion })) ? 'VENDOR_COPY_DELETED' : 'LEASE_LOST' }),
      },
    });
    return { results, overran: clock.now() > deadline };
  } catch (error) {
    if (error instanceof Killed) return { results: [{ status: 'KILLED' }], overran: false };
    throw error;
  }
};
const job = () => store.jobs().find(entry => entry.id === 'file:f-TEST-901');
const record = () => store.fileRecord('f-TEST-901');
const card = () => lessonCard(deriveLesson(lesson, store.eventsFor(lesson.id), clock.now()), clock.now());

// 1. The notice arrives.
let answer = await deliver(notice);
step('1 錄影完成通知（簽章正確）', '回 200；1 筆檔案紀錄、1 筆歸檔工作', `HTTP ${answer.status}；檔案 ${store.fileRecords().length}；工作 ${store.jobs().length}`, answer.status === 200 && store.fileRecords().length === 1 && store.jobs().length === 1);
answer = await deliver(notice, true);
step('2 Zoom 重送同一通知（內容順序不同）', '回 200；判定為重複，不新增工作', `HTTP ${answer.status}；重複 ${answer.body.duplicates}；工作 ${store.jobs().length}`, answer.status === 200 && answer.body.duplicates === 1 && store.jobs().length === 1);

// 2. Download and resumable upload over several calls.
let run = await call();
step('3 第 1 次呼叫（時間預算 40 秒）', '傳到一半先存好進度（CONTINUE），不超過截止時間', `${run.results.map(entry => entry.status).join(',')}；Drive 已確認 ${record().uploadedBytes}/${SIZE} bytes；超時 ${run.overran}`, run.results[0]?.status === 'CONTINUE' && record().uploadedBytes > 0 && !run.overran);
const afterFirst = record().uploadedBytes;
clock.advance(1000);
run = await call({ kill: 6 });
step('4 下一次呼叫中途被停止', '什麼都不會寫壞；工作留在資料庫', `${run.results[0].status}；工作狀態 ${job().status}`, run.results[0].status === 'KILLED' && ['running', 'pending'].includes(job().status));
clock.advance(3 * MIN);
run = await call();
step('5 租約到期後的下一次呼叫', '從 Drive 確認的位元組接著傳，沿用同一個上傳 session', `${run.results.map(entry => entry.status).join(',')}；已確認 ${record().uploadedBytes} bytes；session 數 ${drive.counters.sessionsStarted}`, record().uploadedBytes > afterFirst && drive.counters.sessionsStarted === 1);

// 3. Problems and recovery.
drive.failNext('uploadChunk', FAILURE.TRANSIENT);
clock.advance(1000);
run = await call();
step('6 Drive 回 5xx', '退避後重試；session 保留', `${run.results.map(entry => `${entry.status}/${entry.reason ?? ''}`).join(',')}；下次可領取 ${Math.round((job().availableAt - clock.now()) / 1000)} 秒後；session ${record().uploadSessionUri ? '保留' : '作廢'}`, run.results[0]?.status === 'RETRY' && job().availableAt > clock.now() && record().uploadSessionUri);
clock.advance(MIN);
drive.faults.otherUsage = 100_000 - 50;
const attemptsBefore = job().attempts;
run = await call();
const blocked = card();
step('7 Drive 空間不足（403 storageQuotaExceeded）', '暫停、不消耗重試次數；總覽顯示原因；session 作廢；Zoom 副本保留', `${run.results.map(entry => `${entry.status}/${entry.reason ?? ''}`).join(',')}；嘗試次數 ${attemptsBefore} → ${job().attempts}；總覽「${blocked.filing.label}（${blocked.filing.reasonLabel}）」；session ${record().uploadSessionUri ? '保留' : '作廢'}；刪除 Zoom 工作 ${store.jobs().filter(entry => entry.type === 'delete_vendor_copy').length}`,
  run.results[0]?.status === 'BLOCKED' && job().attempts === attemptsBefore && blocked.filing.reasonLabel === '雲端硬碟空間不足' && !record().uploadSessionUri && !store.jobs().some(entry => entry.type === 'delete_vendor_copy'));
clock.advance(10 * MIN);
run = await call();
step('8 暫停中，30 分鐘內', '不重試', `領到的工作 ${run.results.length}`, run.results.length === 0);
drive.faults.otherUsage = 0;
clock.advance(21 * MIN);
for (let i = 0; i < 20 && store.jobs().some(entry => entry.status === 'pending' || entry.status === 'running'); i++) {
  run = await call();
  clock.advance(1000);
}
const resumed = store.events().some(event => event.type === 'p1.filing' && event.status === 'RESUMED');
step('9 管理員釋放空間後', '自動恢復，開新的 session 從頭傳，完成歸檔', `RESUMED ${resumed}；狀態 ${record().status}；session 數 ${drive.counters.sessionsStarted}`, resumed && record().status === 'STORED' && drive.counters.sessionsStarted === 2);

// 4. The result.
const copies = drive.activeFiles().filter(file => file.appProperties.providerFileId === 'f-TEST-901');
const filedHash = copies.length ? sha256(drive.contentOf(copies[0].id)) : '';
const zoomHash = sha256(syntheticContent('f-TEST-901', 0, SIZE));
step('10 歸檔結果', '只有一份；P1 命名；月份資料夾；內容與 Zoom 完全相同', `${copies.length} 份；${copies[0]?.name}；${drive.folderName(copies[0]?.parentId)}；SHA-256 ${filedHash.slice(0, 12)}…${filedHash === zoomHash ? ' 相同' : ' 不同'}`,
  copies.length === 1 && copies[0].name === '2026-11-03_TEST-S01_TEST-T01_P01.mp4' && drive.folderName(copies[0].parentId) === '[iHear] 11.2026.Zoom Recordings' && filedHash === zoomHash);
const stored = store.events().filter(event => event.type === 'p1.filing' && event.status === 'STORED').length;
const deletion = store.jobs().find(entry => entry.type === 'delete_vendor_copy');
step('11 刪除 Zoom 副本', '只在 STORED 之後，且只有一次', `STORED 紀錄 ${stored}；刪除工作 ${deletion?.status ?? '無'}`, stored === 1 && deletion?.status === 'done');
const finalCard = card();
step('12 總覽', '已歸檔；暫停異常已解除；沒有歸檔延遲', `「${finalCard.filing.label}」；歸檔相關異常 ${finalCard.anomalies.filter(entry => /^(FILING|PART)_/.test(entry.code)).map(entry => entry.code).join(',') || '無'}`,
  finalCard.filing.status === 'STORED' && !finalCard.anomalies.some(entry => ['FILING_BLOCKED', 'FILING_DELAYED', 'FILING_FAILED'].includes(entry.code)));

console.log('P1 自動歸檔驗收流程（合成邏輯檢查：沒有連到 Zoom、Google Drive、資料庫或 Vercel）\n');
for (const entry of steps) console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}\n      預期：${entry.expected}\n      結果：${entry.observed}`);
const failed = steps.filter(entry => !entry.ok).length;
console.log(`\n${steps.length - failed}/${steps.length} PASS`);
process.exitCode = failed ? 1 : 0;
