// The room channel's service over the store in memory (2026-11-23). The tests are in
// service-suite.mjs; postgres.test.mjs runs the same ones over a disposable local PostgreSQL.
//   node --test "tests/room-channel/*.test.mjs"
import { createMemoryStore } from '../../lib/room-channel/store-memory.mjs';
import { serviceSuite } from './service-suite.mjs';

serviceSuite({ make: async () => createMemoryStore() });
