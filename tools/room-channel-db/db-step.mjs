// The test database, asked (probe) or taken back to 030 (down): run only by apply-test-db.mjs, with
// the URL in TEST_DB_URL and nothing else that could name a database. It prints one line of facts
// and counts; never the URL, a user or a password.
//   probe: read only. Whether the test marker is there, the migration ledger, the room channel's
//          four tables (present, protected, rows), and the rows of every other table.
//   down:  in one transaction: the down file (given in DOWN_SQL_FILE) and the ledger's record of
//          031 removed. Then the same facts.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { MARKER_TABLE, ROOM_TABLES, VERSION } from './shared.mjs';

const mode = process.argv[2];
if (!['probe', 'down'].includes(mode)) { console.error('mode is probe or down'); process.exit(2); }
const url = process.env.TEST_DB_URL;
if (!url) { console.error('TEST_DB_URL is not set'); process.exit(2); }

const sql = postgres(url, { max: 1, prepare: false, ssl: process.env.TEST_DB_SSL === 'disable' ? false : 'require', connect_timeout: 10, onnotice: () => {} });
// Names from this file's own constants and from the catalogue, quoted; never from outside.
const quoted = name => `"${String(name).replace(/"/g, '""')}"`;
const listed = ROOM_TABLES.map(name => `'${name}'`).join(', ');

async function facts() {
  const [base] = await sql.unsafe(`SELECT to_regclass('public.${MARKER_TABLE}') IS NOT NULL AS has_marker, to_regclass('public.schema_migrations') IS NOT NULL AS tracked`);
  const marked = base.has_marker ? (await sql.unsafe(`SELECT count(*)::int AS n FROM public.${MARKER_TABLE}`))[0].n > 0 : false;
  const ledger = base.tracked ? await sql.unsafe('SELECT version, name, btrim(checksum) AS checksum FROM public.schema_migrations ORDER BY version') : [];
  const tables = (await sql.unsafe("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")).map(row => row.table_name);
  const room = tables.filter(name => ROOM_TABLES.includes(name));
  const open = (await sql.unsafe(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname IN (${listed}) AND NOT relrowsecurity`)).map(row => row.relname);
  const policies = (await sql.unsafe(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${listed})`))[0].n;
  const count = async name => (await sql.unsafe(`SELECT count(*)::int AS n FROM public.${quoted(name)}`))[0].n;
  let roomRows = 0;
  for (const name of room) roomRows += await count(name);
  // Every other table, by name and number of rows: what must be the same before and after. The
  // ledger itself is left out (it gains or loses the one record of 031).
  const others = [];
  for (const name of tables) if (!ROOM_TABLES.includes(name) && name !== 'schema_migrations') others.push(`${name}:${await count(name)}`);
  return {
    marked, latest: ledger.at(-1)?.version ?? null, migrations: ledger.length, recorded: ledger.find(row => row.version === VERSION)?.checksum ?? null,
    roomTables: room.length, unprotected: open.length, policies, roomRows, otherTables: others.length, others: others.join(','),
  };
}

try {
  if (mode === 'down') {
    const down = readFileSync(String(process.env.DOWN_SQL_FILE ?? ''), 'utf8');
    await sql.begin(async tx => {
      await tx.unsafe(down);
      await tx`DELETE FROM public.schema_migrations WHERE version = ${VERSION}`;
    });
  }
  console.log(JSON.stringify(await facts()));
} catch (error) {
  // The driver's message can quote the host; the caller masks it again before it is shown.
  console.error(`database error: ${String(error?.code ?? '')} ${String(error?.message ?? error).slice(0, 160)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
