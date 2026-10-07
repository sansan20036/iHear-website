import { test, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deliveryPathAllowed, deliveryFiles, candidateIdentity, compareManifest } from '../scripts/home-focus-candidate.mjs';

test('candidate includes deployable sources and example config but excludes secrets, dependencies and evidence', () => {
  for (const name of ['package-lock.json', '.env.example', 'db/migrations/024_home_banner_gallery.sql', 'assets/home-banner.js', 'docs/home-focus-release-runbook.md']) expect(deliveryPathAllowed(name)).toBe(true);
  for (const name of ['.env', '.env.local', 'nested/.env.production', 'credentials.json', 'private.pem', 'node_modules/a.js', '.next/BUILD_ID', '.private/index.html', 'public/index.html', 'output/results.json', 'tsconfig.tsbuildinfo']) expect(deliveryPathAllowed(name)).toBe(false);
});
test('candidate verification detects altered bytes, added or missing sources and tampered manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ihear-candidate-'));
  try {
    await writeFile(path.join(root, 'index.html'), '<p>accepted</p>');
    const current = await deliveryFiles(root, ['index.html', '.env.local']);
    const manifest = { schemaVersion: 1, ...current, candidateId: candidateIdentity(current.files), deliveryDigest: createHash('sha256').update(JSON.stringify(current)).digest('hex') };
    expect(() => compareManifest(manifest, current)).not.toThrow();
    await writeFile(path.join(root, 'index.html'), '<p>changed</p>');
    expect(() => compareManifest(manifest, { ...current, files: {} })).toThrow();
    expect(() => compareManifest(manifest, { files: { ...current.files, 'new.js': { sha256: 'new', bytes: 3 } }, deleted: [] })).toThrow();
    expect(() => compareManifest(manifest, { files: current.files, deleted: ['deleted.js'] })).toThrow();
    expect(() => compareManifest({ ...manifest, candidateId: 'wrong' }, current)).toThrow();
    expect(() => compareManifest({ ...manifest, deliveryDigest: 'wrong' }, current)).toThrow();
    const altered = await deliveryFiles(root, ['index.html']);
    expect(() => compareManifest(manifest, altered)).toThrow();
    await expect(deliveryFiles(root, ['../escape.js'])).rejects.toThrow('Unsafe candidate path');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('documentation is included in delivery integrity but does not create a circular code identity', () => {
  const files = { 'package-lock.json': { sha256: 'lock', bytes: 4 }, 'docs/report.md': { sha256: 'before', bytes: 6 } };
  expect(candidateIdentity(files)).toBe(candidateIdentity({ ...files, 'docs/report.md': { sha256: 'after', bytes: 5 } }));
  expect(candidateIdentity(files)).not.toBe(candidateIdentity({ ...files, 'package-lock.json': { sha256: 'new', bytes: 3 } }));
});
test('the frozen Git objects verify an isolated commit after CRLF normalization and reject an extra committed file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ihear-candidate-git-'));
  const script = fileURLToPath(new URL('../scripts/home-focus-candidate.mjs', import.meta.url));
  const runGit = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    runGit(['init']); runGit(['config', 'core.autocrlf', 'true']);
    runGit(['config', 'user.name', 'Isolated candidate test']); runGit(['config', 'user.email', 'candidate@example.test']);
    await writeFile(path.join(root, 'index.html'), '<p>accepted</p>\r\n');
    const current = await deliveryFiles(root, ['index.html']);
    const manifest = { schemaVersion: 1, ...current, candidateId: candidateIdentity(current.files), deliveryDigest: createHash('sha256').update(JSON.stringify(current)).digest('hex'), gitObjects: { 'index.html': runGit(['hash-object', '--', 'index.html']).trim() } };
    const manifestPath = path.join(root, 'candidate.json'); await writeFile(manifestPath, JSON.stringify(manifest));
    runGit(['add', 'index.html']); runGit(['commit', '-m', 'isolated fixture']);
    const check = () => spawnSync(process.execPath, [script, 'verify-commit', manifestPath, 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
    expect(check().status).toBe(0);
    await writeFile(path.join(root, 'extra.js'), 'unverified'); runGit(['add', 'extra.js']); runGit(['commit', '-m', 'extra fixture']);
    expect(check().status).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
