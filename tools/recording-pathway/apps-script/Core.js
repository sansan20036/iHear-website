// Pure rules for the recording upload pathway. No Google services are used here,
// so the same file runs in Apps Script and in the local Node tests.
var RecordingCore = (function () {
  var CONSENT_GRANTED = '已同意';
  var ALLOWED_EXTENSIONS = ['mp4', 'm4a', 'mov'];
  var FAULTS = ['move', 'rename', 'md5'];
  var TEST_FOLDER_PREFIX = '[測試]';
  var TEST_CODE_PREFIX = 'TEST-';
  var FOLDER_ID = /^[A-Za-z0-9_-]{10,}$/;
  var EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var PART = /_P(\d{2,})\.[a-z0-9]+$/;

  // Windows/macOS/Drive-unsafe characters and control characters become a hyphen.
  function cleanName(value, maxLength) {
    var text = String(value == null ? '' : value).normalize('NFC')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.-]+|[\s.-]+$/g, '');
    if (!text) throw new Error('名稱不可為空白');
    return text.slice(0, maxLength || 40).trim();
  }

  function lessonDate(value) {
    var match = DATE.exec(String(value || '').trim());
    if (!match) throw new Error('上課日期格式必須是 YYYY-MM-DD');
    var date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    if (date.getUTCFullYear() !== +match[1] || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) {
      throw new Error('上課日期不存在：' + value);
    }
    return match[0];
  }

  function daysBetween(fromDate, toDate) {
    var from = DATE.exec(lessonDate(fromDate));
    var to = DATE.exec(lessonDate(toDate));
    return Math.round((Date.UTC(+to[1], +to[2] - 1, +to[3]) - Date.UTC(+from[1], +from[2] - 1, +from[3])) / 86400000);
  }

  function extensionOf(fileName, mimeType) {
    var match = /\.([A-Za-z0-9]+)$/.exec(String(fileName || ''));
    var extension = match ? match[1].toLowerCase() : '';
    if (ALLOWED_EXTENSIONS.indexOf(extension) < 0) return null;
    if (mimeType && !/^(video|audio)\//.test(mimeType)) return null;
    return extension;
  }

  function lessonKey(date, student, tutor) {
    return [lessonDate(date), cleanName(student), cleanName(tutor)].join('|');
  }

  function baseName(date, studentLabel, tutor) {
    return lessonDate(date) + '_' + cleanName(studentLabel) + '_' + cleanName(tutor);
  }

  function fileName(base, part, extension) {
    if (!(part >= 1)) throw new Error('段數必須從 1 開始');
    return base + '_P' + (part < 10 ? '0' + part : String(part)) + '.' + extension;
  }

  function partOf(name) {
    var match = PART.exec(String(name || ''));
    return match ? Number(match[1]) : 0;
  }

  // Next free part: after every part already planned for this lesson, and never a name
  // that already exists in the destination folder (Drive would keep both silently).
  function nextPart(plannedNames, nameExists, base, extension) {
    var part = 1;
    for (var i = 0; i < plannedNames.length; i++) part = Math.max(part, partOf(plannedNames[i]) + 1);
    while (nameExists(fileName(base, part, extension))) part++;
    return part;
  }

  // Student label in file names: the full name (default) or the roster code.
  function studentLabel(student, roster, nameMode) {
    if (nameMode !== 'code') return cleanName(student);
    var entry = findStudent(roster, student);
    if (!entry || !entry.code) throw new Error('名單中找不到學生代碼：' + student);
    return cleanName(entry.code, 20);
  }

  function findStudent(roster, student) {
    var name = cleanName(student);
    for (var i = 0; i < roster.length; i++) {
      if (cleanName(roster[i].name) === name) return roster[i];
    }
    return null;
  }

  function hasConsent(roster, student) {
    var entry = findStudent(roster, student);
    return !!entry && String(entry.consent || '').trim() === CONSENT_GRANTED;
  }

  function monthlyFolderName(date) {
    var match = DATE.exec(lessonDate(date));
    return '[iHear] ' + match[2] + '.' + match[1] + '.Zoom Recordings';
  }

  function validateConfig(config) {
    var problems = [];
    var mode = config.MODE || 'test';
    if (['test', 'live'].indexOf(mode) < 0) problems.push('MODE 只能是 test 或 live');
    if (!FOLDER_ID.test(String(config.DEST_FOLDER_ID || ''))) problems.push('DEST_FOLDER_ID 不是有效的 Google Drive 資料夾 ID');
    if (['full', 'code'].indexOf(config.NAME_MODE || 'full') < 0) problems.push('NAME_MODE 只能是 full 或 code');
    if (['on', 'off'].indexOf(config.MONTHLY_SUBFOLDER || 'off') < 0) problems.push('MONTHLY_SUBFOLDER 只能是 on 或 off');
    var retention = String(config.RETENTION_DAYS == null ? '' : config.RETENTION_DAYS).trim();
    if (retention && !/^[1-9]\d{0,3}$/.test(retention)) problems.push('RETENTION_DAYS 必須是 1–9999 的整數，或留白表示尚未設定');
    var attempts = String(config.MAX_ATTEMPTS == null ? '' : config.MAX_ATTEMPTS).trim();
    if (attempts && !/^[1-9]$/.test(attempts)) problems.push('MAX_ATTEMPTS 必須是 1–9');
    var warn = String(config.STORAGE_WARN_PERCENT == null ? '' : config.STORAGE_WARN_PERCENT).trim();
    if (warn && !/^[1-9]\d?$/.test(warn)) problems.push('STORAGE_WARN_PERCENT 必須是 1–99');
    var emails = String(config.ADMIN_EMAILS || '').split(',').map(function (email) { return email.trim(); }).filter(Boolean);
    if (emails.some(function (email) { return !EMAIL.test(email); })) problems.push('ADMIN_EMAILS 有格式不正確的信箱');
    var fault = String(config.TEST_FAULT || '').trim();
    if (fault && FAULTS.indexOf(fault) < 0) problems.push('TEST_FAULT 只能是 move、rename、md5 或留白');
    if (mode === 'live') {
      if (fault) problems.push('正式模式的 TEST_FAULT 必須留白');
      if (!emails.length) problems.push('正式模式必須設定 ADMIN_EMAILS，才收得到異常通知');
      if (!retention) problems.push('正式模式必須先決定 RETENTION_DAYS（保存天數）');
    }
    return problems;
  }

  // Test mode keeps trial runs away from real recordings: only a "[測試]" destination
  // and synthetic students. Messages give counts, never names.
  function testModeProblems(folderName, roster) {
    var problems = [];
    if (String(folderName || '').indexOf(TEST_FOLDER_PREFIX) !== 0) {
      problems.push('測試模式只能使用名稱以「' + TEST_FOLDER_PREFIX + '」開頭的目的地資料夾，處理已暫停');
    }
    var real = roster.filter(function (entry) { return String(entry.code || '').indexOf(TEST_CODE_PREFIX) !== 0; }).length;
    if (real) problems.push('學生名單有 ' + real + ' 位學生的代碼不是以「' + TEST_CODE_PREFIX + '」開頭；測試模式只能使用合成資料');
    return problems;
  }

  return {
    CONSENT_GRANTED: CONSENT_GRANTED,
    TEST_FOLDER_PREFIX: TEST_FOLDER_PREFIX,
    TEST_CODE_PREFIX: TEST_CODE_PREFIX,
    cleanName: cleanName,
    lessonDate: lessonDate,
    daysBetween: daysBetween,
    extensionOf: extensionOf,
    lessonKey: lessonKey,
    baseName: baseName,
    fileName: fileName,
    partOf: partOf,
    nextPart: nextPart,
    studentLabel: studentLabel,
    findStudent: findStudent,
    hasConsent: hasConsent,
    monthlyFolderName: monthlyFolderName,
    validateConfig: validateConfig,
    testModeProblems: testModeProblems
  };
})();

if (typeof module !== 'undefined') module.exports = RecordingCore;
