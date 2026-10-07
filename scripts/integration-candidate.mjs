import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateIdentity, deliveryFiles } from './home-focus-candidate.mjs';
import { migrationChecksum } from './migration-checksum.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const semantic = ({ occurrences: _locations, ...slot }) => slot;
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
export const integrationIdentity = files => candidateIdentity(files).replace(/^cp6-/, 'cp7-integration-');

export function compareIntegrationManifest(manifest, current) {
  assert.equal(manifest.schemaVersion, 2, 'Unknown integration manifest format');
  assert.equal(manifest.candidateId, integrationIdentity(manifest.files), 'Candidate identity mismatch');
  assert.equal(manifest.deliveryDigest, hash(JSON.stringify({ files: manifest.files, deleted: manifest.deleted })), 'Delivery digest mismatch');
  assert.deepEqual(current.files, manifest.files, 'Integration candidate bytes, paths or additions changed');
  assert.deepEqual(current.deleted, manifest.deleted, 'Integration candidate deletions changed');
}

export async function verifyIntegrationInputs(root, provenance) {
  const values = {};
  for (const name of ['originalManifest', 'originalSlots', 'remoteSlots']) {
    const bytes = await readFile(provenance[name].path);
    assert.equal(hash(bytes), provenance[name].sha256, `Changed input baseline: ${name}`);
    values[name] = JSON.parse(bytes);
  }
  assert.equal(values.originalManifest.candidateId, provenance.originalCandidateId);
  const migrations = Object.entries(values.originalManifest.files).filter(([name]) => /^db\/migrations\/\d+_.*\.sql$/.test(name));
  assert.equal(migrations.length, 24, 'Expected the original 24 migrations');
  for (const [name, expected] of migrations) {
    const bytes = await readFile(path.join(root, name));
    assert.equal(hash(bytes), expected.sha256, `Historical migration bytes changed: ${name}`);
    assert.equal(migrationChecksum(bytes.toString('utf8')), provenance.migrationChecksums[name], `Historical migration checksum changed: ${name}`);
  }
  const slots = (await read(path.join(root, 'data/content-slots.json'))).slots;
  const byKey = new Map(slots.map(slot => [`${slot.page}\0${slot.key}`, slot]));
  assert.equal(byKey.size, slots.length, 'Duplicate merged content keys');
  for (const source of ['originalSlots', 'remoteSlots']) {
    for (const slot of values[source].slots) {
      const current = byKey.get(`${slot.page}\0${slot.key}`);
      assert.ok(current, `Missing ${source} content: ${slot.page} ${slot.key}`);
      assert.deepEqual(semantic(current), semantic(slot), `Changed ${source} semantic value: ${slot.page} ${slot.key}`);
    }
  }
  return { migrations: migrations.length, originalContentValues: values.originalSlots.slots.length, remoteContentValues: values.remoteSlots.slots.length, mergedContentValues: slots.length };
}

async function main() {
  const [mode, manifestFile = 'output/cp7-integration/candidate.json', extra, ...rest] = process.argv.slice(2);
  assert.ok(['create', 'verify', 'verify-commit'].includes(mode) && !rest.length && (mode === 'verify' ? !extra : !!extra),
    'Usage: integration-candidate.mjs create <manifest> <provenance.json> | verify [manifest] | verify-commit <manifest> <commit>');
  if (mode === 'verify-commit') {
    const manifest = await read(manifestFile);
    compareIntegrationManifest(manifest, { files: manifest.files, deleted: manifest.deleted });
    const commit = git(['rev-parse', '--verify', `${extra}^{commit}`]).trim();
    const objects = {};
    for (const entry of git(['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'), name = entry.slice(tab + 1), [mode, type, oid] = entry.slice(0, tab).split(' ');
      assert.equal(type, 'blob', `Unsupported tree entry: ${name}`);
      assert.ok(['100644', '100755'].includes(mode), `Unsupported file mode: ${name}`);
      objects[name] = oid;
    }
    assert.deepEqual(objects, manifest.gitObjects, 'Commit differs from the exact integration delivery paths and Git-filtered content');
    console.log(JSON.stringify({ verified: true, candidateId: manifest.candidateId, commit })); return;
  }
  const paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const current = await deliveryFiles(process.cwd(), paths);
  const names = Object.keys(current.files);
  const objectIds = git(['hash-object', '--', ...names]).trim().split('\n').map(value => value.trim());
  assert.equal(objectIds.length, names.length);
  const gitObjects = Object.fromEntries(names.map((name, index) => [name, objectIds[index]]));
  if (mode === 'verify') {
    const manifest = await read(manifestFile);
    compareIntegrationManifest(manifest, current);
    assert.deepEqual(gitObjects, manifest.gitObjects, 'Git clean-filtered content changed');
    console.log(JSON.stringify({ verified: true, candidateId: manifest.candidateId, deliveryDigest: manifest.deliveryDigest, files: names.length })); return;
  }
  const provenance = await read(extra);
  for (const key of ['base', 'checkpoint', 'remote']) assert.match(provenance[key], /^[a-f0-9]{40}$/, `Invalid ${key} commit`);
  const preservation = await verifyIntegrationInputs(process.cwd(), provenance);
  const integrationCommit = git(['rev-parse', 'HEAD']).trim();
  git(['merge-base', '--is-ancestor', provenance.checkpoint, integrationCommit]);
  git(['merge-base', '--is-ancestor', provenance.remote, integrationCommit]);
  const manifest = {
    schemaVersion: 2, candidateId: integrationIdentity(current.files), deliveryDigest: hash(JSON.stringify(current)),
    identityScope: 'All delivery source/config/assets/tests/scripts; documentation is additionally covered by the delivery digest and Git blob mapping.',
    ...current, gitObjects, originalCandidateId: provenance.originalCandidateId,
    base: provenance.base, checkpoint: provenance.checkpoint, remote: provenance.remote, integrationCommit,
    preservation, inputHashes: Object.fromEntries(['originalManifest', 'originalSlots', 'remoteSlots'].map(name => [name, provenance[name].sha256])),
    excluded: ['secrets', 'dependencies', 'generated assets/build', 'output/evidence', 'backups', 'build metadata'],
    gitModeLimitation: 'Regular-file content and paths checked; executable-bit differences are not compared.',
  };
  await mkdir(path.dirname(path.resolve(manifestFile)), { recursive: true });
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ candidateId: manifest.candidateId, integrationCommit, remote: provenance.remote, files: names.length, preservation, deliveryDigest: manifest.deliveryDigest }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
