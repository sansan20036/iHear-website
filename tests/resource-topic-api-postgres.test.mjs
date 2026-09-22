import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { migratedGuideIds } from "../lib/resource-guides-takeover.ts";
import { context, loadResourceApi, localized, owner, request, resourceApiContract } from "./helpers/resource-api-contract.mjs";

// An ephemeral database exposed only to the local test process. No .env is
// loaded; its random credentials and loopback port are generated here.
const container = `ihear-resource-api-${randomUUID()}`, password = randomUUID();
const docker = args => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }).trim();
let started = false, db, api;
beforeAll(async () => {
  docker(["run", "--detach", "--rm", "--pull=never", "--name", container, "--label", "ihear-test=resource-api", "-p", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${password}`, "postgres:17-alpine"]);
  started = true;
  const binding = JSON.parse(docker(["inspect", "--format", '{{json (index .NetworkSettings.Ports "5432/tcp")}}', container]))[0];
  if (binding.HostIp !== "127.0.0.1" || !/^\d+$/.test(binding.HostPort)) throw new Error("Test database must bind only to loopback");
  const url = `postgres://postgres:${password}@127.0.0.1:${binding.HostPort}/postgres`;
  db = postgres(url, { ssl: false, max: 2, connect_timeout: 2, onnotice: () => {} });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await db`SELECT 1`; ready = true; break; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); }
  }
  if (!ready) throw new Error("Local test PostgreSQL did not become ready");
  for (const file of (await readdir("db/migrations")).filter(file => /^\d+_.*\.sql$/.test(file) && Number(file.slice(0, 3)) <= 23).sort()) {
    const source = await readFile(`db/migrations/${file}`, "utf8");
    await db.begin(async tx => { await tx.unsafe(source); });
  }
  vi.stubEnv("POSTGRES_URL", url); vi.stubEnv("DATABASE_URL", url); vi.stubEnv("POSTGRES_SSL", "disable");
  vi.stubEnv("IHEAR_FORCE_FILE_STORE", "0"); vi.stubEnv("AUTH_OWNER_EMAILS", owner); vi.stubEnv("AUTH_SECRET", "resource-checkpoint-2-test-only");
  api = await loadResourceApi();
}, 120000);
afterAll(async () => {
  if (globalThis.ihearTranslationSql) { await globalThis.ihearTranslationSql.end({ timeout: 1 }); delete globalThis.ihearTranslationSql; delete globalThis.ihearTranslationSchemaReady; }
  if (db) await db.end({ timeout: 1 });
  if (started) docker(["stop", "--time", "1", container]);
  vi.unstubAllEnvs();
}, 30000);
resourceApiContract(() => api);

test("public API reads the takeover marker and all guide records from the same SQL snapshot", async () => {
  const read = async () => { const response = await api.items.GET(request('resources')); return { status: response.status, body: await response.json() }; };
  expect((await read()).body.guidesTakeover).toBe('legacy');
  try {
    await db.begin(async tx => {
      for (const [index, id] of migratedGuideIds.entries()) await tx`
        INSERT INTO resource_links(id,category,title,description,url,sort_order,status,created_by,updated_by,topic_id,type)
        VALUES (${id},'form',${tx.json(localized('Guide '+index,'指南繁 '+index,'指南简 '+index))},${tx.json(localized(''))},'',${index},'published','test','test','guides','email_request')`;
      await tx`UPDATE resource_topics SET status='published' WHERE id='guides'`;
    });
    expect((await read()).status).toBe(503);
    await db`INSERT INTO site_settings(key,value,updated_by) VALUES ('resource_guides_takeover_v1','complete','test')`;
    let result = await read(); expect(result.status).toBe(200); expect(result.body.guidesTakeover).toBe('complete');
    expect(result.body.items.filter(i => i.topicId === 'guides')).toHaveLength(9);
    await db`UPDATE resource_topics SET status='draft' WHERE id='guides'`;
    result = await read(); expect(result.status).toBe(200); expect(result.body.guidesTakeover).toBe('complete');
    expect(result.body.items.filter(i => i.topicId === 'guides')).toHaveLength(0);
    await db`DELETE FROM resource_links WHERE id='guide-communication'`;
    expect((await read()).status).toBe(503);
  } finally {
    await db`DELETE FROM resource_links WHERE id = ANY(${migratedGuideIds})`;
    await db`DELETE FROM site_settings WHERE key='resource_guides_takeover_v1'`;
    await db`UPDATE resource_topics SET status='draft' WHERE id='guides'`;
  }
});

test("topic text and its translation states roll back together on a database failure", async () => {
  const { topic } = await (await api.topics.POST(request("resource-topics", "POST", { title: localized("Rollback topic", "人工文字", "人工文字") }))).json();
  const before = await api.store.getResourceTopic(topic.id);
  const [row] = await db`SELECT * FROM localized_translation_states WHERE resource_type='resource' AND resource_scope='topic' AND resource_id=${topic.id} AND locale='zhHant'`;
  await expect(api.store.updateResourceTopic(topic.id, before.version, { title: { ...before.title, zhHant: "不應保存" }, description: before.description, sortOrder: 999, status: "draft" }, owner,
    [{ field: "title", locale: "zhHant", sourceHash: null, origin: "invalid-origin", glossaryVersion: "test" }])).rejects.toThrow();
  expect(await api.store.getResourceTopic(topic.id)).toEqual(before);
  const [after] = await db`SELECT * FROM localized_translation_states WHERE resource_type='resource' AND resource_scope='topic' AND resource_id=${topic.id} AND locale='zhHant'`;
  expect(after).toEqual(row);
});

test("item move and topic archive serialize without creating a reference to an archived topic", async () => {
  const { topic } = await (await api.topics.POST(request("resource-topics", "POST", { title: localized("Concurrent parent") }))).json();
  const { item } = await (await api.items.POST(request("resources", "POST", { title: localized("Concurrent child"), type: "text", topicId: "forms" }))).json();
  const results = await Promise.all([
    api.item.PATCH(request("resources", "PATCH", { version: item.version, topicId: topic.id }), context(item.id)),
    api.topic.DELETE(request("resource-topics", "DELETE", { version: topic.version }), context(topic.id)),
  ]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const [row] = await db`SELECT count(*)::int AS invalid FROM resource_links r JOIN resource_topics t ON t.id=r.topic_id WHERE t.status='archived'`;
  expect(row.invalid).toBe(0);
});
