// In-memory stand-ins for the Google services the pathway uses. They copy the behaviours
// that matter here: Sheets turns date-like and number-like text into dates and numbers
// unless it starts with an apostrophe, Drive keeps same-named files side by side, form
// responses stay readable after submission, and Drive calls can fail. Nothing here talks to Google.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps-script');
const GiB = 1024 ** 3;

export const DEFAULT_STUDENTS = [
  ['王小明', 'TEST-S001', '已同意', "'2026-10-01", ''],
  ['林小華', 'TEST-S002', '未同意', '', ''],
  ['Emma Lee', 'TEST-S003', '已同意', "'2026-10-02", ''],
];

export function createEnvironment({
  students, tutors, config, destFolderId = 'DESTFOLDER000001', destName = '[測試] iHear 錄影存放區', sharing = 'PRIVATE',
  loadOrder = ['Core.js', 'Code.js'],
} = {}) {
  const env = {
    mail: [], toasts: [], triggers: [], failures: {}, locked: false, counter: 0,
    now: new Date('2026-10-23T15:00:00+08:00'), storage: { used: 2 * GiB, limit: 15 * GiB },
    formUrl: 'https://docs.google.com/forms/d/FAKE-FORM/edit',
  };
  const folders = new Map();
  const files = new Map();
  const responses = new Map();
  const nextId = prefix => `${prefix}${String(++env.counter).padStart(8, '0')}`;
  const fail = name => {
    if (env.failures[name] > 0) {
      env.failures[name] -= 1;
      throw new Error(`模擬 ${name} 失敗`);
    }
  };
  const iterator = items => {
    let index = 0;
    return { hasNext: () => index < items.length, next: () => items[index++] };
  };

  function addFolder(name, parent = null, access = 'PRIVATE', id = nextId('FOLDER')) {
    folders.set(id, { id, name, parent, access });
    return id;
  }
  function folderHandle(id) {
    const folder = folders.get(id);
    if (!folder) throw new Error('No item with the given ID could be found.');
    return {
      getId: () => folder.id,
      getName: () => folder.name,
      getSharingAccess: () => folder.access,
      getFilesByName: name => iterator([...files.values()]
        .filter(file => !file.deleted && !file.trashed && file.parents.has(id) && file.name === name).map(file => fileHandle(file.id))),
      getFoldersByName: name => iterator([...folders.values()]
        .filter(child => child.parent === id && child.name === name).map(child => folderHandle(child.id))),
      createFolder: name => folderHandle(addFolder(name, id)),
    };
  }
  function fileHandle(id) {
    const file = files.get(id);
    if (!file || file.deleted) throw new Error('No item with the given ID could be found.');
    return {
      getId: () => file.id,
      getName: () => file.name,
      setName: name => { fail('setName'); file.name = name; file.writes += 1; },
      getSize: () => file.size ?? file.bytes.length,
      getMimeType: () => file.mimeType,
      getParents: () => iterator([...file.parents].map(folderHandle)),
      moveTo: folder => { fail('moveTo'); file.parents = new Set([folder.getId()]); file.writes += 1; },
      isTrashed: () => file.trashed,
      setTrashed: value => { file.trashed = value; file.writes += 1; },
    };
  }

  const uploadsFolderId = addFolder('表單上傳 (錄影檔)', null, 'PRIVATE', 'FORMUPLOADS00001');
  addFolder(destName, null, sharing, destFolderId);

  // A fake video: a few synthetic bytes, never a real recording. `size` pretends it is larger.
  env.upload = (name, content = name, mimeType = /\.m4a$/i.test(name) ? 'audio/mp4' : /\.(pdf|txt)$/i.test(name) ? 'application/pdf' : 'video/mp4', { size, folderId = uploadsFolderId } = {}) => {
    const id = nextId('FILE');
    files.set(id, { id, name, mimeType, bytes: Buffer.from(`FAKE-VIDEO:${content}`), size, parents: new Set([folderId]), trashed: false, deleted: false, writes: 0 });
    return id;
  };
  env.md5 = id => createHash('md5').update(files.get(id).bytes).digest('hex');
  env.addFolder = addFolder;
  env.folders = folders;
  env.files = files;
  env.file = id => files.get(id);
  env.filesIn = folderId => [...files.values()].filter(file => !file.trashed && file.parents.has(folderId)).map(file => file.name).sort();
  env.childFolderId = (parentId, name) => [...folders.values()].find(folder => folder.parent === parentId && folder.name === name)?.id;

  // Sheets
  const sheets = new Map();
  let realmDate = Date;
  const convert = value => {
    if (typeof value !== 'string') return value;
    if (value.startsWith("'")) return value.slice(1);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new realmDate(`${value}T00:00:00+08:00`);
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return Number(value);
    return value;
  };
  function sheet(name, rows = []) {
    const data = rows.map(row => row.map(convert));
    const handle = {
      data,
      getName: () => name,
      getDataRange: () => ({ getValues: () => (data.length ? data : [['']]).map(row => row.slice()) }),
      appendRow: values => { data.push(values.map(convert)); return handle; },
      getLastRow: () => data.length,
      getRange: (row, column, numRows, numColumns) => ({
        setValues: values => {
          for (let r = 0; r < numRows; r++) {
            while (data.length < row + r) data.push([]);
            for (let c = 0; c < numColumns; c++) data[row - 1 + r][column - 1 + c] = convert(values[r][c]);
          }
        },
      }),
    };
    sheets.set(name, handle);
    return handle;
  }
  const configRows = [['設定項目', '值', '說明'], ...Object.entries({
    DEST_FOLDER_ID: destFolderId, MONTHLY_SUBFOLDER: 'off', NAME_MODE: 'full', RETENTION_DAYS: '', MAX_ATTEMPTS: '3', ADMIN_EMAILS: 'admin@example.org', ...config,
  }).map(([key, value]) => [key, value, ''])];
  sheet('設定', configRows);
  sheet('學生名單', [['學生姓名', '學生代碼', '錄影同意', '同意日期', '備註'], ...(students || DEFAULT_STUDENTS)]);
  sheet('小老師名單', [['小老師姓名'], ...(tutors || [['陳小老師'], ['Alex Chen']])]);
  env.sheets = sheets;
  env.setConfig = (key, value) => {
    const rows = sheets.get('設定').data;
    const row = rows.find(values => values[0] === key);
    if (row) row[1] = convert(value);
    else rows.push([key, convert(value), '']);
  };

  // Forms: responses stay readable, as getResponse and getResponses read them back later.
  const formItems = ['上課日期', '學生', '小老師', '本堂是否錄影', '錄影檔', '未錄影原因'].map(title => {
    const item = { title, choices: null };
    return { item, handle: { getTitle: () => title, asListItem: () => ({ setChoiceValues: values => { item.choices = values; } }) } };
  });
  env.formItems = formItems.map(entry => entry.item);
  env.removeFormItem = title => formItems.splice(formItems.findIndex(entry => entry.item.title === title), 1);
  const responseHandle = response => ({
    getId: () => response.id,
    getTimestamp: () => new Date(response.at),
    getRespondentEmail: () => response.email,
    getItemResponses: () => Object.entries(response.answers)
      .map(([title, value]) => ({ getItem: () => ({ getTitle: () => title }), getResponse: () => value })),
  });
  const form = {
    getItems: () => formItems.map(entry => entry.handle),
    getResponses: since => [...responses.values()].filter(response => !since || response.at > since.getTime()).map(responseHandle),
    getResponse: id => {
      if (!responses.has(id)) throw new Error('Invalid argument: id');
      return responseHandle(responses.get(id));
    },
  };
  env.responses = responses;

  const properties = new Map();
  const globals = {
    SpreadsheetApp: {
      getActive: () => spreadsheet,
      getActiveSpreadsheet: () => spreadsheet,
      getUi: () => { throw new Error('No UI in tests'); },
    },
    DriveApp: {
      Access: { ANYONE: 'ANYONE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN', DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK', PRIVATE: 'PRIVATE' },
      getFileById: fileHandle,
      getFolderById: folderHandle,
      getStorageLimit: () => env.storage.limit,
      getStorageUsed: () => env.storage.used,
    },
    Drive: {
      Files: {
        get: id => {
          fail('md5');
          const file = files.get(id);
          if (!file || file.deleted) throw new Error('File not found');
          return { md5Checksum: createHash('md5').update(file.bytes).digest('hex') };
        },
      },
    },
    LockService: { getScriptLock: () => ({ tryLock: () => !env.locked, releaseLock: () => {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => (properties.has(key) ? properties.get(key) : null),
        setProperty: (key, value) => { properties.set(key, String(value)); },
        deleteProperty: key => { properties.delete(key); },
      }),
    },
    ScriptApp: {
      AuthMode: { FULL: 'FULL' },
      // Granular consent: the owner may have left some permissions unticked.
      requireAllScopes: () => { if (env.missingScopes) throw new Error('需要授權：部分權限尚未同意'); },
      getProjectTriggers: () => env.triggers.slice(),
      deleteTrigger: trigger => { env.triggers.splice(env.triggers.indexOf(trigger), 1); },
      newTrigger: handler => {
        const create = kind => () => { env.triggers.push({ handler, kind }); return env.triggers.at(-1); };
        return {
          forForm: () => ({ onFormSubmit: () => ({ create: create('formSubmit') }) }),
          timeBased: () => ({
            everyMinutes: minutes => ({ create: create(`every ${minutes} minutes`) }),
            everyDays: () => ({ atHour: hour => ({ create: create(`daily at ${hour}`) }) }),
          }),
        };
      },
    },
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    Utilities: {
      formatDate: (date, timeZone, pattern) => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).formatToParts(date).map(part => [part.type, part.value]));
        return pattern.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
          .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
      },
    },
    MailApp: { sendEmail: (to, subject, body) => { fail('mail'); env.mail.push({ to, subject, body }); } },
    FormApp: { openByUrl: () => form },
  };
  const spreadsheet = {
    getSheetByName: name => sheets.get(name) || null,
    insertSheet: name => sheet(name),
    getFormUrl: () => env.formUrl,
    toast: text => { env.toasts.push(text); },
  };

  const context = vm.createContext({ ...globals, console: { ...console, error: message => { env.errors = [...(env.errors || []), message]; } } });
  realmDate = vm.runInContext('Date', context);
  env.RealmDate = realmDate;
  // Apps Script runs files in editor order, so the tests can load them in either order.
  for (const fileName of loadOrder) {
    vm.runInContext(readFileSync(path.join(scriptDir, fileName), 'utf8'), context, { filename: fileName });
  }
  context.now_ = () => env.now;
  context.ensureSheet_(spreadsheet, '上傳紀錄', context.LOG_COLUMNS.map(column => column[1]));
  context.ensureSheet_(spreadsheet, '每日核對', context.REPORT_COLUMNS);
  env.app = context;
  env.log = () => context.openLog_().rows;

  // A form submission. `trigger: false` stands for a submit trigger that never ran.
  env.submit = ({ id = nextId('RESP'), email = 'tutor@example.org', date = '2026-10-23', student = '王小明', tutor = '陳小老師', recorded = true, fileIds = [], reason = '', trigger = true }) => {
    const answers = { 上課日期: date, 學生: student, 小老師: tutor, 本堂是否錄影: recorded ? '有錄影' : '整堂未錄影' };
    if (recorded) answers['錄影檔'] = fileIds;
    else answers['未錄影原因'] = reason;
    const response = { id, email, answers, at: env.now.getTime() };
    responses.set(id, response);
    if (trigger) context.onFormSubmit({ response: responseHandle(response), source: form });
    return id;
  };
  return env;
}
