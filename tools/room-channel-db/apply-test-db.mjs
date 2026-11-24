// The room channel's four tables (db/room-channel/031…) on the TEST database of the online test
// environment, and the way back (2026-11-24). The draft is not in db/migrations, so the release
// tool's migrate-test-db (which brings a test database to 030) does not apply it; this step does,
// after it, through the site's own scripts/migrate-database.mjs, so the ledger records 031 as it
// will for any database later.
//
//   node tools/room-channel-db/apply-test-db.mjs --db-env <test-db.env> --expect-ref <project ref>
//        --evidence <file.json> [--execute --authorization "<the user's words>"]
//   … --down [--discard-rows] [--execute --authorization "<the user's words>"]
//
// Refused before anything reaches a database when:
//   - the address in test-db.env is not a Supabase address, or names another project than
//     --expect-ref (the reference the owner gave for the test project; never written in this code);
//   - this checkout holds any .env file (a checkout's .env.local can be the live database);
//   - the migration files or this folder differ from what is committed, or db/migrations does not
//     end at 030.
// Then the database is asked, read only. It must carry the test marker migrate-test-db leaves (an
// empty or unmarked database is refused: it is not a test database prepared for this), and its
// ledger must end exactly at 030. Already at 031 with the same file: "already applied", nothing
// written.
// Without --execute nothing is written anywhere. With it (and the user's words, which are kept in
// the evidence): the draft is copied beside 001–030 in a temporary folder and the site's own
// runner applies it with an environment that holds the test database's address and nothing else
// that could name a database; then the database is asked again: the ledger at 031 with this file's
// checksum, four tables, each protected and without a policy, empty, and every other table with
// the rows it had. --down takes the tables and the ledger's record away again in one transaction.
// The address, its user and its password are never printed or saved; the evidence holds counts.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrationChecksum } from '../../scripts/migration-checksum.mjs';
import { parseArgs, readSettingsFile, redactor, REPO_ROOT } from '../classroom-preflight/common.mjs';
import { BEFORE, DOWN_FILE, ENV_FILES, FILE, isProjectRef, secretsOf, sessionUrl, testDatabaseRef, VERSION } from './shared.mjs';

const OPTIONS = { 'db-env': 'value', 'expect-ref': 'value', evidence: 'value', authorization: 'value', execute: 'flag', down: 'flag', 'discard-rows': 'flag', help: 'flag' };
const USAGE = 'node tools/room-channel-db/apply-test-db.mjs --db-env <test-db.env> --expect-ref <ref> --evidence <file.json> [--down [--discard-rows]] [--execute --authorization "<the user\'s words>"]';
const STEP = path.join(REPO_ROOT, 'tools', 'room-channel-db', 'db-step.mjs');
const TRACKED = ['db/room-channel', 'db/migrations', 'scripts/migrate-database.mjs', 'scripts/migration-checksum.mjs', 'tools/room-channel-db'];

function run(cmd, args, { cwd, env } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => resolve({ code: 127, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
// A child process with exactly the environment given: nothing of this process's own environment
// (which could name another database) is passed on.
export const cleanEnv = extra => ({ PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: os.tmpdir(), TMP: os.tmpdir(), ...extra });

// 001–030 as committed and the draft as 031, in a folder of its own: the runner reads
// db/migrations from where it runs, and there is no .env file there.
function workspaceWith(migrations) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ihear-room-channel-031-'));
  mkdirSync(path.join(directory, 'db', 'migrations'), { recursive: true });
  for (const name of migrations) copyFileSync(path.join(REPO_ROOT, 'db', 'migrations', name), path.join(directory, 'db', 'migrations', name));
  copyFileSync(path.join(REPO_ROOT, 'db', 'room-channel', FILE), path.join(directory, 'db', 'migrations', FILE));
  return directory;
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv, OPTIONS);
  const exec = deps.exec ?? run;
  const exists = deps.exists ?? existsSync;
  const readSettings = deps.readSettings ?? readSettingsFile;
  const readText = deps.readText ?? (file => readFileSync(file, 'utf8'));
  const listMigrations = deps.listMigrations ?? (directory => readdirSync(directory).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name)).sort());
  const writeFile = deps.writeFile ?? writeFileSync;
  const makeWorkspace = deps.makeWorkspace ?? workspaceWith;
  const removeDirectory = deps.removeDirectory ?? (directory => rmSync(directory, { recursive: true, force: true }));
  const targetOf = deps.target ?? testDatabaseRef;
  const childExtra = deps.childEnv ?? {};
  const now = deps.now ?? (() => Date.now());
  let say = deps.log ?? console.log;
  if (args.help) { say(USAGE); return 0; }

  for (const name of ['db-env', 'expect-ref', 'evidence']) if (!args[name]) throw new Error(`Give --${name}`);
  const expectRef = String(args['expect-ref']);
  if (!isProjectRef(expectRef)) throw new Error('--expect-ref is a Supabase project reference (20 lowercase letters and digits)');
  const evidence = path.resolve(String(args.evidence));
  if (!path.relative(REPO_ROOT, evidence).startsWith('..') || /[\\/]OneDrive[^\\/]*[\\/]/i.test(evidence)) throw new Error('--evidence must be outside the repository and outside OneDrive');
  const authorization = String(args.authorization ?? '').trim();
  if (args.execute && authorization.length < 6) throw new Error('--execute needs --authorization "<the user\'s words>": every write to the test database is the user\'s own approval');
  if (args['discard-rows'] && !args.down) throw new Error('--discard-rows goes with --down');
  const action = args.down ? 'down' : 'apply';

  const url = readSettings(String(args['db-env']), { allowed: new Set(['POSTGRES_URL']) }).POSTGRES_URL;
  if (!url) throw new Error('The settings file holds no POSTGRES_URL');
  const hide = redactor(secretsOf(url));
  const plain = say;
  say = text => plain(hide(text));
  const line = (status, id, text) => say(`${status.padEnd(5)} ${id.padEnd(18)} ${text}`);
  const stop = (id, text) => { line('STOP', id, text); say('Nothing was written.'); return 1; };

  // 1. The address: a Supabase project, and the one named on the command line.
  const target = targetOf(url);
  if (target.error) return stop('db.address', target.error);
  if (target.ref !== expectRef) return stop('db.address', 'the settings file names another project than --expect-ref');
  line('PASS', 'db.address', `project ${expectRef}`);

  // 2. This checkout: no .env file, the files as committed, and migrations that end at 030.
  const envFiles = ENV_FILES.filter(name => exists(path.join(REPO_ROOT, name)));
  if (envFiles.length) return stop('tree.env-files', `${envFiles.join(', ')} in this checkout: run from a checkout without them`);
  line('PASS', 'tree.env-files', 'no .env file in this checkout');
  const status = await exec('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', ...TRACKED]);
  if (status.code !== 0) return stop('tree.clean', 'git could not say whether the files are as committed');
  if (status.stdout.trim()) return stop('tree.clean', 'the migration files or this step differ from what is committed');
  const head = (await exec('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'])).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) return stop('tree.clean', 'git gave no commit for this checkout');
  line('PASS', 'tree.clean', `the files are as committed at ${head.slice(0, 7)}`);
  const migrations = listMigrations(path.join(REPO_ROOT, 'db', 'migrations'));
  const last = migrations.at(-1)?.split('_', 1)[0] ?? null;
  if (last !== BEFORE) return stop('tree.migrations', `db/migrations ends at ${last ?? 'nothing'}; this step is for a tree that ends at ${BEFORE}`);
  const checksum = migrationChecksum(readText(path.join(REPO_ROOT, 'db', 'room-channel', FILE)));
  line('PASS', 'tree.migrations', `${migrations.length} migration(s) to ${BEFORE}; the draft's checksum ${checksum.slice(0, 12)}…`);

  // 3. The database itself, read only.
  const address = sessionUrl(url);
  const ask = async (mode, more = {}) => {
    const answer = await exec(process.execPath, [STEP, mode], { cwd: os.tmpdir(), env: cleanEnv({ TEST_DB_URL: address, ...childExtra, ...more }) });
    if (answer.code !== 0) throw new Error(`the database could not be ${mode === 'down' ? 'changed' : 'read'}: ${hide(answer.stderr.trim()).slice(0, 200)}`);
    return JSON.parse(answer.stdout.trim().split('\n').pop());
  };
  const before = await ask('probe');
  if (!before.marked) return stop('db.marker', 'no test marker: this is not a database the release tool prepared as a test database');
  line('PASS', 'db.marker', 'the test marker is there');

  const record = { tool: 'room-channel-db/apply-test-db', action, at: new Date(now()).toISOString(), expectRef, head, file: FILE, checksum, authorization, before, after: null, runner: null, failures: [], result: 'PASS' };
  const finish = failures => {
    record.failures = failures;
    record.result = failures.length ? 'FAIL' : 'PASS';
    writeFile(evidence, `${hide(JSON.stringify(record, null, 2))}\n`);
    for (const failure of failures) line('FAIL', 'after', failure);
    line(failures.length ? 'FAIL' : 'PASS', 'result', failures.length ? `${failures.length} thing(s) are not as they must be; evidence written` : `done; evidence: ${path.basename(evidence)}`);
    return failures.length ? 1 : 0;
  };

  if (action === 'apply') {
    if (before.latest === VERSION) {
      if (before.roomTables !== 4 || before.recorded !== checksum) return stop('db.ledger', `${VERSION} is recorded, but the tables or the recorded file are not this draft's`);
      line('PASS', 'db.ledger', `already applied: the ledger ends at ${VERSION} with this file; nothing to do`);
      say('Nothing was written.');
      return 0;
    }
    if (before.latest !== BEFORE) return stop('db.ledger', `the ledger ends at ${before.latest ?? 'nothing'}; this step needs exactly ${BEFORE}`);
    if (before.roomTables !== 0) return stop('db.tables', `${before.roomTables} of the room channel's tables exist without their record`);
    line('PASS', 'db.ledger', `the ledger ends at ${BEFORE} (${before.migrations} recorded); ${before.otherTables} other table(s)`);
    if (!args.execute) {
      line('INFO', 'plan', `would apply ${FILE} through the site's own runner (session pooler), then ask again`);
      say('Dry run: nothing was written. Add --execute and --authorization to apply.');
      return 0;
    }
    const workspace = makeWorkspace(migrations);
    try {
      const ran = await exec(process.execPath, [path.join(REPO_ROOT, 'scripts', 'migrate-database.mjs')], { cwd: workspace, env: cleanEnv({ POSTGRES_URL: address, DATABASE_URL: '', ...childExtra }) });
      let report = {};
      try { report = JSON.parse(String(ran.code === 0 ? ran.stdout : ran.stderr).trim().split('\n').pop() || '{}'); } catch { report = {}; }
      record.runner = { code: ran.code, applied: report.applied ?? null, skipped: Array.isArray(report.skipped) ? report.skipped.length : null, message: ran.code === 0 ? null : hide(String(report.message ?? '')).slice(0, 200) };
    } finally {
      removeDirectory(workspace);
    }
    const after = record.after = await ask('probe');
    const failures = [];
    if (record.runner.code !== 0) failures.push(`the runner stopped: ${record.runner.message || 'no message'}`);
    if (JSON.stringify(record.runner.applied) !== JSON.stringify([FILE])) failures.push(`the runner applied ${JSON.stringify(record.runner.applied)}, not exactly ${FILE}`);
    if (after.latest !== VERSION || after.recorded !== checksum) failures.push(`the ledger does not end at ${VERSION} with this file`);
    if (after.migrations !== before.migrations + 1) failures.push(`the ledger holds ${after.migrations} record(s), not ${before.migrations + 1}`);
    if (after.roomTables !== 4) failures.push(`${after.roomTables} of 4 tables exist`);
    if (after.unprotected !== 0) failures.push(`${after.unprotected} table(s) without row level security`);
    if (after.policies !== 0) failures.push(`${after.policies} policy(ies) on the tables: none is expected`);
    if (after.roomRows !== 0) failures.push(`${after.roomRows} row(s) in tables that were just made`);
    if (after.others !== before.others) failures.push('another table gained or lost rows, or a table appeared or went');
    if (!failures.length) line('PASS', 'after', `ledger at ${VERSION}; 4 tables, protected, no policy, empty; ${after.otherTables} other table(s) as they were`);
    return finish(failures);
  }

  // The way back.
  if (before.latest === BEFORE && before.roomTables === 0) {
    line('PASS', 'db.ledger', `already at ${BEFORE} without the tables; nothing to do`);
    say('Nothing was written.');
    return 0;
  }
  if (before.latest !== VERSION || before.roomTables !== 4) return stop('db.ledger', `the ledger ends at ${before.latest ?? 'nothing'} with ${before.roomTables} of the tables; the way back is from ${VERSION} with all four`);
  if (before.roomRows > 0 && !args['discard-rows']) return stop('db.rows', `${before.roomRows} row(s) in the room channel's tables; add --discard-rows to remove them with the tables`);
  line('PASS', 'db.ledger', `the ledger ends at ${VERSION}; ${before.roomRows} row(s) in the four tables`);
  if (!args.execute) {
    line('INFO', 'plan', `would run ${DOWN_FILE} and remove the ledger's record of ${VERSION}, in one transaction, then ask again`);
    say('Dry run: nothing was written. Add --execute and --authorization to go back.');
    return 0;
  }
  const after = record.after = await ask('down', { DOWN_SQL_FILE: path.join(REPO_ROOT, 'db', 'room-channel', DOWN_FILE) });
  const failures = [];
  if (after.latest !== BEFORE) failures.push(`the ledger ends at ${after.latest ?? 'nothing'}, not ${BEFORE}`);
  if (after.migrations !== before.migrations - 1) failures.push(`the ledger holds ${after.migrations} record(s), not ${before.migrations - 1}`);
  if (after.roomTables !== 0) failures.push(`${after.roomTables} of the tables are still there`);
  if (after.others !== before.others) failures.push('another table gained or lost rows, or a table appeared or went');
  if (!failures.length) line('PASS', 'after', `ledger at ${BEFORE}; the four tables are gone; ${after.otherTables} other table(s) as they were`);
  return finish(failures);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(`STOP  ${error.message}`); console.error(USAGE); process.exitCode = 2; });
}
