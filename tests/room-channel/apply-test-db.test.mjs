// The step that puts the room channel's tables on the TEST database (tools/room-channel-db), with
// everything outside it played: no database, no git, no file is touched here. What it refuses,
// what it writes only when told to with the user's words, and that the address never shows.
//   node --test tests/room-channel/apply-test-db.test.mjs
// Its run against a real (disposable, local) PostgreSQL is apply-test-db.postgres.test.mjs.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrationChecksum } from '../../scripts/migration-checksum.mjs';
import { main } from '../../tools/room-channel-db/apply-test-db.mjs';
import { sessionUrl, testDatabaseRef } from '../../tools/room-channel-db/shared.mjs';

const REF = 'abcdefghij0123456789';
const PASSWORD = 's3cretPassw0rd-never-shown';
const HOST = 'aws-0-ap-northeast-1.pooler.supabase.com';
const ADDRESS = `postgres://postgres.${REF}:${PASSWORD}@${HOST}:6543/postgres`;
const DRAFT = 'CREATE TABLE public.classroom_room_channel ();';
const SUM = migrationChecksum(DRAFT);
const EVIDENCE = path.join(os.tmpdir(), 'ihear-apply-test-db-evidence.json');
const WORDS = '核准在測試資料庫建表';
const AT_030 = { marked: true, latest: '030', migrations: 30, recorded: null, roomTables: 0, unprotected: 0, policies: 0, roomRows: 0, otherTables: 20, others: 'classroom_lessons:2,site_content:5' };
const AT_031 = { ...AT_030, latest: '031', migrations: 31, recorded: SUM, roomTables: 4 };
const BASE = ['--db-env', 'C:/outside/test-db.env', '--expect-ref', REF, '--evidence', EVIDENCE];

function world(over = {}) {
  const state = { facts: { ...AT_030 }, calls: [], logs: [], written: [], gitStatus: '', envFiles: [], address: ADDRESS, migrations: Array.from({ length: 30 }, (_, index) => `${String(index + 1).padStart(3, '0')}_made_up.sql`), ...over };
  const deps = {
    log: text => state.logs.push(text),
    exists: file => state.envFiles.includes(path.basename(file)),
    readSettings: () => ({ POSTGRES_URL: state.address }),
    readText: () => DRAFT,
    listMigrations: () => state.migrations,
    writeFile: (file, text) => state.written.push({ file, text }),
    makeWorkspace: () => 'W:/workspace-of-this-run',
    removeDirectory: directory => state.calls.push({ removed: directory }),
    now: () => 1_800_000_000_000,
    exec: async (cmd, args, options = {}) => {
      state.calls.push({ cmd, args, env: options.env, cwd: options.cwd });
      if (cmd === 'git') return args.includes('status') ? { code: 0, stdout: state.gitStatus, stderr: '' } : { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      if (String(args[0]).endsWith('db-step.mjs')) {
        if (args[1] === 'down') state.onDown?.(state);
        return state.stepFails ? { code: 1, stdout: '', stderr: `database error: 28P01 password authentication failed for ${state.address}` } : { code: 0, stdout: `${JSON.stringify(state.facts)}\n`, stderr: '' };
      }
      if (String(args[0]).endsWith('migrate-database.mjs')) {
        state.onRun?.(state);
        return state.runner ?? { code: 0, stdout: `${JSON.stringify({ connected: true, applied: ['031_classroom_room_channel.sql'], skipped: state.migrations })}\n`, stderr: '' };
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  };
  return { state, deps };
}
const dbCalls = state => state.calls.filter(call => call.args && /db-step|migrate-database/.test(String(call.args[0])));
const runnerCalls = state => state.calls.filter(call => call.args && String(call.args[0]).endsWith('migrate-database.mjs'));
const said = state => state.logs.join('\n');
const applied = state => { state.facts = { ...AT_031 }; };

test('TD-1: what it is given: every option is needed, a write needs the user\'s words, and the evidence stays out of the repository and OneDrive', async () => {
  const { deps } = world();
  await assert.rejects(main(['--expect-ref', REF, '--evidence', EVIDENCE], deps), /--db-env/);
  await assert.rejects(main(['--db-env', 'x', '--evidence', EVIDENCE], deps), /--expect-ref/);
  await assert.rejects(main(['--db-env', 'x', '--expect-ref', REF], deps), /--evidence/);
  await assert.rejects(main(['--db-env', 'x', '--expect-ref', 'NotARef', '--evidence', EVIDENCE], deps), /project reference/);
  await assert.rejects(main(['--db-env', 'x', '--expect-ref', REF, '--evidence', 'output/evidence.json'], deps), /outside the repository/);
  await assert.rejects(main(['--db-env', 'x', '--expect-ref', REF, '--evidence', 'C:/Users/someone/OneDrive - x/evidence.json'], deps), /OneDrive/);
  await assert.rejects(main([...BASE, '--execute'], deps), /--authorization/);
  await assert.rejects(main([...BASE, '--execute', '--authorization', 'ok'], deps), /--authorization/);
  await assert.rejects(main([...BASE, '--discard-rows'], deps), /--down/);
  await assert.rejects(main([...BASE, '--force'], deps), /Unknown option/);
});

test('TD-2: the address: only a Supabase project, and only the one named on the command line; nothing is asked of any database otherwise', async () => {
  for (const [address, words] of [
    ['not a url', /not a URL/], ['https://example.test/x', /not a postgres/], ['postgres://postgres:pw@127.0.0.1:5432/postgres', /not a Supabase address/],
    [`postgres://postgres:${PASSWORD}@${HOST}:6543/postgres`, /names no Supabase project/], [`postgres://postgres.${REF}@${HOST}:6543/postgres`, /no password/],
    [`postgres://postgres.zzzzzzzzzz0123456789:${PASSWORD}@${HOST}:6543/postgres`, /another project/],
  ]) {
    const { state, deps } = world({ address });
    assert.equal(await main([...BASE, '--execute', '--authorization', WORDS], deps), 1, address.slice(0, 20));
    assert.match(said(state), words);
    assert.match(said(state), /Nothing was written/);
    assert.deepEqual(state.calls, [], 'nothing was run');
    assert.deepEqual(state.written, []);
  }
  assert.deepEqual(testDatabaseRef(`postgres://postgres:${PASSWORD}@db.${REF}.supabase.co:5432/postgres`), { ref: REF });
  assert.equal(new URL(sessionUrl(ADDRESS)).port, '5432');
  assert.equal(new URL(sessionUrl(`postgres://postgres:${PASSWORD}@db.${REF}.supabase.co:5432/postgres`)).port, '5432');
});

test('TD-3: this checkout: an .env file, files that differ from the commit, or migrations that do not end at 030 stop it before the database', async () => {
  for (const [over, words] of [
    [{ envFiles: ['.env.local'] }, /\.env\.local in this checkout/], [{ gitStatus: ' M db/room-channel/031_classroom_room_channel.sql\n' }, /differ from what is committed/],
    [{ migrations: ['001_a.sql', '029_b.sql'] }, /ends at 029/], [{ migrations: ['001_a.sql', '030_b.sql', '031_c.sql'] }, /ends at 031/], [{ migrations: [] }, /ends at nothing/],
  ]) {
    const { state, deps } = world(over);
    assert.equal(await main([...BASE, '--execute', '--authorization', WORDS], deps), 1);
    assert.match(said(state), words);
    assert.deepEqual(dbCalls(state), [], 'the database was not reached');
    assert.deepEqual(state.written, []);
  }
});

test('TD-4: the database: without the test marker, or with a ledger that does not end exactly at 030, nothing is applied', async () => {
  for (const [facts, words] of [
    [{ ...AT_030, marked: false }, /no test marker/], [{ ...AT_030, marked: false, latest: null, migrations: 0, otherTables: 0, others: '' }, /no test marker/],
    [{ ...AT_030, latest: '029', migrations: 29 }, /ends at 029/], [{ ...AT_030, latest: '032', migrations: 32 }, /ends at 032/], [{ ...AT_030, latest: null, migrations: 0 }, /ends at nothing/],
    [{ ...AT_030, roomTables: 2 }, /2 of the room channel's tables exist/], [{ ...AT_031, recorded: 'f'.repeat(64) }, /not this draft's/], [{ ...AT_031, roomTables: 3 }, /not this draft's/],
  ]) {
    const { state, deps } = world({ facts });
    assert.equal(await main([...BASE, '--execute', '--authorization', WORDS], deps), 1);
    assert.match(said(state), words);
    assert.deepEqual(runnerCalls(state), [], 'the runner was not started');
    assert.deepEqual(state.written, []);
  }
});

test('TD-5: a dry run reads and writes nothing; "already applied" writes nothing either', async () => {
  const dry = world();
  assert.equal(await main(BASE, dry.deps), 0);
  assert.match(said(dry.state), /Dry run: nothing was written/);
  assert.deepEqual(runnerCalls(dry.state), []);
  assert.deepEqual(dry.state.written, []);
  assert.deepEqual(dbCalls(dry.state).map(call => call.args[1]), ['probe']);
  const again = world({ facts: { ...AT_031 } });
  assert.equal(await main([...BASE, '--execute', '--authorization', WORDS], again.deps), 0);
  assert.match(said(again.state), /already applied/);
  assert.deepEqual(runnerCalls(again.state), []);
  assert.deepEqual(again.state.written, []);
});

test('TD-6: with the user\'s words: the site\'s own runner once, in a folder of its own, with the test database\'s address and nothing else; then asked again; the evidence keeps the words', async () => {
  const { state, deps } = world({ onRun: applied });
  assert.equal(await main([...BASE, '--execute', '--authorization', WORDS], deps), 0);
  const [run] = runnerCalls(state);
  assert.equal(runnerCalls(state).length, 1);
  assert.equal(run.cwd, 'W:/workspace-of-this-run');
  assert.deepEqual(Object.keys(run.env).sort(), ['DATABASE_URL', 'PATH', 'POSTGRES_URL', 'SystemRoot', 'TEMP', 'TMP']);
  assert.equal(run.env.DATABASE_URL, '');
  assert.equal(new URL(run.env.POSTGRES_URL).port, '5432', 'through the session pooler');
  const probes = dbCalls(state).filter(call => call.args[1] === 'probe');
  assert.equal(probes.length, 2, 'asked before and after');
  for (const probe of probes) assert.deepEqual(Object.keys(probe.env).sort(), ['PATH', 'SystemRoot', 'TEMP', 'TEST_DB_URL', 'TMP']);
  assert.deepEqual(state.calls.filter(call => call.removed), [{ removed: 'W:/workspace-of-this-run' }]);
  assert.equal(state.written.length, 1);
  const record = JSON.parse(state.written[0].text);
  assert.deepEqual([record.action, record.result, record.authorization, record.expectRef, record.checksum, record.runner.applied], ['apply', 'PASS', WORDS, REF, SUM, ['031_classroom_room_channel.sql']]);
  assert.deepEqual([record.before.latest, record.after.latest, record.after.roomTables], ['030', '031', 4]);
  assert.match(said(state), /4 tables, protected, no policy, empty/);
});

test('TD-7: after the runner, anything that is not as it must be is a failure, said and kept in the evidence', async () => {
  for (const [over, words] of [
    [{ onRun: applied, runner: { code: 0, stdout: `${JSON.stringify({ applied: ['030_other.sql', '031_classroom_room_channel.sql'], skipped: [] })}\n`, stderr: '' } }, /not exactly 031_classroom_room_channel\.sql/],
    [{ runner: { code: 1, stdout: '', stderr: `${JSON.stringify({ connected: false, message: 'permission denied' })}\n` } }, /the runner stopped: permission denied/],
    [{ onRun: state => { state.facts = { ...AT_031, unprotected: 1 }; } }, /1 table\(s\) without row level security/],
    [{ onRun: state => { state.facts = { ...AT_031, policies: 2 }; } }, /2 policy/],
    [{ onRun: state => { state.facts = { ...AT_031, roomRows: 3 }; } }, /3 row\(s\) in tables that were just made/],
    [{ onRun: state => { state.facts = { ...AT_031, others: 'classroom_lessons:1,site_content:5' }; } }, /another table gained or lost rows/],
    [{ onRun: state => { state.facts = { ...AT_031, recorded: 'e'.repeat(64) }; } }, /does not end at 031 with this file/],
    [{ onRun: state => { state.facts = { ...AT_031, roomTables: 3 }; } }, /3 of 4 tables exist/],
    [{ onRun: state => { state.facts = { ...AT_031, migrations: 33 }; } }, /holds 33 record/],
  ]) {
    const { state, deps } = world(over);
    assert.equal(await main([...BASE, '--execute', '--authorization', WORDS], deps), 1);
    assert.match(said(state), words);
    const record = JSON.parse(state.written[0].text);
    assert.equal(record.result, 'FAIL');
    assert.ok(record.failures.length >= 1);
  }
});

test('TD-8: the address, its user and its password are never printed or saved, also when the database answers with them', async () => {
  const shown = text => [PASSWORD, `postgres.${REF}`, HOST, ADDRESS].filter(secret => text.includes(secret));
  const fine = world({ onRun: applied });
  await main([...BASE, '--execute', '--authorization', WORDS], fine.deps);
  assert.deepEqual(shown(said(fine.state) + fine.state.written.map(entry => entry.text).join('')), []);
  const failing = world({ stepFails: true });
  await assert.rejects(main(BASE, failing.deps), error => { assert.deepEqual(shown(error.message), []); assert.match(error.message, /could not be read/); return true; });
  assert.deepEqual(shown(said(failing.state)), []);
});

test('TD-9: the way back: from 031 with all four tables only; rows are not removed unless said; one transaction through the step, then asked again', async () => {
  const already = world();
  assert.equal(await main([...BASE, '--down', '--execute', '--authorization', WORDS], already.deps), 0);
  assert.match(said(already.state), /already at 030/);
  assert.deepEqual(already.state.written, []);
  for (const [facts, words] of [[{ ...AT_030, latest: '029', migrations: 29 }, /way back is from 031/], [{ ...AT_031, roomTables: 3 }, /way back is from 031/], [{ ...AT_031, marked: false }, /no test marker/]]) {
    const { state, deps } = world({ facts });
    assert.equal(await main([...BASE, '--down', '--execute', '--authorization', WORDS], deps), 1);
    assert.match(said(state), words);
    assert.deepEqual(dbCalls(state).map(call => call.args[1]), ['probe']);
  }
  const rows = world({ facts: { ...AT_031, roomRows: 7 } });
  assert.equal(await main([...BASE, '--down', '--execute', '--authorization', WORDS], rows.deps), 1);
  assert.match(said(rows.state), /7 row\(s\).*--discard-rows/);
  const dry = world({ facts: { ...AT_031 } });
  assert.equal(await main([...BASE, '--down'], dry.deps), 0);
  assert.deepEqual(dbCalls(dry.state).map(call => call.args[1]), ['probe']);
  const back = world({ facts: { ...AT_031, roomRows: 7 }, onDown: state => { state.facts = { ...AT_030 }; } });
  assert.equal(await main([...BASE, '--down', '--discard-rows', '--execute', '--authorization', WORDS], back.deps), 0);
  const down = dbCalls(back.state).find(call => call.args[1] === 'down');
  assert.deepEqual(Object.keys(down.env).sort(), ['DOWN_SQL_FILE', 'PATH', 'SystemRoot', 'TEMP', 'TEST_DB_URL', 'TMP']);
  assert.match(down.env.DOWN_SQL_FILE.replace(/\\/g, '/'), /db\/room-channel\/031_classroom_room_channel\.down\.sql$/);
  assert.deepEqual(runnerCalls(back.state), [], 'the way back never starts the runner');
  const record = JSON.parse(back.state.written[0].text);
  assert.deepEqual([record.action, record.result, record.before.latest, record.after.latest, record.after.roomTables], ['down', 'PASS', '031', '030', 0]);
  const stuck = world({ facts: { ...AT_031 }, onDown: state => { state.facts = { ...AT_031, latest: '030', migrations: 30 }; } });
  assert.equal(await main([...BASE, '--down', '--execute', '--authorization', WORDS], stuck.deps), 1);
  assert.match(said(stuck.state), /4 of the tables are still there/);
});
