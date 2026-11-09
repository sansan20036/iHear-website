// Synthetic-data tests for the recording upload pathway. Every file is a fake video
// (a few bytes) inside the in-memory Drive from fake-google.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createEnvironment } from './fake-google.mjs';

const require = createRequire(import.meta.url);
const core = require('../apps-script/Core.js');
const DEST = 'DESTFOLDER000001';
const GiB = 1024 ** 3;
const byStatus = (env, status) => env.log().filter(row => row.status === status);

test('file names are standard, safe and numbered by part', () => {
  assert.equal(core.fileName(core.baseName('2026-10-23', ' 王 小明 ', 'Alex  Chen'), 1, 'mp4'), '2026-10-23_王 小明_Alex Chen_P01.mp4');
  assert.equal(core.cleanName('a/b:c*?"<>|d'), 'a-b-c------d');
  assert.equal(core.cleanName('..王小明..'), '王小明');
  assert.equal(core.cleanName('x'.repeat(80)).length, 40);
  assert.throws(() => core.cleanName('  '), /空白/);
  assert.throws(() => core.lessonDate('2026-02-30'), /不存在/);
  assert.throws(() => core.lessonDate('10/23/2026'), /YYYY-MM-DD/);
  assert.equal(core.fileName('base', 12, 'mp4'), 'base_P12.mp4');
  assert.equal(core.nextPart(['b_P01.mp4', 'b_P02.mp4'], () => false, 'b', 'mp4'), 3);
  assert.equal(core.nextPart([], name => name === 'b_P01.mp4', 'b', 'mp4'), 2);
  assert.equal(core.extensionOf('video123.MP4', 'video/mp4'), 'mp4');
  assert.equal(core.extensionOf('video123 - Test Tutor.mov', 'video/quicktime'), 'mov');
  assert.equal(core.extensionOf('notes.pdf', 'application/pdf'), null);
  assert.equal(core.extensionOf('fake.mp4', 'application/pdf'), null);
  assert.equal(core.monthlyFolderName('2026-01-05'), '[iHear] 01.2026.Zoom Recordings');
});

test('settings are validated, and live mode needs alert recipients and a retention decision', () => {
  assert.deepEqual(core.validateConfig({ DEST_FOLDER_ID: DEST }), []);
  assert.equal(core.validateConfig({ DEST_FOLDER_ID: 'bad id', RETENTION_DAYS: '0', NAME_MODE: 'x' }).length, 3);
  assert.equal(core.validateConfig({ DEST_FOLDER_ID: DEST, MODE: 'demo', TEST_FAULT: 'x', STORAGE_WARN_PERCENT: '100', ADMIN_EMAILS: 'a@b.org, nope' }).length, 4);
  assert.deepEqual(core.validateConfig({ MODE: 'live', DEST_FOLDER_ID: DEST }), [
    '正式模式必須設定 ADMIN_EMAILS，才收得到異常通知', '正式模式必須先決定 RETENTION_DAYS（保存天數）',
  ]);
  assert.match(core.validateConfig({ MODE: 'live', DEST_FOLDER_ID: DEST, ADMIN_EMAILS: 'a@b.org', RETENTION_DAYS: '180', TEST_FAULT: 'move' }).join(), /TEST_FAULT/);
  assert.deepEqual(core.testModeProblems('[測試] iHear 錄影存放區', [{ code: 'TEST-S01' }]), []);
  assert.equal(core.testModeProblems('[iHear] 10.2026.Zoom Recordings', [{ code: 'S001' }]).length, 2);
});

test('one recording is renamed into the default folder and logged as stored', () => {
  const env = createEnvironment();
  const fileId = env.upload('video1234567.mp4');
  env.submit({ fileIds: [fileId] });
  const [row] = env.log();
  assert.equal(row.status, 'STORED');
  assert.equal(row.plannedName, '2026-10-23_王小明_陳小老師_P01.mp4');
  assert.equal(row.lessonDate, '2026-10-23');
  assert.equal(row.uploader, 'tutor@example.org');
  assert.equal(row.receivedAt, '2026-10-23 15:00:00');
  assert.equal(row.size > 0, true);
  assert.match(row.md5, /^[0-9a-f]{32}$/);
  assert.deepEqual(env.filesIn(DEST), ['2026-10-23_王小明_陳小老師_P01.mp4']);
  assert.equal(env.mail.length, 0);
});

test('Code.js works even when Apps Script loads it before Core.js', () => {
  const env = createEnvironment({ loadOrder: ['Code.js', 'Core.js'] });
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].status, 'STORED');
});

test('several segments of one lesson keep their order, and a later upload continues the numbering', () => {
  const env = createEnvironment();
  env.submit({ fileIds: [env.upload('video111.mp4', 'a'), env.upload('video222.mp4', 'b'), env.upload('audio333.m4a', 'c')] });
  env.submit({ fileIds: [env.upload('video444.mp4', 'd')] });
  env.submit({ tutor: 'Alex Chen', fileIds: [env.upload('video555.mp4', 'e')] });
  assert.deepEqual(env.log().map(row => row.plannedName), [
    '2026-10-23_王小明_陳小老師_P01.mp4', '2026-10-23_王小明_陳小老師_P02.mp4', '2026-10-23_王小明_陳小老師_P03.m4a',
    '2026-10-23_王小明_陳小老師_P04.mp4', '2026-10-23_王小明_Alex Chen_P01.mp4',
  ]);
  assert.equal(byStatus(env, 'STORED').length, 5);
});

test('an existing file with the same name is never overwritten or duplicated', () => {
  const env = createEnvironment();
  const manual = env.upload('2026-10-23_王小明_陳小老師_P01.mp4', 'manual copy');
  env.file(manual).parents = new Set([DEST]);
  env.submit({ fileIds: [env.upload('video1.mp4', 'new')] });
  assert.equal(env.log()[0].plannedName, '2026-10-23_王小明_陳小老師_P02.mp4');
  assert.deepEqual(env.filesIn(DEST), ['2026-10-23_王小明_陳小老師_P01.mp4', '2026-10-23_王小明_陳小老師_P02.mp4']);
});

test('the same video uploaded twice is held as a duplicate, not stored again', () => {
  const env = createEnvironment();
  env.submit({ fileIds: [env.upload('video1.mp4', 'same bytes')] });
  env.submit({ fileIds: [env.upload('video1 (1).mp4', 'same bytes')] });
  const [first, second] = env.log();
  assert.equal(first.status, 'STORED');
  assert.equal(second.status, 'DUPLICATE');
  assert.match(second.error, /P01/);
  assert.deepEqual(env.filesIn(DEST), ['2026-10-23_王小明_陳小老師_P01.mp4']);
  assert.deepEqual(env.filesIn(env.childFolderId(DEST, '_待確認')), ['video1 (1).mp4']);
});

test('a repeated trigger or rerun changes nothing', () => {
  const env = createEnvironment();
  const fileId = env.upload('video1.mp4');
  const responseId = env.submit({ fileIds: [fileId] });
  const before = JSON.stringify(env.log());
  env.submit({ id: responseId, fileIds: [fileId] });
  env.app.processQueue();
  assert.equal(JSON.stringify(env.log()), before);
  assert.match(env.toasts.at(-1), /補登 0 筆、處理 0 筆/);
});

test('a file logged twice by racing triggers is stored once and never pulled into quarantine', () => {
  const env = createEnvironment();
  const fileId = env.upload('video1.mp4');
  const responseId = env.submit({ fileIds: [fileId] });
  assert.equal(env.app.appendRows_(env.app.openLog_(), [{ uploadKey: `other:${fileId}`, fileId, status: 'RECEIVED' }]), 0);
  // What a race between two trigger runs could leave behind: a second row for the same file.
  env.sheets.get('上傳紀錄').appendRow(env.app.toValues_({
    uploadKey: `${responseId}:${fileId}`, lessonDate: '2026-10-23', student: '王小明', tutor: '陳小老師', fileId, status: 'RECEIVED', attempts: 0,
  }));
  env.app.processQueue();
  const [first, second] = env.log();
  assert.equal(first.status, 'STORED');
  assert.equal(second.status, 'DUPLICATE');
  assert.match(second.error, /第 2 列/);
  assert.deepEqual(env.filesIn(DEST), ['2026-10-23_王小明_陳小老師_P01.mp4']);
  assert.equal(env.childFolderId(DEST, '_待確認'), undefined);
});

test('a submission whose trigger never ran is picked up by the next run within 14 days', () => {
  const env = createEnvironment();
  env.submit({ fileIds: [env.upload('video1.mp4')], trigger: false });
  assert.equal(env.log().length, 0);
  assert.equal(env.app.processQueue().caughtUp, 1);
  assert.equal(env.log()[0].status, 'STORED');
  const late = createEnvironment();
  late.submit({ fileIds: [late.upload('video1.mp4')], trigger: false });
  late.now = new Date(late.now.getTime() + 15 * 86400000);
  assert.equal(late.app.processQueue().caughtUp, 0);
});

test('a busy lock never loses a submission', () => {
  const env = createEnvironment();
  env.locked = true;
  const fileId = env.upload('video1.mp4');
  env.submit({ fileIds: [fileId] });
  assert.equal(env.log().length, 0);
  assert.deepEqual([...env.file(fileId).parents], ['FORMUPLOADS00001']);
  env.locked = false;
  env.app.processQueue();
  assert.equal(env.log()[0].status, 'STORED');
});

test('a run that has used its time budget leaves the rest for the next run', () => {
  const env = createEnvironment();
  env.submit({ fileIds: [env.upload('a.mp4', 'a')], trigger: false });
  env.submit({ fileIds: [env.upload('b.mp4', 'b')], trigger: false });
  env.app.RUN_BUDGET_MS = -1;
  assert.equal(env.app.processQueue().deferred, 2);
  assert.deepEqual(env.log().map(row => row.status), ['RECEIVED', 'RECEIVED']);
  env.app.RUN_BUDGET_MS = 270000;
  env.app.processQueue();
  assert.deepEqual(env.log().map(row => row.status), ['STORED', 'STORED']);
});

test('a failed move is retried with the same planned name', () => {
  const env = createEnvironment();
  env.failures.moveTo = 1;
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  let [row] = env.log();
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 1);
  assert.match(row.error, /moveTo/);
  assert.equal(row.plannedName, '2026-10-23_王小明_陳小老師_P01.mp4');
  env.app.processQueue();
  [row] = env.log();
  assert.equal(row.status, 'STORED');
  assert.equal(row.attempts, 2);
  assert.deepEqual(env.filesIn(DEST), ['2026-10-23_王小明_陳小老師_P01.mp4']);
});

test('a failure after the move but before the rename is completed safely on retry', () => {
  const env = createEnvironment();
  env.failures.setName = 1;
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].status, 'FAILED');
  assert.deepEqual(env.filesIn(DEST), ['video1.mp4']);
  env.app.processQueue();
  assert.equal(env.log()[0].status, 'STORED');
  assert.deepEqual(env.filesIn(DEST), ['2026-10-23_王小明_陳小老師_P01.mp4']);
});

test('TEST_FAULT makes one step fail on purpose until it is cleared', () => {
  for (const fault of ['move', 'rename', 'md5']) {
    const env = createEnvironment({ config: { TEST_FAULT: fault } });
    env.submit({ fileIds: [env.upload('video1.mp4')] });
    assert.equal(env.log()[0].status, 'FAILED');
    assert.match(env.log()[0].error, new RegExp(`TEST_FAULT=${fault}`));
    env.setConfig('TEST_FAULT', '');
    env.app.processQueue();
    assert.equal(env.log()[0].status, 'STORED');
    assert.deepEqual(env.filesIn(DEST), ['2026-10-23_王小明_陳小老師_P01.mp4']);
  }
});

test('retries stop at MAX_ATTEMPTS and admins are told once, without names', () => {
  const env = createEnvironment();
  env.failures.md5 = 99;
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  env.app.processQueue();
  env.app.processQueue();
  env.app.processQueue();
  const [row] = env.log();
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 3);
  assert.equal(env.mail.length, 1);
  assert.match(env.mail[0].subject, /^\[iHear 錄影上傳\]\[測試\] 錄影上傳多次失敗$/);
  assert.doesNotMatch(env.mail[0].body, /王小明|陳小老師/);
});

test('a failed notification email does not stop processing', () => {
  const env = createEnvironment();
  env.failures.mail = 99;
  env.submit({ student: '林小華', fileIds: [env.upload('video1.mp4', 'a')] });
  env.submit({ fileIds: [env.upload('video2.mp4', 'b')] });
  assert.deepEqual(env.log().map(row => row.status), ['NO_CONSENT', 'STORED']);
  assert.match(env.errors[0], /通知寄送失敗/);
});

test('a missing upload is reported as failed', () => {
  const env = createEnvironment();
  const fileId = env.upload('video1.mp4');
  env.file(fileId).deleted = true;
  env.submit({ fileIds: [fileId] });
  assert.equal(env.log()[0].status, 'FAILED');
  assert.match(env.log()[0].error, /No item/);
});

test('without recorded consent the file is held for an admin and never filed', () => {
  const env = createEnvironment();
  env.submit({ student: '林小華', fileIds: [env.upload('video1.mp4')] });
  env.submit({ student: '名單外學生', fileIds: [env.upload('video2.mp4', 'other')] });
  assert.deepEqual(env.log().map(row => row.status), ['NO_CONSENT', 'NO_CONSENT']);
  assert.deepEqual(env.filesIn(DEST), []);
  assert.deepEqual(env.filesIn(env.childFolderId(DEST, '_待確認')), ['video1.mp4', 'video2.mp4']);
  assert.equal(env.mail.length, 2);
  assert.doesNotMatch(env.mail.map(mail => mail.body).join(), /林小華|名單外學生/);
});

test('a held recording can be queued again once consent is recorded', () => {
  const env = createEnvironment();
  env.submit({ student: '林小華', fileIds: [env.upload('video1.mp4')] });
  env.sheets.get('學生名單').data[2][2] = '已同意';
  const log = env.app.openLog_();
  Object.assign(log.rows[0], { status: 'RECEIVED', attempts: 0 });
  env.app.save_(log, log.rows[0]);
  env.app.processQueue();
  assert.equal(env.log()[0].status, 'STORED');
  assert.deepEqual(env.filesIn(DEST), ['2026-10-23_林小華_陳小老師_P01.mp4']);
  assert.deepEqual(env.filesIn(env.childFolderId(DEST, '_待確認')), []);
});

test('held items marked HANDLED drop out of the daily follow-up', () => {
  const env = createEnvironment();
  env.submit({ student: '林小華', fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.app.dailyReport().needsReview, 1);
  const log = env.app.openLog_();
  log.rows[0].status = 'HANDLED';
  env.app.save_(log, log.rows[0]);
  const mails = env.mail.length;
  assert.equal(env.app.dailyReport().needsReview, 0);
  assert.equal(env.mail.length, mails);
});

test('non-recording files are held as invalid', () => {
  const env = createEnvironment();
  env.submit({ fileIds: [env.upload('lesson-notes.pdf')] });
  assert.equal(env.log()[0].status, 'INVALID');
  assert.deepEqual(env.filesIn(env.childFolderId(DEST, '_待確認')), ['lesson-notes.pdf']);
});

test('a lesson taught without recording is logged with its reason', () => {
  const env = createEnvironment();
  env.submit({ student: '林小華', recorded: false, reason: '家長未同意錄影' });
  const [row] = env.log();
  assert.equal(row.status, 'NOT_RECORDED');
  assert.equal(row.reason, '家長未同意錄影');
  assert.equal(row.fileId, '');
});

test('an impossible or future lesson date is held and its file left untouched', () => {
  const env = createEnvironment();
  const impossible = env.upload('video1.mp4', 'a');
  const future = env.upload('video2.mp4', 'b');
  env.submit({ date: '2026-02-30', fileIds: [impossible] });
  env.submit({ date: '2026-10-24', fileIds: [future] });
  assert.deepEqual(env.log().map(row => row.status), ['INVALID', 'INVALID']);
  assert.match(env.log()[0].error, /不存在/);
  assert.match(env.log()[1].error, /晚於今天/);
  assert.deepEqual([...env.file(impossible).parents], ['FORMUPLOADS00001']);
  assert.deepEqual([...env.file(future).parents], ['FORMUPLOADS00001']);
});

test('a 150 MB recording is filed from its metadata alone', () => {
  const env = createEnvironment();
  env.submit({ fileIds: [env.upload('video1.mp4', 'big', undefined, { size: 150 * 1024 * 1024 })] });
  assert.equal(env.log()[0].status, 'STORED');
  assert.equal(env.log()[0].size, 157286400);
});

test('an unusable destination pauses processing until fixed', () => {
  const env = createEnvironment({ config: { DEST_FOLDER_ID: 'MISSINGFOLDER0001' } });
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].status, 'RECEIVED');
  assert.match(env.mail[0].body, /無法存取/);
  env.setConfig('DEST_FOLDER_ID', DEST);
  env.app.processQueue();
  assert.equal(env.log()[0].status, 'STORED');
});

test('a paused queue emails the same problem once a day, and again when it comes back', () => {
  const env = createEnvironment({ config: { DEST_FOLDER_ID: 'MISSINGFOLDER0001' } });
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  env.app.processQueue();
  env.app.processQueue();
  assert.equal(env.mail.length, 1);
  env.now = new Date(env.now.getTime() + 25 * 3600000);
  env.app.processQueue();
  assert.equal(env.mail.length, 2);
  env.setConfig('DEST_FOLDER_ID', DEST);
  env.app.processQueue();
  assert.equal(env.log()[0].status, 'STORED');
  env.setConfig('DEST_FOLDER_ID', 'MISSINGFOLDER0001');
  env.app.processQueue();
  assert.equal(env.mail.length, 3);
});

test('a publicly shared destination is refused and its sharing is not changed', () => {
  const env = createEnvironment({ sharing: 'ANYONE_WITH_LINK' });
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].status, 'RECEIVED');
  assert.match(env.mail[0].body, /知道連結/);
  assert.equal(env.folders.get(DEST).access, 'ANYONE_WITH_LINK');
  assert.deepEqual(env.app.checkSettings().length, 1);
});

test('domain-wide sharing is refused like public sharing', () => {
  const env = createEnvironment({ sharing: 'DOMAIN_WITH_LINK' });
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].status, 'RECEIVED');
  assert.match(env.mail[0].body, /機構內知道連結的人/);
});

test('a form without one of the required questions pauses processing', () => {
  const env = createEnvironment();
  env.removeFormItem('錄影檔');
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].status, 'RECEIVED');
  assert.match(env.mail[0].body, /表單缺少題目：錄影檔/);
});

test('test mode only runs on a [測試] folder with synthetic students, and never names anyone', () => {
  const env = createEnvironment({ destName: '[iHear] Zoom Recordings' });
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].status, 'RECEIVED');
  assert.match(env.mail[0].body, /\[測試\]/);
  const roster = createEnvironment({ students: [['王小明', 'S001', '已同意', '', ''], ['林小華', 'TEST-S002', '已同意', '', '']] });
  const problems = roster.app.checkSettings();
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 位學生/);
  assert.doesNotMatch(problems[0], /王小明/);
});

test('live mode files real recordings with no test guards and plain email subjects', () => {
  const env = createEnvironment({
    destName: '[iHear] Zoom Recordings', students: [['王小明', 'S001', '已同意', '', '']], config: { MODE: 'live', RETENTION_DAYS: '180' },
  });
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].status, 'STORED');
  env.submit({ student: '名單外', fileIds: [env.upload('video2.mp4', 'x')] });
  assert.match(env.mail[0].subject, /^\[iHear 錄影上傳\] 收到/);
});

test('an admin can change the destination; new uploads follow it and stored files stay', () => {
  const env = createEnvironment();
  env.submit({ fileIds: [env.upload('video1.mp4', 'a')] });
  const novemberId = env.addFolder('[測試] 11 月錄影', null, 'PRIVATE', 'NOVEMBERFOLDER01');
  env.setConfig('DEST_FOLDER_ID', novemberId);
  env.submit({ date: '2026-10-02', fileIds: [env.upload('video2.mp4', 'b')] });
  assert.deepEqual(env.filesIn(DEST), ['2026-10-23_王小明_陳小老師_P01.mp4']);
  assert.deepEqual(env.filesIn(novemberId), ['2026-10-02_王小明_陳小老師_P01.mp4']);
});

test('monthly subfolders are created once and reused', () => {
  const env = createEnvironment({ config: { MONTHLY_SUBFOLDER: 'on' } });
  env.submit({ fileIds: [env.upload('video1.mp4', 'a')] });
  env.submit({ date: '2026-10-22', fileIds: [env.upload('video2.mp4', 'b')] });
  env.submit({ date: '2026-09-30', fileIds: [env.upload('video3.mp4', 'c')] });
  const october = env.childFolderId(DEST, '[iHear] 10.2026.Zoom Recordings');
  assert.deepEqual(env.filesIn(october), ['2026-10-22_王小明_陳小老師_P01.mp4', '2026-10-23_王小明_陳小老師_P01.mp4']);
  assert.deepEqual(env.filesIn(env.childFolderId(DEST, '[iHear] 09.2026.Zoom Recordings')), ['2026-09-30_王小明_陳小老師_P01.mp4']);
  assert.equal([...env.folders.values()].filter(folder => folder.parent === DEST && folder.name.includes('10.2026')).length, 1);
});

test('code mode keeps student names out of file names', () => {
  const env = createEnvironment({ config: { NAME_MODE: 'code' } });
  env.submit({ student: 'Emma Lee', fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].plannedName, '2026-10-23_TEST-S003_陳小老師_P01.mp4');
});

test('retention only marks old recordings; trashing needs an admin 是 per row', () => {
  const env = createEnvironment({ config: { RETENTION_DAYS: '90' } });
  env.submit({ date: '2026-06-01', fileIds: [env.upload('old1.mp4', 'a')] });
  env.submit({ date: '2026-06-02', fileIds: [env.upload('old2.mp4', 'b')] });
  env.submit({ date: '2026-10-20', fileIds: [env.upload('recent.mp4', 'c')] });
  assert.equal(env.app.reviewRetention().marked, 2);
  assert.equal(env.app.trashConfirmed().trashed, 0);
  const log = env.app.openLog_();
  log.rows[0].confirmDelete = '是';
  env.app.save_(log, log.rows[0]);
  assert.equal(env.app.trashConfirmed().trashed, 1);
  assert.deepEqual(env.log().map(row => row.status), ['TRASHED', 'RETENTION_DUE', 'STORED']);
  assert.equal(env.file(env.log()[0].fileId).trashed, true);
  assert.equal(env.file(env.log()[1].fileId).trashed, false);
});

test('a due recording that was renamed, moved or replaced is not trashed', () => {
  const env = createEnvironment({ config: { RETENTION_DAYS: '90' } });
  env.submit({ date: '2026-06-01', fileIds: [env.upload('a.mp4', 'a'), env.upload('b.mp4', 'b'), env.upload('c.mp4', 'c')] });
  env.app.reviewRetention();
  const [renamed, moved, replaced] = env.log().map(row => env.file(row.fileId));
  renamed.name = 'renamed.mp4';
  moved.parents = new Set(['FORMUPLOADS00001']);
  replaced.bytes = Buffer.from('other content');
  const log = env.app.openLog_();
  log.rows.forEach(row => { row.confirmDelete = '是'; env.app.save_(log, row); });
  const result = env.app.trashConfirmed();
  assert.equal(result.trashed, 0);
  assert.equal(result.refused, 3);
  assert.deepEqual(env.log().map(row => row.status), ['RETENTION_DUE', 'RETENTION_DUE', 'RETENTION_DUE']);
  assert.match(env.log().map(row => row.error).join(), /檔名被改成.*被移出.*內容和紀錄不符/s);
  assert.equal([renamed, moved, replaced].some(file => file.trashed), false);
});

test('retention is off until RETENTION_DAYS is set', () => {
  const env = createEnvironment();
  env.submit({ date: '2025-01-01', fileIds: [env.upload('old.mp4')] });
  assert.match(env.app.reviewRetention().skipped, /RETENTION_DAYS/);
  assert.equal(env.log()[0].status, 'STORED');
});

test('a file ID typed into the log by hand is never moved, renamed or trashed', () => {
  const env = createEnvironment({ config: { RETENTION_DAYS: '30' } });
  const decoy = env.upload('Zoom 錄影 0918.mp4', 'stand-in for a real recording', undefined, { folderId: DEST });
  const other = env.upload('video 0919.mp4', 'another stand-in', undefined, { folderId: DEST });
  const responseId = env.submit({ fileIds: [env.upload('video1.mp4')] });
  env.app.appendRows_(env.app.openLog_(), [
    { uploadKey: 'MANUAL:1', lessonDate: '2026-10-22', student: '王小明', tutor: '陳小老師', fileId: decoy, status: 'RECEIVED', attempts: 0 },
    { uploadKey: `${responseId}:typed`, lessonDate: '2026-10-22', student: '王小明', tutor: '陳小老師', fileId: other, status: 'RECEIVED', attempts: 0 },
  ]);
  env.app.processQueue();
  assert.deepEqual(env.log().map(row => row.status), ['STORED', 'INVALID', 'INVALID']);
  assert.match(env.log()[1].error, /不是透過本表單上傳/);
  const log = env.app.openLog_();
  Object.assign(log.rows[1], { status: 'RETENTION_DUE', confirmDelete: '是' });
  env.app.save_(log, log.rows[1]);
  assert.equal(env.app.trashConfirmed().refused, 1);
  for (const id of [decoy, other]) {
    assert.equal(env.file(id).writes, 0);
    assert.equal(env.file(id).trashed, false);
  }
});

test('recordings already in the destination are never moved, renamed or trashed by any routine', () => {
  const env = createEnvironment({ config: { MONTHLY_SUBFOLDER: 'on', RETENTION_DAYS: '30' } });
  const existing = ['Zoom 0923 學生.mp4', 'video1234567.mp4', '[iHear] 10.2026.Zoom Recordings.mp4']
    .map(name => env.upload(name, `existing ${name}`, undefined, { folderId: DEST }));
  env.submit({ date: '2026-08-01', fileIds: [env.upload('old.mp4', 'old')] });
  env.submit({ fileIds: [env.upload('new.mp4', 'new')] });
  env.submit({ fileIds: [env.upload('copy.mp4', 'new')] });
  env.submit({ student: '林小華', fileIds: [env.upload('no-consent.mp4', 'nc')] });
  env.submit({ fileIds: [env.upload('notes.pdf', 'pdf')] });
  env.app.dailyReport();
  env.app.reviewRetention();
  const log = env.app.openLog_();
  log.rows.forEach(row => { row.confirmDelete = '是'; env.app.save_(log, row); });
  env.app.trashConfirmed();
  env.app.syncFormChoices();
  env.app.checkSettings();
  env.app.processQueue();
  for (const id of existing) {
    assert.equal(env.file(id).writes, 0);
    assert.deepEqual([...env.file(id).parents], [DEST]);
    assert.equal(env.file(id).trashed, false);
  }
  assert.equal(env.file(env.log()[0].fileId).trashed, true);
});

test('the script has no code that changes sharing, deletes for good, copies, lists Drive or reads file contents', () => {
  const source = readFileSync(new URL('../apps-script/Code.js', import.meta.url), 'utf8');
  for (const pattern of [
    /setSharing|addEditor|addViewer|removeEditor|removeViewer|Permissions/,
    /Files\.(remove|delete|emptyTrash)|setTrashed\(false\)|removeFile|makeCopy/,
    /getBlob|getAs\(|UrlFetchApp|setContent/,
    /DriveApp\.(getFiles|searchFiles|getFolders|searchFolders)\b/,
  ]) assert.doesNotMatch(source, pattern);
  assert.equal(source.match(/setTrashed\(true\)/g).length, 1);
});

test('Drive usage is reported daily and warned about at the threshold, without pausing uploads', () => {
  const env = createEnvironment();
  env.storage = { used: 12.5 * GiB, limit: 15 * GiB };
  env.submit({ fileIds: [env.upload('video1.mp4')] });
  assert.equal(env.log()[0].status, 'STORED');
  assert.equal(env.app.dailyReport().storage.warning, true);
  assert.match(env.mail.at(-1).body, /雲端硬碟用量已達 83.3%/);
  assert.equal(env.sheets.get('每日核對').data[1][6], '12.5 GB / 15.0 GB（83.3%）');
  env.storage = { used: GiB, limit: 0 };
  assert.equal(env.app.dailyReport().storage.text, '無法取得容量上限');
});

test('the daily check finds stored recordings that were renamed, moved or trashed by hand', () => {
  const env = createEnvironment();
  env.submit({ fileIds: [env.upload('a.mp4', 'a'), env.upload('b.mp4', 'b'), env.upload('c.mp4', 'c'), env.upload('d.mp4', 'd')] });
  const [renamed, moved, trashed] = env.log().map(row => env.file(row.fileId));
  renamed.name = 'renamed by hand.mp4';
  moved.parents = new Set(['FORMUPLOADS00001']);
  trashed.trashed = true;
  const report = env.app.dailyReport();
  assert.equal(report.stored, 4);
  assert.equal(report.anomalies.length, 3);
  assert.equal(env.sheets.get('每日核對').data.length, 2);
  assert.match(env.mail.at(-1).subject, /每日核對/);
});

test('setup fills safe default settings and installs three triggers once; removeTriggers stops them', () => {
  const env = createEnvironment();
  env.app.setup();
  env.app.setup();
  assert.deepEqual(env.triggers.map(trigger => `${trigger.handler} ${trigger.kind}`), [
    'onFormSubmit formSubmit', 'processQueue every 15 minutes', 'dailyReport daily at 22',
  ]);
  const keys = env.sheets.get('設定').data.map(row => row[0]);
  for (const key of ['MODE', 'STORAGE_WARN_PERCENT', 'TEST_FAULT', 'DEST_FOLDER_ID']) assert.equal(keys.filter(name => name === key).length, 1);
  assert.equal(env.app.readConfig_().MODE, 'test');
  assert.equal(env.app.removeTriggers().removed, 3);
  assert.equal(env.triggers.length, 0);
  env.formUrl = null;
  assert.throws(() => env.app.setup(), /連結表單/);
});

test('authorizing (prepareSheets) installs no triggers, and a partial permission grant stops before anything is created', () => {
  const env = createEnvironment();
  env.missingScopes = true;
  assert.throws(() => env.app.prepareSheets(), /需要授權/);
  assert.throws(() => env.app.setup(), /需要授權/);
  assert.equal(env.sheets.get('設定').data.some(row => row[0] === 'MODE'), false);
  assert.equal(env.triggers.length, 0);
  env.missingScopes = false;
  env.app.prepareSheets();
  assert.equal(env.app.readConfig_().MODE, 'test');
  assert.equal(env.triggers.length, 0);
  env.app.setup();
  assert.equal(env.triggers.length, 3);
});

test('when another run holds the lock, a manual run says so and touches nothing', () => {
  const env = createEnvironment();
  env.submit({ fileIds: [env.upload('video1.mp4')], trigger: false });
  env.locked = true;
  assert.match(env.app.processQueue().skipped, /另一個處理程序/);
  assert.equal(env.log().length, 0);
});

test('Sheets cannot turn dates, IDs or checksums into dates or numbers', () => {
  const env = createEnvironment();
  const log = env.app.openLog_();
  env.app.appendRows_(log, [{ uploadKey: '123:456', lessonDate: '2026-10-23', fileId: '1234567890', md5: '123e4567', status: 'RECEIVED', attempts: 0 }]);
  const [row] = env.log();
  assert.equal(row.uploadKey, '123:456');
  assert.equal(row.lessonDate, '2026-10-23');
  assert.equal(row.fileId, '1234567890');
  assert.equal(row.md5, '123e4567');
  // A date typed by hand into the sheet comes back as a Date and is read as the same day.
  env.sheets.get('上傳紀錄').data[1][3] = new env.RealmDate('2026-10-23T00:00:00+08:00');
  assert.equal(env.app.dateText_(env.sheets.get('上傳紀錄').data[1][3]), '2026-10-23');
});

test('a rearranged log sheet stops processing instead of writing into the wrong columns', () => {
  const env = createEnvironment();
  const headers = env.sheets.get('上傳紀錄').data[0];
  [headers[0], headers[1]] = [headers[1], headers[0]];
  assert.throws(() => env.app.processQueue(), /欄位順序/);
});

test('form choices are synced from the roster so names stay consistent', () => {
  const env = createEnvironment();
  const synced = env.app.syncFormChoices();
  assert.equal(synced.students, 3);
  assert.equal(synced.tutors, 2);
  assert.deepEqual(env.formItems.find(item => item.title === '學生').choices, ['王小明', '林小華', 'Emma Lee']);
  assert.deepEqual(env.formItems.find(item => item.title === '小老師').choices, ['陳小老師', 'Alex Chen']);
});
