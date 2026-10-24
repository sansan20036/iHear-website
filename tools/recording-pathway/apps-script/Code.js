// Apps Script adapter for the recording upload pathway: Google Form (upload) ->
// this script (rename, file, log) -> Google Drive. Bound to the response spreadsheet.
// It never changes sharing settings and never deletes. It only moves, renames or trashes
// files attached to this form's own responses; trashing also needs an admin's "是".
/* global RecordingCore */
/* exported onOpen, prepareSheets, setup, removeTriggers, onFormSubmit, processQueue, checkSettings, dailyReport, reviewRetention, trashConfirmed, syncFormChoices */
var PATHWAY_VERSION = '2026-10-23.3';
var SHEET = { CONFIG: '設定', STUDENTS: '學生名單', TUTORS: '小老師名單', LOG: '上傳紀錄', REPORT: '每日核對' };
var FORM = {
  DATE: '上課日期',
  STUDENT: '學生',
  TUTOR: '小老師',
  RECORDED: '本堂是否錄影',
  NOT_RECORDED: '整堂未錄影',
  FILES: '錄影檔',
  REASON: '未錄影原因'
};
// Defined here rather than in Core.js: Apps Script loads files in editor order, so nothing
// at the top level of this file may depend on Core.js.
var STATUS = {
  RECEIVED: 'RECEIVED',
  STORED: 'STORED',
  DUPLICATE: 'DUPLICATE',
  NO_CONSENT: 'NO_CONSENT',
  INVALID: 'INVALID',
  FAILED: 'FAILED',
  NOT_RECORDED: 'NOT_RECORDED',
  RETENTION_DUE: 'RETENTION_DUE',
  TRASHED: 'TRASHED',
  HANDLED: 'HANDLED'
};
var LOG_COLUMNS = [
  ['uploadKey', '上傳識別碼'], ['receivedAt', '收到時間'], ['uploader', '上傳者'],
  ['lessonDate', '上課日期'], ['student', '學生'], ['tutor', '小老師'],
  ['recorded', '是否錄影'], ['reason', '未錄影原因'], ['fileId', '檔案 ID'],
  ['originalName', '原始檔名'], ['plannedName', '標準檔名'], ['part', '段數'],
  ['size', '大小 (bytes)'], ['md5', 'MD5'], ['folderId', '存放資料夾 ID'],
  ['status', '狀態'], ['attempts', '嘗試次數'], ['error', '說明'],
  ['updatedAt', '更新時間'], ['confirmDelete', '確認刪除']
];
var TEXT_COLUMNS = ['uploadKey', 'lessonDate', 'fileId', 'originalName', 'plannedName', 'md5', 'folderId'];
var REPORT_COLUMNS = ['核對日期', '已存放', '待處理', '失敗', '需人工確認', '檔案異常', '雲端硬碟用量', '說明'];
// Settings rows that setup adds when missing: key, default value, explanation.
var CONFIG_ROWS = [
  ['MODE', 'test', 'test＝測試模式：目的地資料夾名稱須以「[測試]」開頭、學生代碼須以「TEST-」開頭。live＝正式模式，須經授權才能切換'],
  ['DEST_FOLDER_ID', '', '目的地雲端硬碟資料夾 ID（必填）。修改後只影響新上傳的檔案'],
  ['MONTHLY_SUBFOLDER', 'off', 'on＝依上課月份放進「[iHear] MM.YYYY.Zoom Recordings」子資料夾'],
  ['NAME_MODE', 'full', 'full＝檔名用學生姓名；code＝用學生代碼'],
  ['RETENTION_DAYS', '', '保存天數（1–9999）。留白＝尚未決定，不標記到期；正式模式必填'],
  ['MAX_ATTEMPTS', '5', '每個檔案最多自動重試幾次（1–9）'],
  ['ADMIN_EMAILS', '', '接收異常通知的信箱，多個用逗號分隔；正式模式必填'],
  ['STORAGE_WARN_PERCENT', '80', '雲端硬碟用量達到幾 % 時通知管理員（1–99）'],
  ['TEST_FAULT', '', '僅限測試模式：move／rename／md5 會讓處理在該步驟模擬失敗；驗收完畢須留白']
];
var CONFIG_DEFAULTS = {};
CONFIG_ROWS.forEach(function (row) { CONFIG_DEFAULTS[row[0]] = row[1]; });
var ACCESS_LABELS = { ANYONE: '公開', ANYONE_WITH_LINK: '知道連結的任何人', DOMAIN: '機構內所有人', DOMAIN_WITH_LINK: '機構內知道連結的人' };
var QUARANTINE_FOLDER = '_待確認';
var RUN_BUDGET_MS = 270000; // Stop starting new work after 4.5 minutes; Apps Script ends a run at 6.
var CATCH_UP_DAYS = 14;
var BLOCKED_NOTICE = 'BLOCKED_NOTICE';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('錄影上傳')
    .addItem('處理待上傳／重試失敗', 'processQueue')
    .addItem('檢查設定', 'checkSettings')
    .addItem('每日核對', 'dailyReport')
    .addSeparator()
    .addItem('標記到期錄影', 'reviewRetention')
    .addItem('移除已確認到期錄影', 'trashConfirmed')
    .addItem('更新表單名單選項', 'syncFormChoices')
    .addSeparator()
    .addItem('啟用自動處理（安裝觸發器）', 'setup')
    .addItem('停用自動處理（移除觸發器）', 'removeTriggers')
    .addToUi();
}

// First run by the account owner: asks for every permission (all of them, because a partial
// grant could fail quietly, e.g. alerts without email), then creates missing tabs and settings
// in test mode. It installs no triggers, so authorizing and switching on automation stay separate.
function prepareSheets() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  prepare_(SpreadsheetApp.getActive());
  report_('已建立分頁與預設設定（測試模式）；尚未安裝觸發器');
  return { prepared: true };
}

// Switches on automatic processing, safe to run again: prepares the tabs, then replaces this
// project's triggers.
function setup() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  var spreadsheet = SpreadsheetApp.getActive();
  prepare_(spreadsheet);
  deleteTriggers_();
  ScriptApp.newTrigger('onFormSubmit').forForm(FormApp.openByUrl(spreadsheet.getFormUrl())).onFormSubmit().create();
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(22).create();
  report_('已啟用自動處理：表單送出時處理、每 15 分鐘重試、每天 22:00 核對');
  return { triggers: ScriptApp.getProjectTriggers().length };
}

// Stops automatic processing (to pause, to test a missed trigger, or to uninstall).
// Responses sent meanwhile are picked up later by processQueue.
function removeTriggers() {
  var removed = deleteTriggers_();
  report_('已停用自動處理（移除 ' + removed + ' 個觸發器）。恢復後會補登最近 ' + CATCH_UP_DAYS + ' 天內的表單回覆');
  return { removed: removed };
}

function onFormSubmit(e) {
  var lock = LockService.getScriptLock();
  // A busy lock loses nothing: the next processQueue run picks this response up from the form.
  if (!lock.tryLock(30000)) return;
  try {
    ingest_(openLog_(), e.response);
  } finally {
    lock.releaseLock();
  }
  processQueue();
}

function processQueue(e) {
  var lock = LockService.getScriptLock();
  var result = { skipped: '另一個處理程序正在執行' };
  if (lock.tryLock(20000)) {
    try {
      result = processLocked_();
    } finally {
      lock.releaseLock();
    }
  }
  if (!e) report_(describeRun_(result)); // Menu runs get a summary; trigger runs stay quiet.
  return result;
}

function describeRun_(result) {
  if (result.skipped) return result.skipped;
  if (result.blocked) return '處理已暫停：' + result.blocked.join('；');
  return '補登 ' + result.caughtUp + ' 筆、處理 ' + result.processed + ' 筆' + (result.deferred ? '、延到下次 ' + result.deferred + ' 筆' : '');
}

function processLocked_() {
  var config = readConfig_();
  var roster = readStudents_();
  var problems = settingsProblems_(config, roster);
  if (problems.length) {
    notifyBlocked_(config, problems);
    return { blocked: problems };
  }
  PropertiesService.getScriptProperties().deleteProperty(BLOCKED_NOTICE);
  var form = openForm_();
  var log = openLog_();
  var caughtUp = catchUp_(form, log);
  var maxAttempts = Number(config.MAX_ATTEMPTS);
  var started = Date.now();
  var processed = 0;
  var deferred = 0;
  log.rows.forEach(function (row) {
    if (row.status !== STATUS.RECEIVED && !(row.status === STATUS.FAILED && Number(row.attempts) < maxAttempts)) return;
    if (Date.now() - started > RUN_BUDGET_MS) {
      deferred++;
      return;
    }
    processRow_(row, log, config, roster, form, maxAttempts);
    processed++;
  });
  return { caughtUp: caughtUp, processed: processed, deferred: deferred };
}

function processRow_(row, log, config, roster, form, maxAttempts) {
  row.attempts = Number(row.attempts || 0) + 1;
  try {
    if (!fromThisForm_(form, row)) {
      return settle_(row, log, STATUS.INVALID, '找不到這個檔案所屬的表單回覆（不是透過本表單上傳，或回覆已被刪除），程式不會移動、改名或刪除它');
    }
    var stored = log.rows.filter(function (other) {
      return other !== row && other.fileId === row.fileId && [STATUS.STORED, STATUS.RETENTION_DUE, STATUS.TRASHED].indexOf(other.status) >= 0;
    })[0];
    if (stored) return settle_(row, log, STATUS.DUPLICATE, '同一個檔案已由第 ' + stored.__row + ' 列存放');
    var file = DriveApp.getFileById(row.fileId);
    if (!row.originalName) row.originalName = file.getName();
    var root = DriveApp.getFolderById(config.DEST_FOLDER_ID);
    var extension = RecordingCore.extensionOf(row.originalName, file.getMimeType());
    if (!extension) return hold_(row, log, file, root, STATUS.INVALID, '不是可接受的錄影檔（mp4、m4a、mov）');
    if (!RecordingCore.hasConsent(roster, row.student)) {
      hold_(row, log, file, root, STATUS.NO_CONSENT, '學生名單中沒有家長或監護人的錄影同意');
      return notify_(config, '收到未取得錄影同意的檔案', '上傳紀錄第 ' + row.__row + ' 列，檔案已移到「' + QUARANTINE_FOLDER + '」，請管理員處理。');
    }
    row.size = file.getSize();
    if (!(row.size > 0)) return hold_(row, log, file, root, STATUS.INVALID, '檔案大小為 0');
    fault_(config, 'md5');
    row.md5 = Drive.Files.get(row.fileId, { fields: 'md5Checksum' }).md5Checksum;
    if (!row.md5) throw new Error('暫時無法取得檔案校驗碼');
    var duplicate = log.rows.filter(function (other) {
      return other !== row && other.status === STATUS.STORED && other.md5 === row.md5;
    })[0];
    if (duplicate) return hold_(row, log, file, root, STATUS.DUPLICATE, '與已存放的「' + duplicate.plannedName + '」內容相同');
    if (!row.plannedName) {
      var target = config.MONTHLY_SUBFOLDER === 'on' ? childFolder_(root, RecordingCore.monthlyFolderName(row.lessonDate)) : root;
      var base = RecordingCore.baseName(row.lessonDate, RecordingCore.studentLabel(row.student, roster, config.NAME_MODE), row.tutor);
      var key = RecordingCore.lessonKey(row.lessonDate, row.student, row.tutor);
      var planned = log.rows.filter(function (other) { return other.plannedName && lessonKeyOf_(other) === key; })
        .map(function (other) { return other.plannedName; });
      row.part = RecordingCore.nextPart(planned, function (name) { return target.getFilesByName(name).hasNext(); }, base, extension);
      row.plannedName = RecordingCore.fileName(base, row.part, extension);
      row.folderId = target.getId();
      save_(log, row); // The plan is saved before Drive changes, so a retry reuses the same name.
    }
    var folder = DriveApp.getFolderById(row.folderId);
    if (!inFolder_(file, row.folderId)) {
      fault_(config, 'move');
      file.moveTo(folder);
    }
    if (file.getName() !== row.plannedName) {
      fault_(config, 'rename');
      file.setName(row.plannedName);
    }
    if (!inFolder_(file, row.folderId) || file.getName() !== row.plannedName) throw new Error('搬移或改名後核對不符');
    row.status = STATUS.STORED;
    row.error = '';
  } catch (error) {
    row.status = STATUS.FAILED;
    row.error = String(error && error.message || error).slice(0, 300);
    if (row.attempts >= maxAttempts) {
      notify_(config, '錄影上傳多次失敗', '上傳紀錄第 ' + row.__row + ' 列已失敗 ' + row.attempts + ' 次：' + row.error);
    }
  }
  row.updatedAt = timestamp_();
  save_(log, row);
}

// Files that must not join the recordings go to an admin-only holding folder, unrenamed.
function hold_(row, log, file, root, status, reason) {
  var quarantine = childFolder_(root, QUARANTINE_FOLDER);
  if (!inFolder_(file, quarantine.getId())) file.moveTo(quarantine);
  row.folderId = quarantine.getId();
  settle_(row, log, status, reason);
}

// Records an outcome without touching Drive.
function settle_(row, log, status, reason) {
  row.status = status;
  row.error = reason;
  row.updatedAt = timestamp_();
  save_(log, row);
}

function checkSettings() {
  var config = readConfig_();
  var problems = settingsProblems_(config, readStudents_());
  var storage = storageStatus_(config);
  var message = [
    '版本 ' + PATHWAY_VERSION + '（' + (config.MODE === 'live' ? '正式模式' : '測試模式') + '）',
    problems.length ? problems.join('\n') : '設定正常：表單題目齊全，目的地資料夾可存取且沒有對外分享。',
    '雲端硬碟用量：' + storage.text + (storage.warning ? '，已達警示門檻' : '')
  ].join('\n\n');
  try { SpreadsheetApp.getUi().alert(message); } catch (error) { /* No dialog from triggers. */ }
  return problems;
}

function dailyReport(e) {
  var config = readConfig_();
  var log = openLog_();
  var count = function (status) { return log.rows.filter(function (row) { return row.status === status; }).length; };
  var anomalies = [];
  var unchecked = 0;
  var started = Date.now();
  // Newest first, so the recordings most likely to be touched are checked even when time runs short.
  log.rows.slice().reverse().forEach(function (row) {
    if (row.status !== STATUS.STORED) return;
    if (Date.now() - started > RUN_BUDGET_MS) {
      unchecked++;
      return;
    }
    var problem = fileProblem_(row, false);
    if (problem) anomalies.push('第 ' + row.__row + ' 列：' + problem);
  });
  var storage = storageStatus_(config);
  var notes = anomalies.slice();
  if (unchecked) notes.push('時間不足，較早的 ' + unchecked + ' 列今天未核對');
  if (storage.warning) notes.push('雲端硬碟用量 ' + storage.text + '，已達 ' + config.STORAGE_WARN_PERCENT + '% 警示門檻');
  var needsReview = count(STATUS.NO_CONSENT) + count(STATUS.DUPLICATE) + count(STATUS.INVALID);
  var summary = [today_(), count(STATUS.STORED), count(STATUS.RECEIVED), count(STATUS.FAILED), needsReview, anomalies.length, storage.text, notes.join('\n')];
  SpreadsheetApp.getActive().getSheetByName(SHEET.REPORT).appendRow(summary);
  if (anomalies.length || unchecked || storage.warning || count(STATUS.FAILED) || needsReview) {
    notify_(config, '每日核對需要處理', '失敗 ' + count(STATUS.FAILED) + '、需人工確認 ' + needsReview + '、檔案異常 ' + anomalies.length +
      (storage.warning ? '、雲端硬碟用量已達 ' + storage.percent + '%' : '') + '。詳見「' + SHEET.REPORT + '」。');
  }
  var result = { stored: summary[1], pending: summary[2], failed: summary[3], needsReview: needsReview, anomalies: anomalies, unchecked: unchecked, storage: storage };
  if (!e) report_('每日核對完成：已存放 ' + result.stored + '、需人工確認 ' + needsReview + '、檔案異常 ' + anomalies.length + '。雲端硬碟 ' + storage.text);
  return result;
}

// Marks stored recordings past RETENTION_DAYS. Nothing is removed here.
function reviewRetention() {
  var config = readConfig_();
  var days = String(config.RETENTION_DAYS).trim();
  if (!days) {
    report_('尚未設定 RETENTION_DAYS，沒有標記任何錄影');
    return { skipped: '尚未設定 RETENTION_DAYS' };
  }
  var log = openLog_();
  var today = today_();
  var marked = 0;
  log.rows.forEach(function (row) {
    if (row.status === STATUS.STORED && RecordingCore.daysBetween(row.lessonDate, today) > Number(days)) {
      settle_(row, log, STATUS.RETENTION_DUE, '已超過保存期限 ' + days + ' 天，待管理員確認刪除');
      marked++;
    }
  });
  report_('已標記 ' + marked + ' 筆到期錄影。要刪除的列請在「確認刪除」填「是」，再執行「移除已確認到期錄影」');
  return { marked: marked };
}

// Moves to Drive trash (recoverable for 30 days) only rows an admin marked 是, and only
// when the file is still the stored one: same folder, same name and same content.
function trashConfirmed() {
  var log = openLog_();
  var trashed = 0;
  var refused = 0;
  log.rows.forEach(function (row) {
    if (row.status !== STATUS.RETENTION_DUE || String(row.confirmDelete).trim() !== '是') return;
    var problem = fileProblem_(row, true);
    if (problem) {
      row.error = problem + '，未刪除；請人工確認';
      refused++;
    } else {
      DriveApp.getFileById(row.fileId).setTrashed(true);
      row.status = STATUS.TRASHED;
      row.error = '已移到雲端硬碟垃圾桶';
      trashed++;
    }
    row.updatedAt = timestamp_();
    save_(log, row);
  });
  report_('已移到垃圾桶 ' + trashed + ' 筆' + (refused ? '；' + refused + ' 筆因檔案和紀錄不符而未刪除' : ''));
  return { trashed: trashed, refused: refused };
}

// Keeps form choices identical to the roster, so file names stay consistent.
function syncFormChoices() {
  var form = openForm_();
  var students = readStudents_().map(function (entry) { return entry.name; });
  var tutors = readColumn_(SHEET.TUTORS);
  form.getItems().forEach(function (item) {
    if (item.getTitle() === FORM.STUDENT) item.asListItem().setChoiceValues(students);
    if (item.getTitle() === FORM.TUTOR) item.asListItem().setChoiceValues(tutors);
  });
  report_('表單選項已更新：學生 ' + students.length + ' 位、小老師 ' + tutors.length + ' 位');
  return { students: students.length, tutors: tutors.length };
}

function settingsProblems_(config, roster) {
  var problems = RecordingCore.validateConfig(config);
  if (problems.length) return problems;
  var formUrl = SpreadsheetApp.getActive().getFormUrl();
  if (!formUrl) return ['這份試算表沒有連結表單，無法讀取上傳的檔案'];
  try {
    var titles = FormApp.openByUrl(formUrl).getItems().map(function (item) { return item.getTitle(); });
    var missing = [FORM.DATE, FORM.STUDENT, FORM.TUTOR, FORM.RECORDED, FORM.FILES, FORM.REASON]
      .filter(function (title) { return titles.indexOf(title) < 0; });
    if (missing.length) problems.push('表單缺少題目：' + missing.join('、') + '（題目名稱必須完全相同）');
  } catch (error) {
    problems.push('無法開啟連結的表單');
  }
  try {
    var folder = DriveApp.getFolderById(config.DEST_FOLDER_ID);
    var access = String(folder.getSharingAccess());
    if (access !== String(DriveApp.Access.PRIVATE)) {
      problems.push('目的地資料夾設為「' + (ACCESS_LABELS[access] || access) + '」可存取，處理已暫停；請改為「限制」，只讓指定的人存取（本程式不會自動修改分享設定）');
    }
    if (config.MODE !== 'live') problems = problems.concat(RecordingCore.testModeProblems(folder.getName(), roster));
  } catch (error) {
    problems.push('無法存取 DEST_FOLDER_ID 指定的資料夾，請確認 ID 與權限');
  }
  return problems;
}

// Forms stops accepting uploads when the owner's Drive is nearly full, so usage is watched.
function storageStatus_(config) {
  try {
    var limit = DriveApp.getStorageLimit();
    var used = DriveApp.getStorageUsed();
    if (!(limit > 0)) return { text: '無法取得容量上限', warning: false };
    var percent = Math.round(used / limit * 1000) / 10;
    return {
      used: used, limit: limit, percent: percent, warning: percent >= Number(config.STORAGE_WARN_PERCENT),
      text: gigabytes_(used) + ' / ' + gigabytes_(limit) + '（' + percent + '%）'
    };
  } catch (error) {
    return { text: '無法讀取雲端硬碟用量', warning: false };
  }
}

function gigabytes_(bytes) {
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

// Why a stored row no longer matches its file in Drive, or '' when it still does.
function fileProblem_(row, checkContent) {
  var file;
  try {
    file = DriveApp.getFileById(row.fileId);
  } catch (error) {
    return '找不到檔案';
  }
  if (file.isTrashed()) return '檔案在垃圾桶';
  if (!inFolder_(file, row.folderId)) return '檔案被移出存放資料夾';
  if (file.getName() !== row.plannedName) return '檔名被改成「' + file.getName() + '」';
  if (!checkContent) return '';
  try {
    if (Drive.Files.get(row.fileId, { fields: 'md5Checksum' }).md5Checksum !== row.md5) return '檔案內容和紀錄不符';
  } catch (error) {
    return '暫時無法核對檔案內容';
  }
  return '';
}

// The only files this script moves, renames or trashes are attached to this form's own
// responses; a file ID typed into the log by hand is refused.
function fromThisForm_(form, row) {
  var responseId = String(row.uploadKey || '').split(':')[0];
  try {
    return parseSubmission_(form.getResponse(responseId)).fileIds.indexOf(row.fileId) >= 0;
  } catch (error) {
    return false;
  }
}

// Picks up recent responses whose submit trigger never ran, failed, or found the lock busy.
function catchUp_(form, log) {
  var logged = {};
  log.rows.forEach(function (row) { logged[String(row.uploadKey).split(':')[0]] = true; });
  var since = new Date(now_().getTime() - CATCH_UP_DAYS * 86400000);
  return form.getResponses(since).reduce(function (added, response) {
    return logged[response.getId()] ? added : added + ingest_(log, response);
  }, 0);
}

// One log row per uploaded file (or one for a lesson taught without recording).
function ingest_(log, response) {
  var submission = parseSubmission_(response);
  var row = {
    receivedAt: timestamp_(submission.submittedAt), uploader: submission.uploader, lessonDate: submission.lessonDate,
    student: submission.student, tutor: submission.tutor, attempts: 0, updatedAt: timestamp_()
  };
  var problem = submissionProblem_(submission);
  var entry = function (fields) { return merge_(merge_({}, row), fields); };
  if (!submission.recorded) {
    return appendRows_(log, [entry({
      uploadKey: submission.responseId + ':none', recorded: FORM.NOT_RECORDED, reason: submission.reason,
      status: problem ? STATUS.INVALID : STATUS.NOT_RECORDED, error: problem
    })]);
  }
  if (!submission.fileIds.length) {
    return appendRows_(log, [entry({
      uploadKey: submission.responseId + ':none', recorded: '有錄影', status: STATUS.INVALID, error: '選擇有錄影但沒有上傳檔案'
    })]);
  }
  return appendRows_(log, submission.fileIds.map(function (fileId) {
    return entry({
      uploadKey: submission.responseId + ':' + fileId, recorded: '有錄影', fileId: fileId,
      status: problem ? STATUS.INVALID : STATUS.RECEIVED, error: problem
    });
  }));
}

function parseSubmission_(response) {
  var answers = {};
  response.getItemResponses().forEach(function (itemResponse) {
    answers[itemResponse.getItem().getTitle()] = itemResponse.getResponse();
  });
  return {
    responseId: response.getId(),
    submittedAt: response.getTimestamp ? response.getTimestamp() : null,
    uploader: response.getRespondentEmail ? response.getRespondentEmail() : '',
    lessonDate: String(answers[FORM.DATE] || ''),
    student: String(answers[FORM.STUDENT] || ''),
    tutor: String(answers[FORM.TUTOR] || ''),
    recorded: answers[FORM.RECORDED] !== FORM.NOT_RECORDED,
    fileIds: answers[FORM.FILES] || [],
    reason: String(answers[FORM.REASON] || '')
  };
}

function submissionProblem_(submission) {
  try {
    RecordingCore.lessonKey(submission.lessonDate, submission.student, submission.tutor);
  } catch (error) {
    return error.message;
  }
  // Recordings are uploaded after the lesson, so a future date is a typo that would misfile them.
  return submission.lessonDate > today_() ? '上課日期不能晚於今天' : '';
}

function readConfig_() {
  var config = merge_({}, CONFIG_DEFAULTS);
  SpreadsheetApp.getActive().getSheetByName(SHEET.CONFIG).getDataRange().getValues().slice(1).forEach(function (values) {
    var key = String(values[0]).trim();
    if (key && String(values[1]).trim() !== '') config[key] = String(values[1]).trim();
  });
  return config;
}

function readStudents_() {
  return SpreadsheetApp.getActive().getSheetByName(SHEET.STUDENTS).getDataRange().getValues().slice(1)
    .filter(function (values) { return String(values[0]).trim(); })
    .map(function (values) { return { name: String(values[0]).trim(), code: String(values[1]).trim(), consent: String(values[2]).trim() }; });
}

function readColumn_(sheetName) {
  return SpreadsheetApp.getActive().getSheetByName(sheetName).getDataRange().getValues().slice(1)
    .map(function (values) { return String(values[0]).trim(); })
    .filter(Boolean);
}

function openForm_() {
  return FormApp.openByUrl(SpreadsheetApp.getActive().getFormUrl());
}

function openLog_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET.LOG);
  var values = sheet.getDataRange().getValues();
  var headers = LOG_COLUMNS.map(function (column) { return column[1]; });
  if (headers.join('\t') !== values[0].slice(0, headers.length).join('\t')) {
    throw new Error('「' + SHEET.LOG + '」欄位順序被更動，為避免寫錯資料已停止處理');
  }
  var rows = values.slice(1).map(function (rowValues, index) {
    var row = { __row: index + 2 };
    LOG_COLUMNS.forEach(function (column, columnIndex) {
      var value = rowValues[columnIndex];
      row[column[0]] = TEXT_COLUMNS.indexOf(column[0]) >= 0 && typeof value === 'string' ? value.replace(/^'/, '') : value;
    });
    row.lessonDate = dateText_(row.lessonDate);
    return row;
  });
  return { sheet: sheet, rows: rows };
}

function save_(log, row) {
  log.sheet.getRange(row.__row, 1, 1, LOG_COLUMNS.length).setValues([toValues_(row)]);
}

// Adds rows not logged yet, all in one write, so a response is never half logged. A row is
// already logged when its upload key or its file is; the same file never gets two rows.
function appendRows_(log, rows) {
  var fresh = rows.filter(function (row) {
    return !log.rows.some(function (existing) {
      return existing.uploadKey === row.uploadKey || (row.fileId && existing.fileId === row.fileId);
    });
  });
  if (!fresh.length) return 0;
  var first = log.sheet.getLastRow() + 1;
  log.sheet.getRange(first, 1, fresh.length, LOG_COLUMNS.length).setValues(fresh.map(toValues_));
  fresh.forEach(function (row, index) {
    row.__row = first + index;
    log.rows.push(row);
  });
  return fresh.length;
}

function toValues_(row) {
  return LOG_COLUMNS.map(function (column) {
    var value = row[column[0]];
    if (value == null || value === '') return '';
    // A leading apostrophe stores text, so Sheets cannot turn dates, IDs or checksums into dates or numbers.
    return TEXT_COLUMNS.indexOf(column[0]) >= 0 ? "'" + value : value;
  });
}

function lessonKeyOf_(row) {
  try { return RecordingCore.lessonKey(row.lessonDate, row.student, row.tutor); } catch (error) { return ''; }
}

function inFolder_(file, folderId) {
  var parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) return true;
  return false;
}

function childFolder_(parent, name) {
  var existing = parent.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : parent.createFolder(name);
}

function ensureSheet_(spreadsheet, name, headers) {
  if (spreadsheet.getSheetByName(name)) return;
  spreadsheet.insertSheet(name).appendRow(headers);
}

function prepare_(spreadsheet) {
  if (!spreadsheet.getFormUrl()) throw new Error('這份試算表還沒有連結表單：請先在表單的「回覆」分頁選擇連結到這份試算表');
  ensureSheet_(spreadsheet, SHEET.CONFIG, ['設定項目', '值', '說明']);
  ensureConfigRows_(spreadsheet.getSheetByName(SHEET.CONFIG));
  ensureSheet_(spreadsheet, SHEET.STUDENTS, ['學生姓名', '學生代碼', '錄影同意', '同意日期', '備註']);
  ensureSheet_(spreadsheet, SHEET.TUTORS, ['小老師姓名']);
  ensureSheet_(spreadsheet, SHEET.LOG, LOG_COLUMNS.map(function (column) { return column[1]; }));
  ensureSheet_(spreadsheet, SHEET.REPORT, REPORT_COLUMNS);
}

function ensureConfigRows_(sheet) {
  var keys = sheet.getDataRange().getValues().map(function (values) { return String(values[0]).trim(); });
  CONFIG_ROWS.forEach(function (row) {
    if (keys.indexOf(row[0]) < 0) sheet.appendRow(row);
  });
}

function deleteTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  return triggers.length;
}

function notify_(config, subject, body) {
  var recipients = String(config.ADMIN_EMAILS || '').trim();
  if (!recipients) return false;
  // Messages carry row numbers and statuses only; names stay in the restricted sheet.
  var prefix = config.MODE === 'live' ? '[iHear 錄影上傳] ' : '[iHear 錄影上傳][測試] ';
  try {
    MailApp.sendEmail(recipients, prefix + subject, body);
    return true;
  } catch (error) {
    console.error('通知寄送失敗：' + error.message); // For example, the daily email quota is used up.
    return false;
  }
}

// A blocked queue is retried every 15 minutes; the same problem is emailed at most once a day.
function notifyBlocked_(config, problems) {
  var properties = PropertiesService.getScriptProperties();
  var text = problems.join('\n');
  var last = JSON.parse(properties.getProperty(BLOCKED_NOTICE) || '{}');
  if (last.text === text && now_().getTime() - last.at < 86400000) return;
  if (notify_(config, '錄影上傳已暫停：設定需要修正', text)) {
    properties.setProperty(BLOCKED_NOTICE, JSON.stringify({ text: text, at: now_().getTime() }));
  }
}

// A short note for whoever has the spreadsheet open; without a UI it is skipped quietly.
function report_(text) {
  try { SpreadsheetApp.getActive().toast(text, '錄影上傳', 15); } catch (error) { /* No spreadsheet UI. */ }
}

// Test mode only: TEST_FAULT makes one processing step fail on purpose, so retries and
// failure notices can be checked in the real Google environment.
function fault_(config, step) {
  if (config.MODE !== 'live' && config.TEST_FAULT === step) throw new Error('測試用模擬失敗（TEST_FAULT=' + step + '）');
}

function dateText_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value == null ? '' : value).replace(/^'/, '');
}

function merge_(target, source) {
  Object.keys(source).forEach(function (key) { target[key] = source[key]; });
  return target;
}

function now_() {
  return new Date();
}

function today_() {
  return Utilities.formatDate(now_(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function timestamp_(date) {
  return Utilities.formatDate(date || now_(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}
