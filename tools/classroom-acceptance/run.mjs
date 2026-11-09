// P3-Multi B6 (2026-11-09): V-1～V-17 and D-1, D-2 acceptance, local part.
//   node tools/classroom-acceptance/run.mjs --list    the items, their categories and what is left
//   node tools/classroom-acceptance/run.mjs --local   runs the local evidence (fake APIs, no network)
//                                                     and writes output/acceptance/v-items.{json,md}
//   node tools/classroom-acceptance/run.mjs --real    refuses: real Zoom and Drive need the account
//                                                     holder's approval; it prints where the steps are
// It never reads an environment file, never reaches Zoom or Google, and never records anything.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CATEGORIES, V_ITEMS } from './v-items.mjs';

const mode = process.argv[2] ?? '--list';
const labels = item => item.outOfScope ? '不在範圍' : item.categories.map(name => CATEGORIES[name]).join('、');

if (mode === '--real') {
  console.error('真實 Zoom／Google Drive 驗收需要 iHear 帳號持有人核准（憑證、雲端錄影、費用、測試帳號）。本工具不會連線。');
  console.error('操作步驟：tools/classroom-acceptance/README.md（第 3 節）；費用一律「等待 iHear 費用授權」。');
  process.exit(2);
}

if (mode === '--list') {
  for (const item of V_ITEMS) console.log(`${item.id}\t${labels(item)}\t${item.title}`);
  process.exit(0);
}

if (mode !== '--local') {
  console.error('Use --list, --local or --real');
  process.exit(1);
}

// The local evidence: the vitest files the items name (one run, a JSON report), and the recording
// pathway's own node tests (webhook ingest, dedupe, filing) for the items marked pathway.
const out = path.join('output', 'acceptance');
mkdirSync(out, { recursive: true });
const files = [...new Set(V_ITEMS.flatMap(item => item.evidence.map(([file]) => file)))];
const report = path.join(out, 'vitest.json');
const vitest = spawnSync(process.execPath, [path.join('node_modules', 'vitest', 'vitest.mjs'), 'run', ...files, '--reporter=json', `--outputFile=${report}`], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
let results = [];
try {
  results = JSON.parse(readFileSync(report, 'utf8')).testResults.flatMap(file => file.assertionResults.map(test => ({ file: path.relative(process.cwd(), file.name).replace(/\\/g, '/'), name: test.fullName ?? test.title, status: test.status })));
} catch {
  console.error('The vitest report could not be read.');
  console.error(vitest.stderr.slice(-2000));
  process.exit(1);
}
const pathway = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tools/recording-pathway/test/*.test.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 600000, shell: false });
const count = (text, word) => Number(text.match(new RegExp(`^# ${word} (\\d+)$`, 'm'))?.[1] ?? NaN);
const pathwayResult = { pass: count(pathway.stdout, 'pass'), fail: count(pathway.stdout, 'fail') };

const items = V_ITEMS.map(item => {
  const found = item.evidence.map(([file, part]) => {
    const matches = results.filter(test => test.file === file && test.name.includes(part));
    return { file, part, tests: matches.length, passed: matches.filter(test => test.status === 'passed').length };
  });
  const local = item.outOfScope ? '不在範圍'
    : found.every(entry => entry.tests > 0 && entry.passed === entry.tests) && (!item.pathway || (pathwayResult.fail === 0 && pathwayResult.pass > 0)) ? '合成通過（本機）' : '本機證據未通過或找不到';
  return { id: item.id, title: item.title, categories: item.categories.map(name => CATEGORIES[name]), local, real: item.outOfScope ? '不測' : '未驗證', evidence: found, browserSteps: item.browser ?? [], realProcedure: item.real };
});
const summary = { generatedAt: new Date().toISOString(), synthetic: true, note: '本機結果只證明我方邏輯；Zoom 與 Google 的實際行為、延遲、容量與費用都未驗證。', vitest: { files: files.length, tests: results.length, passed: results.filter(test => test.status === 'passed').length }, pathway: pathwayResult, items };
writeFileSync(path.join(out, 'v-items.json'), `${JSON.stringify(summary, null, 2)}\n`);
const lines = ['| 項目 | 分類 | 本機 | 真實 | 說明 |', '|---|---|---|---|---|', ...items.map(item => `| ${item.id} | ${item.categories.join('、') || '—'} | ${item.local} | ${item.real} | ${item.title} |`)];
writeFileSync(path.join(out, 'v-items.md'), `${lines.join('\n')}\n`);
for (const item of items) console.log(`${item.id}\t${item.local}\t${item.real}\t${item.evidence.map(entry => `${entry.passed}/${entry.tests}`).join(' ')}`);
console.log(`vitest ${summary.vitest.passed}/${summary.vitest.tests} passed in ${files.length} files; pathway ${pathwayResult.pass} passed, ${pathwayResult.fail} failed`);
process.exit(items.some(item => item.local.startsWith('本機證據未通過')) ? 1 : 0);
