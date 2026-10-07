import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { migrationChecksum } from './migration-checksum.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const semantic = ({ occurrences: _occurrences, ...value }) => value;
const git = args => execFileSync('git', args, { encoding: 'utf8' });
export function deliveryPathAllowed(name) {
  return !/^(?:node_modules|output|backups|public|\.private|\.next|\.git|\.codex|\.agents|\.aws|\.vercel)(?:\/|$)/.test(name)
    && !/(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:log|tsbuildinfo|pem|key|p12|pfx))$/i.test(name.replace(/^\.env\.example$/, 'env-example'))
    && !/(?:^|\/)(?:credentials|service-account)(?:\.[^/]+)?\.json$/i.test(name);
}
const documentation = name => name.startsWith('docs/') || /\.md$/i.test(name);
export function candidateIdentity(files) {
  const list = Object.entries(files).filter(([name]) => !documentation(name)).sort(([a], [b]) => a.localeCompare(b, 'en'));
  return `cp6-${digest(JSON.stringify(list))}`;
}
export async function deliveryFiles(root, paths) {
  const files = {}, deleted = [];
  for (const name of [...new Set(paths)].sort()) {
    if (!deliveryPathAllowed(name)) continue;
    if (path.isAbsolute(name) || name.split('/').includes('..') || name.includes('\\')) throw new Error(`Unsafe candidate path: ${name}`);
    try {
      const stat = await lstat(path.join(root, name));
      if (!stat.isFile()) throw new Error(`Candidate requires a regular source file: ${name}`);
      const bytes = await readFile(path.join(root, name));
      files[name] = { sha256: digest(bytes), bytes: bytes.length };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      deleted.push(name);
    }
  }
  return { files, deleted };
}
export function compareManifest(manifest, current) {
  assert.equal(manifest.schemaVersion, 1, 'Unknown candidate format');
  assert.deepEqual(current.files, manifest.files, 'Candidate source changed, missing, or added; rerun affected checks before freezing a new candidate');
  assert.deepEqual(current.deleted, manifest.deleted, 'Candidate deletion list changed');
  assert.equal(manifest.candidateId, candidateIdentity(manifest.files), 'Candidate identity mismatch');
  assert.equal(manifest.deliveryDigest, digest(JSON.stringify({ files: manifest.files, deleted: manifest.deleted })), 'Delivery digest mismatch');
}
export async function preserveBaseline(root, baseline, trusted) {
  const slots = JSON.parse(await readFile(path.join(root, 'data/content-slots.json'), 'utf8')).slots;
  for (const slot of [...trusted.slots, ...baseline.slots]) {
    assert.deepEqual(semantic(slots.find(value => value.page === slot.page && value.key === slot.key) || {}), semantic(slot), `Changed content: ${slot.page} ${slot.key}`);
  }
  assert.equal(Object.keys(trusted.migrations).length, 24);
  for (const [name, expected] of Object.entries(trusted.migrations)) {
    const bytes = await readFile(path.join(root, 'db/migrations', name));
    assert.deepEqual({ bytes: digest(bytes), checksum: migrationChecksum(bytes.toString('utf8')) }, expected, name);
  }
  for (const [name, expected] of Object.entries(trusted.protectedFiles)) assert.equal(digest(await readFile(path.join(root, name))), expected, `CP5 protected file: ${name}`);
  return { migrationFiles: 24, requiredCP5Values: trusted.slots.length, allStartingValues: baseline.slots.length, currentValues: slots.length, protectedFiles: Object.keys(trusted.protectedFiles).length };
}

async function main() {
  const [mode, manifestArgument = 'output/cp6-home-focus/candidate.json', ...extra] = process.argv.slice(2);
  if (!['create', 'verify', 'verify-commit'].includes(mode) || (mode === 'verify-commit' ? extra.length !== 1 : extra.length)) throw new Error('Usage: node scripts/home-focus-candidate.mjs create|verify [manifest.json], or verify-commit manifest.json <commit>');
  if (mode === 'verify-commit') {
    const manifest = JSON.parse(await readFile(manifestArgument, 'utf8'));
    assert.equal(manifest.schemaVersion, 1, 'Unknown candidate format');
    assert.equal(manifest.candidateId, candidateIdentity(manifest.files), 'Candidate identity mismatch');
    assert.equal(manifest.deliveryDigest, digest(JSON.stringify({ files: manifest.files, deleted: manifest.deleted })), 'Delivery digest mismatch');
    const commit = git(['rev-parse', '--verify', `${extra[0]}^{commit}`]).trim();
    const tree = git(['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean);
    const actual = {};
    for (const entry of tree) {
      const [metadata, name] = entry.split('\t');
      const [mode, type, oid] = metadata.split(' ');
      assert.equal(type, 'blob', `Unsupported commit entry: ${name}`);
      assert.ok(['100644', '100755'].includes(mode), `Unsupported commit mode: ${name}`);
      // Extra tracked secrets/build output must fail rather than disappear here.
      actual[name] = oid;
    }
    assert.deepEqual(actual, manifest.gitObjects, 'Commit does not contain exactly the frozen deliverable Git objects');
    console.log(JSON.stringify({ verified: true, candidateId: manifest.candidateId, commit, check: 'Git-clean-filtered objects; original workspace bytes remain separately recorded' }));
    return;
  }
  const root = process.cwd();
  const paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const current = await deliveryFiles(root, paths);
  // Git's clean filters may normalize Windows CRLF at commit time. Record the
  // exact expected Git blobs as well as raw bytes; never rewrite source SQL.
  const names = Object.keys(current.files);
  const objectIds = git(['hash-object', '--', ...names]).trim().split('\n');
  assert.equal(names.length, objectIds.length);
  const gitObjects = Object.fromEntries(names.map((name, index) => [name, objectIds[index].trim()]));
  if (mode === 'verify') {
    const manifest = JSON.parse(await readFile(manifestArgument, 'utf8'));
    compareManifest(manifest, current);
    assert.deepEqual(gitObjects, manifest.gitObjects, 'Git clean-filtered content changed');
    console.log(JSON.stringify({ verified: true, candidateId: manifest.candidateId, deliveryDigest: manifest.deliveryDigest, files: Object.keys(current.files).length }));
    return;
  }
  const baseline = JSON.parse(await readFile('output/cp6-home-focus/baseline.json', 'utf8'));
  const trustedBytes = await readFile(baseline.trustedBaseline);
  assert.equal(digest(trustedBytes), baseline.trustedBaselineSha256, 'Trusted CP5 baseline changed');
  const trusted = JSON.parse(trustedBytes);
  const preservation = await preserveBaseline(root, baseline, trusted);
  const currentHead = git(['rev-parse', 'HEAD']).trim();
  assert.equal(currentHead, baseline.head, 'Unexpected HEAD change during CP6');
  const changed = Object.keys(baseline.files).filter(name => baseline.files[name].sha256 !== current.files[name]?.sha256);
  const added = Object.keys(current.files).filter(name => !(name in baseline.files));
  const manifest = { schemaVersion: 1, candidateId: candidateIdentity(current.files), headAtStart: baseline.head,
    identityScope: 'All delivery files except documentation; the deliveryDigest and per-file hashes additionally cover documentation. Generated build/evidence, dependencies and local secrets are excluded.',
    deliveryDigest: digest(JSON.stringify(current)), ...current, gitObjects, preservation,
    startingWorktree: baseline.status, finalWorktree: git(['status', '--short']),
    cp6Changes: { modifiedOrDeleted: changed, added },
    excluded: ['local secrets and credentials', 'node_modules', 'public', '.private', '.next', 'output', 'backups', 'tsconfig.tsbuildinfo'],
  };
  await mkdir(path.dirname(path.resolve(manifestArgument)), { recursive: true });
  // Freeze once; a new candidate uses a different file rather than replacing evidence.
  await writeFile(manifestArgument, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ candidateId: manifest.candidateId, deliveryDigest: manifest.deliveryDigest, files: Object.keys(current.files).length, preservation, cp6Changes: manifest.cp6Changes }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
