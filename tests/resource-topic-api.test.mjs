import { afterAll, beforeAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadResourceApi, owner, resourceApiContract } from "./helpers/resource-api-contract.mjs";
let directory, api;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "ihear-topic-api-"));
  vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1"); vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
  vi.stubEnv("AUTH_OWNER_EMAILS", owner); vi.stubEnv("AUTH_SECRET", "resource-checkpoint-2-test-only");
  api = await loadResourceApi();
});
afterAll(async () => { vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });
resourceApiContract(() => api);
