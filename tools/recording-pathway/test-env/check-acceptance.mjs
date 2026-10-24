// Checks a CSV download of the 上傳紀錄 tab from the Google test environment against the
// synthetic acceptance cases. It only reads the CSV and the media manifest; it never calls Google.
//   node tools/recording-pathway/test-env/check-acceptance.mjs <上傳紀錄.csv> [--manifest <manifest.json>]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MEDIA_DIR, LOG_TITLES, expectations, manualCases, roster } from './cases.mjs';

const STORED_STATES = ['STORED', 'RETENTION_DUE', 'TRASHED'];

// RFC 4180: quoted fields may hold commas, doubled quotes and line breaks.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function rowsFromCsv(text) {
  const [header = [], ...lines] = parseCsv(text).filter(cells => cells.some(cell => cell.trim()));
  const missing = Object.keys(LOG_TITLES).filter(title => !header.includes(title));
  if (missing.length) throw new Error(`CSV 缺少欄位：${missing.join('、')}（請下載「上傳紀錄」分頁）`);
  return lines.map((cells, index) => {
    const row = { line: index + 2 };
    header.forEach((title, column) => {
      if (LOG_TITLES[title]) row[LOG_TITLES[title]] = (cells[column] ?? '').trim();
    });
    return row;
  });
}

function matches(row, match) {
  if (match.file) return row.originalName.toLowerCase().startsWith(match.file);
  if (match.reason) return row.reason.includes(match.reason);
  if (match.error) return row.error.includes(match.error);
  return row.uploadKey === match.key;
}

function describe(expected) {
  const target = expected.match.file || expected.match.reason || expected.match.error || expected.match.key;
  const name = expected.name instanceof RegExp ? expected.name.source : expected.name;
  return `${target} → ${expected.status}${name ? `，${name}` : ''}`;
}

function duplicates(rows, keyOf) {
  const seen = new Map();
  const repeated = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) repeated.push(`第 ${seen.get(key)} 與第 ${row.line} 列`);
    else seen.set(key, row.line);
  }
  return repeated;
}

export function evaluate(rows, manifest) {
  const md5ByName = new Map(manifest.files.map(file => [file.name, file.md5]));
  const syntheticMd5 = new Set(manifest.files.map(file => file.md5));
  const folders = new Map();
  const claimed = new Set();
  const results = expectations.map(expected => {
    const found = rows.filter(row => matches(row, expected.match));
    found.forEach(row => claimed.add(row));
    const problems = [];
    if (found.length !== 1) problems.push(found.length ? `找到 ${found.length} 列，應該只有 1 列` : '找不到對應的列');
    const row = found[0];
    if (row) {
      if (row.status !== expected.status) problems.push(`狀態是 ${row.status || '空白'}，應為 ${expected.status}`);
      const nameOk = expected.name instanceof RegExp ? expected.name.test(row.plannedName) : row.plannedName === expected.name;
      if (expected.name && !nameOk) problems.push(`標準檔名是「${row.plannedName}」`);
      if (expected.md5Of && row.md5 !== md5ByName.get(expected.md5Of)) problems.push(`MD5 和 ${expected.md5Of} 不同`);
      if (expected.error && !row.error.includes(expected.error)) problems.push(`說明沒有「${expected.error}」`);
      if (expected.minSize && !(Number(row.size) >= expected.minSize)) problems.push(`大小只有 ${row.size} bytes`);
      if (expected.minAttempts && !(Number(row.attempts) >= expected.minAttempts)) problems.push(`嘗試次數 ${row.attempts}，應至少 ${expected.minAttempts}`);
      if (expected.folder && !row.folderId) problems.push('沒有存放資料夾 ID');
      else if (expected.folder && !folders.has(expected.folder)) folders.set(expected.folder, row.folderId);
      else if (expected.folder && folders.get(expected.folder) !== row.folderId) problems.push(`存放位置和其他「${expected.folder}」的列不同`);
    }
    return { id: expected.caseId, label: describe(expected), ok: !problems.length, detail: problems.join('；') };
  });

  const students = new Set(roster.students.map(entry => entry[0]));
  const tutors = new Set(roster.tutors.map(entry => entry[0]));
  const stored = rows.filter(row => STORED_STATES.includes(row.status));
  const sharedFolders = [];
  const folderSymbols = new Map();
  for (const [symbol, id] of folders) {
    if (folderSymbols.has(id)) sharedFolders.push(`「${folderSymbols.get(id)}」和「${symbol}」是同一個資料夾`);
    else folderSymbols.set(id, symbol);
  }
  const checks = [
    ['G1', '學生與小老師都是合成名單', rows.filter(row => !students.has(row.student) || !tutors.has(row.tutor)).map(row => `第 ${row.line} 列`)],
    ['G2', '每個檔案的 MD5 都是本機產生的合成檔', rows.filter(row => row.md5 && !syntheticMd5.has(row.md5)).map(row => `第 ${row.line} 列`)],
    ['G3', '沒有重複登記或重複存放', [
      ...duplicates(rows, row => row.uploadKey),
      ...duplicates(rows.filter(row => row.fileId), row => row.fileId),
      ...duplicates(stored, row => `${row.folderId}/${row.plannedName}`),
    ]],
    ['G4', '沒有殘留待處理或失敗的列', rows.filter(row => ['RECEIVED', 'FAILED'].includes(row.status)).map(row => `第 ${row.line} 列（${row.status}）`)],
    ['G5', '目的地、_待確認與各月份資料夾彼此分開', sharedFolders],
  ].map(([id, label, failures]) => ({ id, label, ok: !failures.length, detail: failures.join('、') }));

  const unmatched = rows.filter(row => !claimed.has(row)).map(row => `第 ${row.line} 列（${row.originalName || row.uploadKey}）`);
  return { results: [...results, ...checks], unmatched, ok: results.every(result => result.ok) && checks.every(check => check.ok) };
}

function main(args) {
  const csvPath = args.find(arg => !arg.startsWith('--'));
  const manifestIndex = args.indexOf('--manifest');
  const manifestPath = manifestIndex >= 0 ? args[manifestIndex + 1] : path.join(DEFAULT_MEDIA_DIR, 'manifest.json');
  if (!csvPath) {
    console.error('用法：node tools/recording-pathway/test-env/check-acceptance.mjs <上傳紀錄.csv> [--manifest <manifest.json>]');
    return 2;
  }
  let manifest;
  let rows;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`讀不到合成檔清單 ${manifestPath}：請先執行 make-test-media.mjs，或用 --manifest 指定。（${error.message}）`);
    return 2;
  }
  try {
    rows = rowsFromCsv(readFileSync(csvPath, 'utf8'));
  } catch (error) {
    console.error(`無法讀取 ${csvPath}：${error.message}`);
    return 2;
  }
  const { results, unmatched, ok } = evaluate(rows, manifest);
  console.log(`iHear 錄影上傳 Pathway 驗收檢查：${rows.length} 列，合成檔清單 ${manifest.files.length} 個`);
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id}  ${result.label}${result.detail ? `：${result.detail}` : ''}`);
  if (unmatched.length) console.log(`注意：以下列不屬於任何驗收案例，請說明來源：${unmatched.join('、')}`);
  console.log('\n以下項目無法從 CSV 判斷，請在驗收紀錄表填寫實際看到的結果：');
  for (const [id, text] of manualCases) console.log(`  ${id}  ${text}`);
  const failed = results.filter(result => !result.ok).length;
  console.log(`\n結果：${ok ? '可自動判定的項目全部通過' : `${failed} 項未通過`}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
