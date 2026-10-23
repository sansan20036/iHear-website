import { ACADEMY_CONTENT_KEY, ACADEMY_CONTENT_MAX_CHARACTERS, readStoredAcademyContent } from '../lib/academy-content-types.ts';

// Compatible with pre-Academy backups. Once migration 026 is recorded, the
// published Academy content is required; a checksum alone cannot establish validity.
export function validateAcademyContentBackup(tables) {
  const rows = (tables.site_settings || []).filter(row => row.key === ACADEMY_CONTENT_KEY);
  const required = (tables.schema_migrations || []).some(row => String(row.version) === '026');
  if (rows.length > 1 || (required && rows.length !== 1)) throw new Error('Backup is missing a unique Academy content snapshot.');
  if (!rows.length) return;
  const row = rows[0];
  if (typeof row.value !== 'string' || Array.from(row.value).length > ACADEMY_CONTENT_MAX_CHARACTERS
    || !Number.isSafeInteger(row.record_version) || row.record_version < 1) {
    throw new Error('Invalid Academy content backup record.');
  }
  readStoredAcademyContent(JSON.parse(row.value));
}
