import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileClassroomStore, databaseProvider } from '../lib/classroom-store';
import { classroomStoreContract } from './helpers/classroom-store-contract.mjs';

// The file store is what local development and the website tests run on; it must keep the
// same guarantees as PostgreSQL (tests/classroom-postgres.test.mjs runs the same contract).
const directory = await mkdtemp(path.join(os.tmpdir(), 'ihear-classroom-store-'));
const store = createFileClassroomStore(path.join(directory, 'classroom.json'));
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

classroomStoreContract('file store', () => store);

// PostgreSQL keeps the vendor as migration 028 names it; the file store keeps the adapter's name.
test('recordings are stored under 028\'s vendor names, and a vendor 028 does not list is refused, not relabelled', () => {
  expect(['zoom-video-sdk', 'zoom', 'synthetic', null, undefined].map(databaseProvider)).toEqual(['zoom', 'zoom', 'synthetic', 'zoom', 'zoom']);
  for (const provider of ['tencent-lcic', 'agora', 'ZOOM', '', '__proto__', 'constructor']) {
    expect(() => databaseProvider(provider), String(provider)).toThrow(/migration 028 allows only zoom and synthetic/);
  }
});
