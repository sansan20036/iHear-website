import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { defaultAcademyContent } from '../lib/academy-content-types';
import { validateAcademyContentBackup } from '../scripts/academy-content-backup.mjs';

const snapshot = () => ({
  schema_migrations: [{ version: '025' }, { version: '026' }],
  site_settings: [{ key: 'academy_content_v2', value: JSON.stringify(defaultAcademyContent()), record_version: 7 }],
});
const read = async path => (await readFile(path, 'utf8')).replace(/\r\n?/g, '\n');

describe('Academy content snapshots', () => {
  test('older backups remain readable, but post-026 backups require the published content', () => {
    expect(() => validateAcademyContentBackup({ schema_migrations: [{ version: '024' }] })).not.toThrow();
    expect(() => validateAcademyContentBackup({ schema_migrations: [{ version: '025' }] })).not.toThrow();
    expect(() => validateAcademyContentBackup({ schema_migrations: [{ version: '026' }] })).toThrow();
    expect(() => validateAcademyContentBackup({ schema_migrations: [{ version: '026' }], site_settings: [{ key: 'theme', value: 'warm', record_version: 1 }] })).toThrow();
    expect(() => validateAcademyContentBackup(snapshot())).not.toThrow();
  });

  test('valid Unicode text, prices and version survive a JSON backup round trip', () => {
    const tables = snapshot(), config = defaultAcademyContent();
    config.content.zhHant['hero.lead'] = '中文 😀 "quote" \\ newline\n'.repeat(10).trim();
    config.pricing.rates.TWD['60'].college = 1500;
    tables.site_settings[0].value = JSON.stringify(config);
    const restored = JSON.parse(JSON.stringify(tables));
    validateAcademyContentBackup(restored);
    expect(restored).toEqual(tables);
    expect(JSON.parse(restored.site_settings[0].value).pricing.rates.TWD['60'].college).toBe(1500);
  });

  test('rejects duplicate, malformed, oversized, or semantically invalid content snapshots', () => {
    const duplicate = snapshot(); duplicate.site_settings.push(duplicate.site_settings[0]);
    expect(() => validateAcademyContentBackup(duplicate)).toThrow();
    for (const value of ['{broken', '界'.repeat(60_001), '{}', 42]) {
      const tables = snapshot(); tables.site_settings[0].value = value;
      expect(() => validateAcademyContentBackup(tables)).toThrow();
    }
    for (const version of [0, 1.5, '7']) {
      const tables = snapshot(); tables.site_settings[0].record_version = version;
      expect(() => validateAcademyContentBackup(tables)).toThrow();
    }
    const config = defaultAcademyContent(); config.pricing.rates.USD['45'].highschool = -1;
    const tables = snapshot(); tables.site_settings[0].value = JSON.stringify(config);
    expect(() => validateAcademyContentBackup(tables)).toThrow();
  });

  test('every backup, verification and audit path checks the Academy content', async () => {
    for (const script of ['scripts/backup-database.mjs', 'scripts/verify-backup.mjs', 'scripts/verify-backup-file.mjs', 'scripts/audit-database.mjs']) {
      const source = await read(script);
      expect(source, script).toContain("import { validateAcademyContentBackup } from \"./academy-content-backup.mjs\";");
      expect(source.match(/validateAcademyContentBackup\(/g), script).toHaveLength(1);
    }
    // The audit applies the same per-key length limit as migration 026.
    const audit = await read('scripts/audit-database.mjs');
    expect(audit).toContain("WHEN key = 'academy_content_v2' THEN 60000");
    expect(audit).toContain("WHEN key = 'academy_pricing_v1' THEN 8000");
  });

  test('the validator loads in plain Node, as the operations scripts run it', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const { validateAcademyContentBackup } = await import('./scripts/academy-content-backup.mjs'); validateAcademyContentBackup({ schema_migrations: [{ version: '024' }] }); console.log('loaded');"],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('loaded');
  });

  test('field defaults are generated from the templates and the check runs in the test suite', async () => {
    const result = spawnSync(process.execPath, ['scripts/generate-academy-fields.mjs'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('data/academy-fields.json matches the Academy templates.');
  });
});
