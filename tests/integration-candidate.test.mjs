import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareIntegrationManifest, integrationIdentity, verifyIntegrationInputs } from '../scripts/integration-candidate.mjs';
import { deliveryFiles } from '../scripts/home-focus-candidate.mjs';
import { migrationChecksum } from '../scripts/migration-checksum.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const descriptor = text => ({ sha256: sha256(text), bytes: Buffer.byteLength(text) });
const slot = (key, en, page = 'academy') => ({
  page, key, mode: 'text', maxLength: 120,
  values: { en, 'zh-TW': '繁體中文', 'zh-CN': '' },
  occurrences: [{ file: `${page}.html`, line: 4 }],
});
const freeze = current => ({
  schemaVersion: 2, ...clone(current), candidateId: integrationIdentity(current.files),
  deliveryDigest: sha256(JSON.stringify(current)),
});
async function removeFixture(root, parent, prefix) {
  const resolved = await realpath(root);
  if (resolved !== path.resolve(root) || path.dirname(resolved) !== parent
    || !path.basename(resolved).startsWith(prefix)) {
    throw new Error(`Refusing cleanup outside the created fixture: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}

describe('integration preservation against both recorded input baselines', () => {
  let fixture;
  let fixtureParent;
  let provenance;
  let merged;
  let originalManifest;
  let firstMigration;

  const saveMerged = () => writeFile(path.join(fixture, 'data/content-slots.json'), JSON.stringify(merged));
  const saveBaseline = async (name, value) => {
    const bytes = JSON.stringify(value);
    await writeFile(provenance[name].path, bytes);
    provenance[name].sha256 = sha256(bytes);
  };

  beforeEach(async () => {
    fixtureParent = await realpath(tmpdir());
    fixture = await mkdtemp(path.join(fixtureParent, 'ihear-integration-inputs-'));
    await Promise.all(['db/migrations', 'data', 'baselines'].map(name => mkdir(path.join(fixture, name), { recursive: true })));
    provenance = { originalCandidateId: 'cp6-recorded-input', migrationChecksums: {} };
    originalManifest = { candidateId: provenance.originalCandidateId, files: {} };
    // The preservation tool checks bytes, not SQL execution. All 24 fixtures
    // have distinct SQL and mixed line endings to exercise its full contract.
    for (let number = 1; number <= 24; number += 1) {
      const name = `db/migrations/${String(number).padStart(3, '0')}_fixture.sql`;
      const sql = `-- fixture ${number}\r\nSELECT ${number};\r\n`;
      await writeFile(path.join(fixture, name), sql);
      originalManifest.files[name] = descriptor(sql);
      provenance.migrationChecksums[name] = sha256(sql.replace(/\r\n/g, '\n'));
      firstMigration ||= name;
    }
    const common = slot('shared', 'Unchanged & <safe>');
    const original = { slots: [common, slot('legacy_cta', 'Old course label')] };
    const remote = { slots: [clone(common), slot('course_cta', 'Explore courses')] };
    merged = { slots: [clone(common), clone(original.slots[1]), clone(remote.slots[1]), slot('new_key', 'New integration label')] };
    for (const [name, value] of Object.entries({ originalManifest, originalSlots: original, remoteSlots: remote })) {
      provenance[name] = { path: path.join(fixture, 'baselines', `${name}.json`) };
      await saveBaseline(name, value);
    }
    await saveMerged();
  });

  afterEach(async () => {
    if (!fixture) return;
    await removeFixture(fixture, fixtureParent, 'ihear-integration-inputs-');
    fixture = undefined;
    firstMigration = undefined;
  });

  it('preserves all 24 migrations and both semantic catalogs while allowing additions and relocated occurrences', async () => {
    merged.slots[0].occurrences = [{ file: 'academy.html', line: 900 }, { file: 'academy.html', line: 1000 }];
    merged.slots.push(slot('shared', 'A separate page may use the same key', 'home'));
    await saveMerged();
    await expect(verifyIntegrationInputs(fixture, provenance)).resolves.toEqual({
      migrations: 24, originalContentValues: 2, remoteContentValues: 2, mergedContentValues: 5,
    });
  });

  it.each(['originalManifest', 'originalSlots', 'remoteSlots'])('rejects bytes changed in trusted %s before comparing their contents', async name => {
    await writeFile(provenance[name].path, `${await readFile(provenance[name].path, 'utf8')}\n`);
    await expect(verifyIntegrationInputs(fixture, provenance)).rejects.toThrow(`Changed input baseline: ${name}`);
  });

  it('rejects a different original candidate even when its baseline file has a matching hash', async () => {
    originalManifest.candidateId = 'cp6-other-candidate';
    await saveBaseline('originalManifest', originalManifest);
    await expect(verifyIntegrationInputs(fixture, provenance)).rejects.toThrow();
  });

  it('rejects migration byte drift even when normalized SQL checksum stays identical', async () => {
    const original = await readFile(path.join(fixture, firstMigration), 'utf8');
    const changed = original.replace(/\r\n/g, '\n');
    expect(migrationChecksum(changed)).toBe(provenance.migrationChecksums[firstMigration]);
    expect(sha256(changed)).not.toBe(originalManifest.files[firstMigration].sha256);
    await writeFile(path.join(fixture, firstMigration), changed);
    await expect(verifyIntegrationInputs(fixture, provenance)).rejects.toThrow(`Historical migration bytes changed: ${firstMigration}`);
  });

  it('rejects a mismatched SQL checksum independently of matching original bytes', async () => {
    provenance.migrationChecksums[firstMigration] = sha256('different SQL');
    await expect(verifyIntegrationInputs(fixture, provenance)).rejects.toThrow(`Historical migration checksum changed: ${firstMigration}`);
  });

  it.each([23, 25])('rejects an input baseline recording %i rather than 24 migrations', async count => {
    if (count === 23) delete originalManifest.files[firstMigration];
    else originalManifest.files['db/migrations/025_unexpected.sql'] = descriptor('SELECT 25;');
    await saveBaseline('originalManifest', originalManifest);
    await expect(verifyIntegrationInputs(fixture, provenance)).rejects.toThrow('Expected the original 24 migrations');
  });

  it.each([
    ['legacy_cta', 'originalSlots'], ['course_cta', 'remoteSlots'],
  ])('rejects loss of %s from its own source baseline', async (key, source) => {
    merged.slots = merged.slots.filter(value => value.key !== key);
    await saveMerged();
    await expect(verifyIntegrationInputs(fixture, provenance)).rejects.toThrow(`Missing ${source} content: academy ${key}`);
  });

  it.each([
    ['legacy_cta', 'originalSlots'], ['course_cta', 'remoteSlots'],
  ])('rejects semantic replacement of %s even if another baseline is preserved', async (key, source) => {
    merged.slots.find(value => value.key === key).values.en = 'Changed label';
    await saveMerged();
    await expect(verifyIntegrationInputs(fixture, provenance)).rejects.toThrow(`Changed ${source} semantic value: academy ${key}`);
  });

  it.each(['blankTranslation', 'maxLength', 'mode'])('does not exempt %s from semantic preservation', async field => {
    if (field === 'blankTranslation') merged.slots[0].values['zh-CN'] = merged.slots[0].values.en;
    else merged.slots[0][field] = field === 'mode' ? 'html' : 121;
    await saveMerged();
    await expect(verifyIntegrationInputs(fixture, provenance)).rejects.toThrow('Changed originalSlots semantic value: academy shared');
  });

  it.each([false, true])('rejects duplicate page/key pairs regardless of equal values (changed=%s)', async changed => {
    const duplicate = clone(merged.slots[0]);
    if (changed) duplicate.values.en = 'Changed duplicate';
    merged.slots.push(duplicate);
    await saveMerged();
    await expect(verifyIntegrationInputs(fixture, provenance)).rejects.toThrow('Duplicate merged content keys');
  });
});

describe('frozen integration delivery and code identity', () => {
  const current = () => ({
    files: {
      'assets/controller.js': descriptor('console.log("accepted");'),
      'docs/integration.md': descriptor('Recorded acceptance evidence'),
      'package-lock.json': descriptor('{"lockfileVersion":3}'),
    },
    deleted: ['retired.js'],
  });

  it('accepts exact frozen delivery with the distinct integration identity prefix', () => {
    const value = current();
    const manifest = freeze(value);
    expect(manifest.candidateId).toMatch(/^cp7-integration-[a-f0-9]{64}$/);
    expect(() => compareIntegrationManifest(manifest, clone(value))).not.toThrow();
    expect(integrationIdentity(Object.fromEntries(Object.entries(value.files).reverse()))).toBe(manifest.candidateId);
  });

  it.each(['modified', 'added', 'missing'])('rejects %s code in the actual delivery', change => {
    const value = current();
    const manifest = freeze(value);
    if (change === 'modified') value.files['assets/controller.js'] = descriptor('console.log("different");');
    if (change === 'added') value.files['unchecked.js'] = descriptor('untested addition');
    if (change === 'missing') delete value.files['assets/controller.js'];
    expect(() => compareIntegrationManifest(manifest, value)).toThrow('Integration candidate bytes, paths or additions changed');
  });

  it('rejects changes to the recorded deletion set', () => {
    const value = current();
    expect(() => compareIntegrationManifest(freeze(value), { ...value, deleted: [] })).toThrow('Integration candidate deletions changed');
  });

  it.each(['schemaVersion', 'candidateId', 'deliveryDigest'])('rejects manifest %s tampering', field => {
    const value = current();
    const manifest = freeze(value);
    manifest[field] = field === 'schemaVersion' ? 1 : 'tampered';
    expect(() => compareIntegrationManifest(manifest, value)).toThrow();
  });

  it('covers documents with delivery integrity even though documentation does not change code identity', () => {
    const value = current();
    const before = freeze(value);
    value.files['docs/integration.md'] = descriptor('Changed acceptance evidence');
    expect(integrationIdentity(value.files)).toBe(before.candidateId);
    expect(freeze(value).deliveryDigest).not.toBe(before.deliveryDigest);
    expect(() => compareIntegrationManifest(before, value)).toThrow('Integration candidate bytes, paths or additions changed');
    // Altering the manifest itself cannot hide a documentation change.
    const tampered = { ...before, files: value.files };
    expect(() => compareIntegrationManifest(tampered, value)).toThrow('Delivery digest mismatch');
    value.files['package-lock.json'] = descriptor('{"lockfileVersion":3,"changed":true}');
    expect(integrationIdentity(value.files)).not.toBe(before.candidateId);
  });

  it('detects actual filesystem writes, additions and removal when fed deliveryFiles output', async () => {
    const parent = await realpath(tmpdir());
    const root = await mkdtemp(path.join(parent, 'ihear-integration-delivery-'));
    try {
      await writeFile(path.join(root, 'index.html'), '<p>accepted</p>');
      const manifest = freeze(await deliveryFiles(root, ['index.html']));
      await writeFile(path.join(root, 'index.html'), '<p>altered</p>');
      const modified = await deliveryFiles(root, ['index.html']);
      expect(() => compareIntegrationManifest(manifest, modified)).toThrow('Integration candidate bytes, paths or additions changed');
      await writeFile(path.join(root, 'index.html'), '<p>accepted</p>');
      await writeFile(path.join(root, 'new.js'), 'unverified');
      const added = await deliveryFiles(root, ['index.html', 'new.js']);
      expect(() => compareIntegrationManifest(manifest, added)).toThrow('Integration candidate bytes, paths or additions changed');
      await rm(path.join(root, 'index.html'));
      const removed = await deliveryFiles(root, ['index.html']);
      expect(removed.deleted).toEqual(['index.html']);
      expect(() => compareIntegrationManifest(manifest, removed)).toThrow('Integration candidate bytes, paths or additions changed');
    } finally {
      await removeFixture(root, parent, 'ihear-integration-delivery-');
    }
  });
});
