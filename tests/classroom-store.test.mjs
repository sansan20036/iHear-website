import { afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileClassroomStore } from '../lib/classroom-store';
import { classroomStoreContract } from './helpers/classroom-store-contract.mjs';

// The file store is what local development and the website tests run on; it must keep the
// same guarantees as PostgreSQL (tests/classroom-postgres.test.mjs runs the same contract).
const directory = await mkdtemp(path.join(os.tmpdir(), 'ihear-classroom-store-'));
const store = createFileClassroomStore(path.join(directory, 'classroom.json'));
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

classroomStoreContract('file store', () => store);
