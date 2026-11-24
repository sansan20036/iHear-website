// The room channel's tables on the TEST database (2026-11-24): what the step and its child script
// share. Nothing here names a database: project references come as arguments only (this
// repository is public).

export const VERSION = '031';
export const FILE = '031_classroom_room_channel.sql';
export const DOWN_FILE = '031_classroom_room_channel.down.sql';
export const BEFORE = '030';
export const ROOM_TABLES = Object.freeze(['classroom_room_channel', 'classroom_room_board_lines', 'classroom_room_board_parts', 'classroom_room_board_ops']);
// The marker the release tool's migrate-test-db leaves in a test database before its first
// migration. This step never makes it: a database without it is not a test database for 031.
export const MARKER_TABLE = '_ihear_test_marker';

// The files Next.js loads into a script's environment (loadEnvConfig): the site's own migration
// script loads them from where it runs, and a checkout's .env.local can be the live database.
export const ENV_FILES = Object.freeze(['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local']);

const REF = /^[a-z0-9]{20}$/;
const SUPABASE_HOST = /\.(pooler\.supabase\.com|supabase\.co)$/;
export const isProjectRef = value => REF.test(String(value ?? ''));

// The Supabase project a POSTGRES_URL names, or why it names none. Nothing of the URL is echoed.
// (The same rule as the release tool's tools/classroom-preview/test-db.mjs, repeated here so that
// this folder needs nothing from that tool's tree.)
export function testDatabaseRef(url) {
  let parsed;
  try { parsed = new URL(String(url ?? '')); } catch { return { error: 'POSTGRES_URL is not a URL' }; }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return { error: 'POSTGRES_URL is not a postgres:// address' };
  if (!SUPABASE_HOST.test(parsed.hostname)) return { error: 'POSTGRES_URL is not a Supabase address' };
  const fromHost = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(parsed.hostname)?.[1] ?? null;
  const fromUser = /^postgres\.([a-z0-9]{20})$/.exec(decodeURIComponent(parsed.username))?.[1] ?? null;
  const ref = fromHost ?? fromUser;
  if (!ref) return { error: 'POSTGRES_URL names no Supabase project' };
  if (!parsed.password) return { error: 'POSTGRES_URL has no password' };
  return { ref };
}

// Migrations run through the session pooler (5432), not the transaction pooler (6543) the site
// uses: same host, user and password, only the port differs.
export function sessionUrl(url) {
  const parsed = new URL(url);
  if (/\.pooler\.supabase\.com$/.test(parsed.hostname) && parsed.port === '6543') parsed.port = '5432';
  return parsed.toString();
}

// What a URL could give away: itself, its session form, its user and its password.
export function secretsOf(url) {
  try { const parsed = new URL(url); return [url, sessionUrl(url), decodeURIComponent(parsed.password), decodeURIComponent(parsed.username)]; } catch { return [String(url ?? '')]; }
}
