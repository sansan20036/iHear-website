// Synthetic dry run of the live classroom overview with 2, 5 and 10 concurrent one-to-one lessons.
// Each lesson gets a scenario with planted faults (lost, late and duplicated webhooks, a start
// that fails, a student without consent, a consent withdrawal whose stop is not confirmed, a
// tutor's computer switched off, everyone dropping out, someone unknown joining, recording that
// Zoom started by itself) and the dashboard is printed at a few moments, codes only.
//
// This is a check of our own logic against a simulated Zoom. Zoom is never contacted, and it
// proves nothing about real Zoom behaviour, delays, how many recordings Zoom can run at once,
// devices, or cost.
import { cardsByCode, EXPECTED_FINAL, LESSON_START, makeLesson, MIN, PLANTED, runSimulation, SCENARIOS } from '../test/fake-zoom.mjs';

const RUNS = {
  2: ['normal', 'consent_withdrawn'],
  5: ['normal', 'no_consent', 'late_webhooks', 'tutor_shutdown', 'consent_withdrawn'],
  10: Object.keys(SCENARIOS),
};
const MOMENTS = [
  ['開課後 5 分鐘', LESSON_START + 5 * MIN],
  ['開課後 31 分鐘（小老師 30 分時關機）', LESSON_START + 31 * MIN],
  ['開課後 62 分鐘（剛下課）', LESSON_START + 62 * MIN],
  ['開課後 95 分鐘', LESSON_START + 95 * MIN],
];
const GROUP = { ANOMALY: '異常', LIVE: '進行中', WAITING: '等待開始', ENDED: '已結束' };
const at = value => new Date(value + 8 * 60 * MIN).toISOString().slice(11, 16);

function printDashboard(title, dashboard) {
  console.log(`\n  ${title}　進行中 ${dashboard.counts.LIVE}｜等待開始 ${dashboard.counts.WAITING}｜已結束 ${dashboard.counts.ENDED}｜異常 ${dashboard.counts.ANOMALY}`);
  for (const [group, cards] of Object.entries(dashboard.groups)) {
    for (const card of cards) {
      const people = [card.tutor, ...card.students].map(person => `${person.code} ${person.label}`).join('；');
      const anomalies = card.anomalies.map(entry => `${entry.label}${entry.severity === 'error' ? '' : '（提醒）'}`).join('、') || '—';
      console.log(`    [${GROUP[group]}] ${card.lessonCode}｜${card.phase.label}｜${people}｜錄影：${card.recording.label}｜歸檔：${card.filing.label || '—'}｜資料：${card.dataState.label}｜${anomalies}`);
    }
  }
}

let failures = 0;
const check = (ok, text) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`);
};

console.log('合成邏輯檢查：沒有連到 Zoom，實際並行錄影容量未驗證。');
console.log('All data is synthetic (TEST- codes). 每堂一對一課程使用獨立教室（一個 session）。時間為台北時間。');

for (const [size, scenarios] of Object.entries(RUNS)) {
  console.log(`\n=== ${size} 堂同時上課 ===`);
  console.log(`  情境：${scenarios.map((name, index) => `${makeLesson(index).code}=${name}`).join('，')}`);
  const run = await runSimulation({ scenarios, checkpoints: MOMENTS.map(([, value]) => value) });
  if (Number(size) === 10) for (const [index, snapshot] of run.snapshots.entries()) printDashboard(`${MOMENTS[index][0]}（${at(snapshot.at)}）`, snapshot.dashboard);
  printDashboard('最後（開課後 8 小時）', run.final);
  const cards = cardsByCode(run.final);
  for (const [index, name] of scenarios.entries()) {
    const { group, card } = cards.get(makeLesson(index).code);
    const actual = { group, recording: card.recording.status, filing: card.filing.status, anomalies: card.anomalies.map(entry => entry.code) };
    check(JSON.stringify(actual) === JSON.stringify(EXPECTED_FINAL[name]), `${card.lessonCode} ${name}: ${JSON.stringify(actual)}`);
    const alone = await runSimulation({ scenarios: [name], indexes: [index] });
    check(JSON.stringify(cardsByCode(alone.final).get(card.lessonCode).card) === JSON.stringify(card), `${card.lessonCode} 單獨執行與 ${size} 堂並行時結果相同`);
  }
  const kept = run.store.fileRecords().filter(record => ['STORED', 'QUARANTINED'].includes(record.status));
  check(kept.every(record => run.drive.activeFiles().filter(file => file.appProperties.providerFileId === record.providerFileId).length === 1) && run.drive.activeFiles().length === kept.length,
    `每個已歸檔的錄影檔在 Drive 只有一份（${kept.length} 份）`);
  const everything = JSON.stringify([run.final, run.store.events(), run.store.fileRecords(), run.store.jobs(), run.drive.activeFiles()]);
  check(PLANTED.every(planted => !everything.includes(planted)), '資料庫、Drive 與總覽中沒有任何預先植入的姓名、電話、IP、下載網址或 token');
  check(run.stats.maxHeavyPerMinute <= 20, `核對用的 REST 呼叫：每分鐘最多 ${run.stats.maxHeavyPerMinute} 次 HEAVY（預算 20）`);
  console.log(`  統計：webhook ${run.stats.webhooks} 次、核對 ${run.stats.reconciliations} 次、伺服器動作 ${JSON.stringify(run.stats.actions)}`);
}

console.log('\n=== 資料庫中斷 90 秒（10 堂，下課前後） ===');
const outage = await runSimulation({ scenarios: Object.keys(SCENARIOS), databaseOutage: { from: LESSON_START + 59.5 * MIN, to: LESSON_START + 61 * MIN } });
const outageCards = cardsByCode(outage.final);
check(Object.keys(SCENARIOS).every((name, index) => {
  const { group, card } = outageCards.get(makeLesson(index).code);
  return group === EXPECTED_FINAL[name].group && card.recording.status === EXPECTED_FINAL[name].recording && card.filing.status === EXPECTED_FINAL[name].filing;
}), `中斷期間回 503 的 webhook 由 Zoom 重送後補齊（重送 ${outage.stats.retriedDeliveries} 次、重送後仍遺失 ${outage.stats.lostAfterRetries} 次），每堂結果不變`);
const keys = outage.store.events().map(event => event.key);
check(new Set(keys).size === keys.length, '沒有重複事件，也沒有重複歸檔');

console.log(failures ? `\nDRY RUN: FAIL (${failures})` : '\nDRY RUN: PASS — 合成邏輯檢查通過；實際並行錄影容量、Zoom 行為與費用仍未驗證。');
process.exitCode = failures ? 1 : 0;
