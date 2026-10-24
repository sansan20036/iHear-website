// Synthetic acceptance cases for the Google test environment (see README.md here). The media
// generator, the CSV checker and the local rehearsal test all read these definitions, so the
// written procedure and its checks cannot drift apart. Every name and file here is synthetic.
import os from 'node:os';
import path from 'node:path';

export const MiB = 1024 * 1024;

// Outside OneDrive on purpose: about 170 MB of synthetic files should not sync anywhere.
export const DEFAULT_MEDIA_DIR = path.join(os.tmpdir(), 'ihear-recording-test-media');

export const roster = {
  students: [
    ['測試學生甲', 'TEST-S01', '已同意', '2026-10-23', '合成資料'],
    ['測試學生乙', 'TEST-S02', '未同意', '', '合成資料：驗證未同意'],
    ['Test Student C', 'TEST-S03', '已同意', '2026-10-23', '合成資料：英文姓名'],
    ['測試學生/丁', 'TEST-S04', '已同意', '2026-10-23', '合成資料：姓名含「/」'],
  ],
  tutors: [['測試小老師A'], ['Test Tutor B']],
};

// The log's column titles, as a CSV download of the 上傳紀錄 tab shows them.
export const LOG_TITLES = {
  上傳識別碼: 'uploadKey', 收到時間: 'receivedAt', 上傳者: 'uploader', 上課日期: 'lessonDate', 學生: 'student',
  小老師: 'tutor', 是否錄影: 'recorded', 未錄影原因: 'reason', '檔案 ID': 'fileId', 原始檔名: 'originalName',
  標準檔名: 'plannedName', 段數: 'part', '大小 (bytes)': 'size', MD5: 'md5', '存放資料夾 ID': 'folderId',
  狀態: 'status', 嘗試次數: 'attempts', 說明: 'error', 更新時間: 'updatedAt', 確認刪除: 'confirmDelete',
};

// kind: video (mp4/mov), audio (m4a), avi, text, noise (`seconds` of incompressible video, at least
// `bytes` large); copyOf repeats another file byte for byte. Every kind regenerates byte for byte.
export const media = [
  { name: 'tc01_video.mp4', caseId: 'TC-01', kind: 'video', tone: 440 },
  { name: 'tc02_part_a.mp4', caseId: 'TC-02', kind: 'video', tone: 466 },
  { name: 'tc02_part_b.m4a', caseId: 'TC-02', kind: 'audio', tone: 494 },
  { name: 'tc03_video.mov', caseId: 'TC-03', kind: 'video', tone: 523 },
  { name: 'tc04_video.mp4', caseId: 'TC-04', kind: 'video', tone: 554 },
  { name: 'tc05_sep30.mp4', caseId: 'TC-05', kind: 'video', tone: 587 },
  { name: 'tc05_oct01.mp4', caseId: 'TC-05', kind: 'video', tone: 622 },
  { name: 'tc05_oct02.mp4', caseId: 'TC-05', kind: 'video', tone: 659 },
  { name: 'tc06_copy_of_tc01.mp4', caseId: 'TC-06', copyOf: 'tc01_video.mp4' },
  { name: 'tc08_video.mp4', caseId: 'TC-08', kind: 'video', tone: 698 },
  { name: 'tc09_video.mp4', caseId: 'TC-09', kind: 'video', tone: 740 },
  { name: 'tc10_video.avi', caseId: 'TC-10', kind: 'avi', tone: 784 },
  { name: 'tc11_notes.txt', caseId: 'TC-11', kind: 'text' },
  { name: 'tc13_video.mp4', caseId: 'TC-13', kind: 'video', tone: 831 },
  { name: 'tc14_over_10mb.mp4', caseId: 'TC-14', kind: 'noise', tone: 880, seconds: 2, bytes: 11 * MiB },
  { name: 'tc15_large_150mb.mp4', caseId: 'TC-15', kind: 'noise', tone: 932, seconds: 18, bytes: 150 * 1000 * 1000, large: true },
  { name: 'tc18_video.mp4', caseId: 'TC-18', kind: 'video', tone: 988 },
  { name: 'tc19_video.mp4', caseId: 'TC-19', kind: 'video', tone: 1047 },
  { name: 'tc20_video.mp4', caseId: 'TC-20', kind: 'video', tone: 1109 },
  { name: 'tc25_decoy_not_from_form.mp4', caseId: 'TC-25', kind: 'video', tone: 1175 },
  { name: 'tc26_old_a.mp4', caseId: 'TC-26', kind: 'video', tone: 1245 },
  { name: 'tc26_old_b.mp4', caseId: 'TC-26', kind: 'video', tone: 1319 },
  { name: 'tc28_second_account.mp4', caseId: 'TC-28', kind: 'video', tone: 1397 },
];

// What the tester enters in the form, in run order. date 'tomorrow' means the day after the run.
export const submissions = [
  { caseId: 'TC-01', date: '2026-10-20', student: '測試學生甲', tutor: '測試小老師A', files: ['tc01_video.mp4'] },
  { caseId: 'TC-02', date: '2026-10-20', student: '測試學生甲', tutor: '測試小老師A', files: ['tc02_part_a.mp4', 'tc02_part_b.m4a'] },
  { caseId: 'TC-03', date: '2026-10-21', student: '測試學生/丁', tutor: 'Test Tutor B', files: ['tc03_video.mov'] },
  { caseId: 'TC-04', date: '2026-10-21', student: 'Test Student C', tutor: 'Test Tutor B', files: ['tc04_video.mp4'] },
  { caseId: 'TC-05', date: '2026-09-30', student: '測試學生甲', tutor: '測試小老師A', files: ['tc05_sep30.mp4'] },
  { caseId: 'TC-05', date: '2026-10-01', student: '測試學生甲', tutor: '測試小老師A', files: ['tc05_oct01.mp4'] },
  { caseId: 'TC-05', date: '2026-10-02', student: '測試學生甲', tutor: '測試小老師A', files: ['tc05_oct02.mp4'] },
  { caseId: 'TC-06', date: '2026-10-22', student: '測試學生甲', tutor: '測試小老師A', files: ['tc06_copy_of_tc01.mp4'] },
  { caseId: 'TC-08', date: '2026-10-22', student: 'Test Student C', tutor: '測試小老師A', files: ['tc08_video.mp4'] },
  { caseId: 'TC-09', date: '2026-10-22', student: '測試學生乙', tutor: '測試小老師A', files: ['tc09_video.mp4'] },
  { caseId: 'TC-10', date: '2026-10-22', student: '測試學生甲', tutor: 'Test Tutor B', files: ['tc10_video.avi'] },
  { caseId: 'TC-12', date: '2026-10-22', student: '測試學生乙', tutor: 'Test Tutor B', recorded: false, reason: 'TC-12 家長未同意錄影（合成資料）' },
  { caseId: 'TC-13', date: 'tomorrow', student: '測試學生甲', tutor: '測試小老師A', files: ['tc13_video.mp4'] },
  { caseId: 'TC-15', date: '2026-10-19', student: '測試學生甲', tutor: 'Test Tutor B', files: ['tc15_large_150mb.mp4'] },
  { caseId: 'TC-18', date: '2026-10-19', student: 'Test Student C', tutor: '測試小老師A', files: ['tc18_video.mp4'] },
  { caseId: 'TC-19', date: '2026-10-18', student: 'Test Student C', tutor: 'Test Tutor B', files: ['tc19_video.mp4'] },
  { caseId: 'TC-20', date: '2026-10-17', student: '測試學生甲', tutor: '測試小老師A', files: ['tc20_video.mp4'] },
  { caseId: 'TC-26', date: '2026-01-15', student: '測試學生甲', tutor: '測試小老師A', files: ['tc26_old_a.mp4'] },
  { caseId: 'TC-26', date: '2026-01-16', student: '測試學生甲', tutor: '測試小老師A', files: ['tc26_old_b.mp4'] },
  // Sent from a second test account (the tutor), not the form owner.
  { caseId: 'TC-28', date: '2026-10-22', student: 'Test Student C', tutor: 'Test Tutor B', files: ['tc28_second_account.mp4'] },
];

// Final state of the 上傳紀錄 tab after the whole run. Rows are found by the start of the
// original file name (Forms may add the uploader's name after it), by reason, by message or by key.
// folder: 'root' is the destination, 'quarantine' is _待確認, 'month:…' a monthly subfolder.
export const expectations = [
  { caseId: 'TC-01', match: { file: 'tc01_' }, status: 'STORED', name: '2026-10-20_測試學生甲_測試小老師A_P01.mp4', folder: 'root', md5Of: 'tc01_video.mp4' },
  { caseId: 'TC-02', match: { file: 'tc02_part_a' }, status: 'STORED', name: /^2026-10-20_測試學生甲_測試小老師A_P0[23]\.mp4$/, folder: 'root', md5Of: 'tc02_part_a.mp4' },
  { caseId: 'TC-02', match: { file: 'tc02_part_b' }, status: 'STORED', name: /^2026-10-20_測試學生甲_測試小老師A_P0[23]\.m4a$/, folder: 'root', md5Of: 'tc02_part_b.m4a' },
  { caseId: 'TC-03', match: { file: 'tc03_' }, status: 'STORED', name: '2026-10-21_測試學生-丁_Test Tutor B_P01.mov', folder: 'root' },
  { caseId: 'TC-04', match: { file: 'tc04_' }, status: 'STORED', name: '2026-10-21_TEST-S03_Test Tutor B_P01.mp4', folder: 'root' },
  { caseId: 'TC-05', match: { file: 'tc05_sep30' }, status: 'STORED', name: '2026-09-30_測試學生甲_測試小老師A_P01.mp4', folder: 'month:09.2026' },
  { caseId: 'TC-05', match: { file: 'tc05_oct01' }, status: 'STORED', name: '2026-10-01_測試學生甲_測試小老師A_P01.mp4', folder: 'month:10.2026' },
  { caseId: 'TC-05', match: { file: 'tc05_oct02' }, status: 'STORED', name: '2026-10-02_測試學生甲_測試小老師A_P01.mp4', folder: 'month:10.2026' },
  { caseId: 'TC-06', match: { file: 'tc06_' }, status: 'DUPLICATE', folder: 'quarantine', md5Of: 'tc01_video.mp4', error: 'P01' },
  { caseId: 'TC-08', match: { file: 'tc08_' }, status: 'STORED', name: '2026-10-22_Test Student C_測試小老師A_P01.mp4', folder: 'root' },
  { caseId: 'TC-09', match: { file: 'tc09_' }, status: 'NO_CONSENT', folder: 'quarantine' },
  { caseId: 'TC-10', match: { file: 'tc10_' }, status: 'INVALID', folder: 'quarantine', error: 'mp4' },
  { caseId: 'TC-12', match: { reason: 'TC-12' }, status: 'NOT_RECORDED' },
  { caseId: 'TC-13', match: { error: '晚於今天' }, status: 'INVALID' },
  { caseId: 'TC-15', match: { file: 'tc15_' }, status: 'STORED', name: '2026-10-19_測試學生甲_Test Tutor B_P01.mp4', folder: 'root', minSize: 100 * MiB },
  { caseId: 'TC-18', match: { file: 'tc18_' }, status: 'STORED', name: '2026-10-19_Test Student C_測試小老師A_P01.mp4', folder: 'root', minAttempts: 2 },
  { caseId: 'TC-19', match: { file: 'tc19_' }, status: 'STORED', name: '2026-10-18_Test Student C_Test Tutor B_P01.mp4', folder: 'root' },
  { caseId: 'TC-20', match: { file: 'tc20_' }, status: 'STORED', name: '2026-10-17_測試學生甲_測試小老師A_P01.mp4', folder: 'root' },
  { caseId: 'TC-25', match: { key: 'MANUAL:TC-25' }, status: 'INVALID', error: '不是透過本表單上傳' },
  { caseId: 'TC-26', match: { file: 'tc26_old_a' }, status: 'TRASHED', name: '2026-01-15_測試學生甲_測試小老師A_P01.mp4', folder: 'root' },
  { caseId: 'TC-26', match: { file: 'tc26_old_b' }, status: 'RETENTION_DUE', name: '2026-01-16_測試學生甲_測試小老師A_P01.mp4', folder: 'root', error: '未刪除' },
  { caseId: 'TC-28', match: { file: 'tc28_' }, status: 'STORED', name: '2026-10-22_Test Student C_Test Tutor B_P01.mp4', folder: 'root', md5Of: 'tc28_second_account.mp4' },
];

// Cases the CSV cannot show; the tester records what they saw in the result sheet.
export const manualCases = [
  ['TC-07', '連續執行兩次「處理待上傳／重試失敗」，提示都顯示「補登 0 筆、處理 0 筆」，紀錄沒有變化'],
  ['TC-08', '停用自動處理後送出的回覆沒有立即出現在「上傳紀錄」；手動處理時提示「補登 1 筆」'],
  ['TC-11', '表單拒絕 tc11_notes.txt（記錄畫面上的錯誤訊息）'],
  ['TC-14', '表單單檔上限設為 10 MB 時拒絕 tc14_over_10mb.mp4（記錄錯誤訊息）'],
  ['TC-15', '記錄 150 MB 上傳所需時間，以及 Apps Script「執行作業」中該次處理的執行時間'],
  ['TC-16', '容量警示信與「每日核對」的雲端硬碟用量欄位'],
  ['TC-17', '記錄表單設定中可選的單檔與總容量上限'],
  ['TC-19', '只收到一封「錄影上傳多次失敗」通知'],
  ['TC-20', '設定錯誤期間只收到一封「已暫停」通知，修正後自動恢復'],
  ['TC-21', '每日核對抓到手動改名的檔案，改回後不再出現'],
  ['TC-22', '不改任何分享設定：共用對話框顯示「限制」且只有擁有者，「檢查設定」顯示沒有對外分享（公開分享時的暫停由本機模擬測試驗證）'],
  ['TC-23', '未登入的視窗打不開目的地資料夾、已存放的檔案與試算表（本輪不使用任何日常帳號）'],
  ['TC-24', '目的地不是「[測試]」資料夾，或名單出現非 TEST- 代碼時，檢查設定會擋下'],
  ['TC-25', '誘餌檔的名稱、位置都沒有改變'],
  ['TC-27', '所有通知信主旨都是「[iHear 錄影上傳][測試]」開頭，內文沒有學生或小老師姓名'],
  ['TC-28', '第二帳號上傳後：上傳者與擁有者兩邊的雲端硬碟各有哪些檔案（ID、擁有者、位置、存取權、用量），上傳者事後能否開啟擁有者的檔案'],
];
