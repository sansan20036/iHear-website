// Rehearses the Google test-environment acceptance run (test-env/README.md) step by step
// against the in-memory fake, then grades the exported log with the checker testers will use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvironment } from './fake-google.mjs';
import { LOG_TITLES, expectations, manualCases, media, roster, submissions } from '../test-env/cases.mjs';
import { evaluate, parseCsv, rowsFromCsv } from '../test-env/check-acceptance.mjs';

const DEST = 'DESTFOLDER000001';
// The fake stores a file as FAKE-VIDEO:<content>; a copy keeps its source's content.
const contentOf = name => media.find(item => item.name === name).copyOf ?? name;
const fakeMd5 = name => createHash('md5').update(`FAKE-VIDEO:${contentOf(name)}`).digest('hex');
const manifest = { files: media.filter(item => item.kind !== 'text').map(item => ({ name: item.name, md5: fakeMd5(item.name) })) };

function toCsv(data) {
  return data.map(row => row.map(value => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\r\n');
}

function rehearse() {
  const env = createEnvironment({
    students: roster.students.map(([name, code, consent, date, note]) => [name, code, consent, date && `'${date}`, note]),
    tutors: roster.tutors,
    config: { MAX_ATTEMPTS: '3', ADMIN_EMAILS: 'ihear.test.owner@example.org' },
  });
  const ids = {};
  // Forms keeps the original name at the start; the uploader's name may be added after it.
  const upload = name => {
    const dot = name.lastIndexOf('.');
    const item = media.find(entry => entry.name === name);
    ids[name] = env.upload(`${name.slice(0, dot)} - iHear Test Tutor${name.slice(dot)}`, contentOf(name), undefined, { size: item.bytes });
    return ids[name];
  };
  const send = (caseId, options = {}) => submissions.filter(entry => entry.caseId === caseId).forEach(entry => env.submit({
    date: entry.date === 'tomorrow' ? '2026-10-24' : entry.date, student: entry.student, tutor: entry.tutor,
    recorded: entry.recorded !== false, reason: entry.reason, fileIds: (entry.files || []).map(upload), ...options,
  }));
  const rowOf = name => env.log().find(row => row.fileId === ids[name]);
  const edit = (name, fields) => {
    const log = env.app.openLog_();
    const row = log.rows.find(entry => entry.fileId === ids[name]);
    Object.assign(row, fields);
    env.app.save_(log, row);
  };
  const mails = pattern => env.mail.filter(mail => pattern.test(mail.subject)).length;

  // S5 (A3: authorize, tabs only), S9 form choices, S10 clean settings check, S11 (A4: triggers).
  env.app.prepareSheets();
  assert.equal(env.triggers.length, 0);
  env.app.syncFormChoices();
  assert.equal(env.app.checkSettings().length, 0);
  env.app.setup();

  send('TC-01');
  send('TC-02');
  send('TC-03');
  env.setConfig('NAME_MODE', 'code');
  send('TC-04');
  env.setConfig('NAME_MODE', 'full');
  env.setConfig('MONTHLY_SUBFOLDER', 'on');
  send('TC-05');
  env.setConfig('MONTHLY_SUBFOLDER', 'off');
  send('TC-06');

  const beforeRerun = JSON.stringify(env.log()); // TC-07
  env.app.processQueue();
  env.app.processQueue();
  assert.equal(JSON.stringify(env.log()), beforeRerun);
  assert.match(env.toasts.at(-1), /補登 0 筆、處理 0 筆/);

  env.app.removeTriggers(); // TC-08
  send('TC-08', { trigger: false });
  assert.equal(rowOf('tc08_video.mp4'), undefined);
  env.app.processQueue();
  assert.match(env.toasts.at(-1), /補登 1 筆、處理 1 筆/);
  env.app.setup();

  send('TC-09');
  send('TC-10');
  send('TC-12');
  send('TC-13');
  send('TC-15');

  env.setConfig('STORAGE_WARN_PERCENT', '1'); // TC-16
  assert.equal(env.app.dailyReport().storage.warning, true);
  env.setConfig('STORAGE_WARN_PERCENT', '80');

  env.setConfig('TEST_FAULT', 'move'); // TC-18
  send('TC-18');
  assert.equal(rowOf('tc18_video.mp4').status, 'FAILED');
  env.app.processQueue();
  assert.equal(rowOf('tc18_video.mp4').attempts, 2);
  env.setConfig('TEST_FAULT', '');
  env.app.processQueue();

  env.setConfig('TEST_FAULT', 'rename'); // TC-19
  send('TC-19');
  env.app.processQueue();
  env.app.processQueue();
  env.app.processQueue();
  assert.equal(rowOf('tc19_video.mp4').attempts, 3);
  assert.equal(mails(/多次失敗/), 1);
  env.setConfig('TEST_FAULT', '');
  edit('tc19_video.mp4', { attempts: 0 });
  env.app.processQueue();

  env.setConfig('DEST_FOLDER_ID', 'NOSUCHFOLDER0001'); // TC-20
  send('TC-20');
  env.app.processQueue();
  assert.equal(rowOf('tc20_video.mp4').status, 'RECEIVED');
  assert.equal(mails(/已暫停/), 1);
  env.setConfig('DEST_FOLDER_ID', DEST);
  env.app.processQueue();

  const tc01 = env.file(ids['tc01_video.mp4']); // TC-21
  const storedName = tc01.name;
  tc01.name = '手動改名.mp4';
  assert.equal(env.app.dailyReport().anomalies.length, 1);
  tc01.name = storedName;
  assert.equal(env.app.dailyReport().anomalies.length, 0);

  // TC-22: the Google run never shares a folder (authorization condition 6); the public branch
  // is simulated here only, and the real run checks the 「限制」 branch through checkSettings.
  env.folders.get(DEST).access = 'ANYONE_WITH_LINK';
  assert.match(env.app.processQueue().blocked[0], /知道連結/);
  env.folders.get(DEST).access = 'PRIVATE';
  assert.equal(env.app.checkSettings().length, 0);

  env.setConfig('DEST_FOLDER_ID', env.addFolder('防呆測試（非測試資料夾）')); // TC-24
  assert.match(env.app.checkSettings().join(), /\[測試\]/);
  env.setConfig('DEST_FOLDER_ID', DEST);
  const students = env.sheets.get('學生名單').data;
  students.push(['防呆測試學生', 'S999', '已同意', '', '']);
  assert.match(env.app.checkSettings().join(), /TEST-/);
  students.pop();

  const decoy = env.upload('tc25_decoy_not_from_form.mp4', contentOf('tc25_decoy_not_from_form.mp4'), undefined, { folderId: DEST }); // TC-25
  env.app.appendRows_(env.app.openLog_(), [{
    uploadKey: 'MANUAL:TC-25', lessonDate: '2026-10-22', student: '測試學生甲', tutor: '測試小老師A', recorded: '有錄影', fileId: decoy, status: 'RECEIVED', attempts: 0,
  }]);
  env.app.processQueue();
  assert.equal(env.file(decoy).writes, 0);

  send('TC-26');
  env.setConfig('RETENTION_DAYS', '200');
  assert.equal(env.app.reviewRetention().marked, 2);
  env.file(ids['tc26_old_b.mp4']).name = '刪除前被改名.mp4';
  edit('tc26_old_a.mp4', { confirmDelete: '是' });
  edit('tc26_old_b.mp4', { confirmDelete: '是' });
  const removal = env.app.trashConfirmed();
  assert.equal(removal.trashed, 1);
  assert.equal(removal.refused, 1);
  env.setConfig('RETENTION_DAYS', '');

  send('TC-28', { email: 'second.test.account@example.org' }); // TC-28: from a second test account

  return env;
}

test('the documented acceptance run passes end to end, and its exported log passes the checker', () => {
  const env = rehearse();
  for (const mail of env.mail) { // TC-27
    assert.match(mail.subject, /^\[iHear 錄影上傳\]\[測試\] /);
    assert.doesNotMatch(mail.body, /測試學生|Test Student|測試小老師|Test Tutor/);
  }
  const { results, unmatched, ok } = evaluate(rowsFromCsv(toCsv(env.sheets.get('上傳紀錄').data)), manifest);
  assert.deepEqual(results.filter(result => !result.ok), []);
  assert.deepEqual(unmatched, []);
  assert.equal(ok, true);
  assert.equal(results.length, expectations.length + 5);
});

test('the checker fails a run that used a real name or a file that is not synthetic', () => {
  const env = rehearse();
  const data = env.sheets.get('上傳紀錄').data.map(row => row.slice());
  const md5Column = data[0].indexOf('MD5');
  const studentColumn = data[0].indexOf('學生');
  data[1][md5Column] = 'f'.repeat(32);
  data[2][studentColumn] = '王小明';
  const { results, ok } = evaluate(rowsFromCsv(toCsv(data)), manifest);
  assert.equal(ok, false);
  assert.deepEqual(results.filter(result => !result.ok).map(result => result.id), ['TC-01', 'G1', 'G2']);
});

test('the checker command passes a good run and fails a download of the wrong tab', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ihear-acceptance-'));
  try {
    const checker = fileURLToPath(new URL('../test-env/check-acceptance.mjs', import.meta.url));
    const run = csv => {
      writeFileSync(path.join(dir, 'log.csv'), csv);
      return spawnSync(process.execPath, [checker, path.join(dir, 'log.csv'), '--manifest', path.join(dir, 'manifest.json')], { encoding: 'utf8' });
    };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const good = run(toCsv(rehearse().sheets.get('上傳紀錄').data));
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /可自動判定的項目全部通過/);
    assert.match(good.stdout, /TC-23/);
    const wrongTab = run('時間戳記,上課日期\r\n1,2');
    assert.notEqual(wrongTab.status, 0);
    assert.match(wrongTab.stderr, /缺少欄位/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the checker reads quoted CSV cells and refuses a download of the wrong tab', () => {
  assert.deepEqual(parseCsv('﻿a,"b,c","d ""e"""\r\n1,"2\n3",\r\n'), [['a', 'b,c', 'd "e"'], ['1', '2\n3', '']]);
  assert.throws(() => rowsFromCsv('時間戳記,上課日期\r\n1,2'), /缺少欄位/);
});

test('the case list, the script and the guide agree', () => {
  const env = createEnvironment();
  // LOG_COLUMNS lives in the script's own realm, so it is compared as JSON.
  assert.equal(JSON.stringify(Object.entries(LOG_TITLES)), JSON.stringify(env.app.LOG_COLUMNS.map(([key, title]) => [title, key])));
  const names = new Set(media.map(item => item.name));
  for (const entry of submissions) for (const file of entry.files || []) assert.ok(names.has(file), file);
  for (const item of media.filter(entry => entry.copyOf)) assert.ok(names.has(item.copyOf), item.copyOf);
  const tsv = name => readFileSync(new URL(`../test-env/${name}`, import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map(line => line.split('\t'));
  assert.deepEqual(tsv('students.tsv'), roster.students);
  assert.deepEqual(tsv('tutors.tsv'), roster.tutors);
  const guide = readFileSync(new URL('../test-env/README.md', import.meta.url), 'utf8');
  const ids = new Set([...media, ...submissions, ...expectations].map(entry => entry.caseId).concat(manualCases.map(([id]) => id)));
  for (let number = 1; number <= 27; number++) ids.add(`TC-${String(number).padStart(2, '0')}`);
  for (const id of ids) assert.match(guide, new RegExp(`\\b${id}\\b`), `${id} is missing from test-env/README.md`);
  for (const name of names) assert.ok(guide.includes(name), `${name} is missing from test-env/README.md`);
});
