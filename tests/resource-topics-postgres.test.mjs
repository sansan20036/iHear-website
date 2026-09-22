import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { schemaContainerTrace } from "./helpers/postgres-schema-trace.mjs";

// Real PostgreSQL, not SQL mocks. Uses only a disposable Docker container with
// no network, port bindings or host volumes; never reads a database URL/.env.
const container = `ihear-resource-schema-${randomUUID()}`;
const trace = schemaContainerTrace(container), docker = trace.docker;
let started = false, beforeLinks, beforeTranslations;
// The image's bootstrap server accepts Unix sockets, then shuts down normally.
// Container-local TCP becomes available only when the final server starts.
const sql = (query, database = "postgres") => docker(["exec", "-i", container, "psql", "-h", "127.0.0.1", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", "postgres", "-d", database], query).trim();
const json = query => JSON.parse(sql(query));
const migration = readFileSync(new URL("../db/migrations/023_resource_topics.sql", import.meta.url), "utf8");
const topic = (id = "test-topic", extra = "") => `INSERT INTO resource_topics(id,title,slug,created_by,updated_by${extra ? "," + extra.split("=")[0] : ""}) VALUES ('${id}','{"en":"Test","zhHant":"","zhHans":""}','${id}','test','test'${extra ? "," + extra.slice(extra.indexOf("=") + 1) : ""});`;
const link = (id, extra = "") => `INSERT INTO resource_links(id,title,description,url,created_by,updated_by${extra ? "," + extra.split("=")[0] : ""}) VALUES ('${id}','{"en":"Link","zhHant":"","zhHans":""}','{"en":"","zhHant":"","zhHans":""}','https://example.org','test','test'${extra ? "," + extra.slice(extra.indexOf("=") + 1) : ""});`;
function fails(query, code) {
  let error;
  try { sql(`BEGIN; ${query} ROLLBACK;`); } catch (caught) { error = caught; }
  expect(error, query).toBeTruthy();
  expect(error.stderr.toString()).toContain(code);
}

beforeAll(async () => {
  trace.mark("container-start-request");
  docker(["run", "--detach", "--pull=never", "--network", "none", "--name", container, "--label", "ihear-test=resource-schema", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { sql("SELECT 1"); ready = true; break; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); }
  }
  if (!ready) throw new Error("Isolated PostgreSQL did not become ready");
  trace.mark("readiness-accepted");
  const directory = path.resolve("db/migrations");
  for (const file of readdirSync(directory).filter(file => /^\d+_.*\.sql$/.test(file) && Number(file.slice(0, 3)) < 23).sort()) {
    trace.mark("historical-migration", { file });
    sql(`BEGIN; ${readFileSync(path.join(directory, file), "utf8")} COMMIT;`);
  }
  sql(`UPDATE resource_links SET title=jsonb_set(title,'{zhHant}','"人工保留"'),version=7,sort_order=52 WHERE id='tutor-reflection';
    UPDATE resource_links SET category='article',status='archived',archived_from_status='published' WHERE id='tutor-availability-2026-2027';`);
  beforeLinks = json("SELECT json_agg(r ORDER BY id) FROM resource_links r");
  beforeTranslations = json("SELECT json_agg(s ORDER BY resource_type,resource_scope,resource_id,field_key,locale) FROM localized_translation_states s");
  sql("CREATE DATABASE checkpoint_legacy TEMPLATE postgres");
  trace.mark("migration-023-start"); sql(`BEGIN; ${migration} COMMIT;`); trace.mark("schema-ready");
}, 120000);
afterAll(() => {
  if (!started) return;
  trace.mark("cleanup-enter");
  try { trace.capture("before-cleanup"); }
  finally {
    docker(["stop", "--time", "10", container]);
    try { trace.capture("after-stop"); }
    finally { docker(["rm", "--volumes", container]); trace.mark("cleanup-complete"); }
  }
}, 60000);

test("schema readiness and SQL use the main server TCP endpoint, never the bootstrap socket", () => {
  expect(sql("SELECT host(inet_server_addr())")).toBe("127.0.0.1");
  expect(docker(["exec", container, "cat", "/proc/1/comm"]).trim()).toBe("postgres");
});

test("migration preserves all old columns and translation states and maps both legacy categories", () => {
  const after = json("SELECT json_agg(to_jsonb(r) - 'topic_id' - 'type' ORDER BY id) FROM resource_links r");
  expect(after).toEqual(beforeLinks);
  const translations = json("SELECT json_agg(s ORDER BY resource_type,resource_scope,resource_id,field_key,locale) FROM localized_translation_states s WHERE NOT(resource_type='resource' AND resource_scope='topic')");
  expect(translations).toEqual(beforeTranslations);
  expect(json("SELECT json_agg(json_build_array(category,topic_id,type) ORDER BY id) FROM resource_links")).toEqual(beforeLinks.map(row => [row.category, row.category === "article" ? "articles" : "forms", "external_link"]));
  expect(sql("SELECT count(*) FROM resource_topics")).toBe("7");
  expect(sql("SELECT count(*) FROM localized_translation_states WHERE resource_scope='topic'")).toBe("14");
});

test("topic defaults, RLS, unique index and FK/order index exist", () => {
  const value = json(`BEGIN; ${topic()} SELECT row_to_json(r) FROM resource_topics r WHERE id='test-topic'; ROLLBACK;`);
  expect(value).toMatchObject({ status: "draft", version: 1, sort_order: 0, description: { en: "", zhHant: "", zhHans: "" }, archived_from_status: null });
  expect(value.created_at).toBeTruthy(); expect(value.updated_at).toBeTruthy();
  expect(sql("SELECT relrowsecurity FROM pg_class WHERE oid='resource_topics'::regclass")).toBe("t");
  expect(sql("SELECT count(*) FROM pg_indexes WHERE indexname IN ('resource_topics_slug_key','resource_topics_public_order','resource_links_topic_order')")).toBe("3");
});

test("old INSERT/UPSERT works without type/topic and old recategorization follows its built-in topic", () => {
  const value = json(`BEGIN; ${link("legacy")}
    ${link("legacy").replace(/;$/, " ON CONFLICT(id) DO UPDATE SET category='article',title=EXCLUDED.title,version=resource_links.version+1;")}
    SELECT row_to_json(r) FROM resource_links r WHERE id='legacy'; ROLLBACK;`);
  expect(value).toMatchObject({ status: "draft", type: "external_link", topic_id: "articles", category: "article", version: 2 });
});

test("old UPSERT preserves an explicitly moved topic, type, and translation state", () => {
  const value = json(`BEGIN; ${link("moved", "topic_id='calendar'")}
    ${link("moved").replace(/;$/, " ON CONFLICT(id) DO UPDATE SET category='article',url=EXCLUDED.url;")}
    SELECT row_to_json(r) FROM resource_links r WHERE id='moved'; ROLLBACK;`);
  expect(value).toMatchObject({ topic_id: "calendar", type: "external_link", category: "article" });
});

describe("actual PostgreSQL constraints", () => {
  test.each([
    ["duplicate slug", `${topic()} ${topic("test-other").replace("'test-other','test','test'", "'test-topic','test','test'")}`, "23505"],
    ["bad slug", topic().replace("'test-topic','test','test'", "'Journal Club','test','test'"), "23514"],
    ["empty title", topic().replace('"en":"Test"', '"en":" "'), "23514"],
    ["null English", topic().replace('"en":"Test"', '"en":null'), "23514"],
    ["missing locale", topic().replace(',"zhHans":""', ''), "23514"],
    ["negative order", topic("test-topic", "sort_order=-1"), "23514"],
    ["zero version", topic("test-topic", "version=0"), "23514"],
    ["invalid status", topic("test-topic", "status='hidden'"), "23514"],
    ["bad archive origin", topic("test-topic", "status,archived_from_status='archived','archived'"), "23514"],
    ["missing FK", link("bad-ref", "topic_id='missing'"), "23503"],
    ["unknown type", link("bad-type", "type='file'"), "23514"],
    ["null type", link("null-type", "type=NULL"), "23502"],
    ["email with URL", link("email", "type='email_request'"), "23514"],
    ["text with URL", link("text", "type='text'"), "23514"],
    ["insecure URL", link("http").replace("https://example.org", "http://example.org"), "23514"],
    ["credential URL", link("credentials").replace("https://example.org", "https://user:pass@example.org"), "23514"],
    ["parent delete", "DELETE FROM resource_topics WHERE id='forms';", "23503"],
    ["parent ID update", "UPDATE resource_topics SET id='new-forms' WHERE id='forms';", "23503"],
    ["archive with active children", "UPDATE resource_topics SET status='archived' WHERE id='forms';", "23514"],
    ["archive with archived children", "UPDATE resource_topics SET status='archived' WHERE id='articles';", "23514"],
    ["reference archived parent", `${topic("closed", "status='archived'")} ${link("child", "topic_id='closed'")}`, "23514"],
    ["mutate stable slug", "UPDATE resource_topics SET slug='changed' WHERE id='calendar';", "23514"],
    ["reuse archived slug", `${topic("closed", "status='archived'")} ${topic("other").replace("'other','test','test'", "'closed','test','test'")}`, "23505"],
  ])("rejects %s", (_name, query, code) => fails(query, code));
  test.each(["email_request", "text"])("accepts explicit %s with an empty URL", type => {
    expect(sql(`BEGIN; ${link("nonlink", `type='${type}'`).replace("'https://example.org'", "''")} SELECT type FROM resource_links WHERE id='nonlink'; ROLLBACK;`)).toBe(type);
  });
});

test("hide retains children; archive captures old state and restoration clears metadata", () => {
  const value = json(`BEGIN; UPDATE resource_topics SET status='draft' WHERE id='forms';
    ${topic("empty", "status='published'")}
    UPDATE resource_topics SET status='archived' WHERE id='empty';
    SELECT json_build_object('origin',(SELECT archived_from_status FROM resource_topics WHERE id='empty'),
      'children',(SELECT count(*) FROM resource_links WHERE topic_id='forms'),
      'childStatus',(SELECT status FROM resource_links WHERE id='tutor-reflection'));
    ROLLBACK;`);
  expect(value).toEqual({ origin: "published", children: 2, childStatus: "published" });
  expect(sql(`BEGIN; ${topic("restore", "status='published'")}
    UPDATE resource_topics SET status='archived' WHERE id='restore';
    UPDATE resource_topics SET status=COALESCE(archived_from_status,'draft') WHERE id='restore';
    SELECT status || ':' || COALESCE(archived_from_status,'cleared') FROM resource_topics WHERE id='restore'; ROLLBACK;`)).toBe("published:cleared");
  expect(sql(`BEGIN; ${link("restore-link")}
    UPDATE resource_links SET status='archived' WHERE id='restore-link';
    SELECT archived_from_status FROM resource_links WHERE id='restore-link'; ROLLBACK;`)).toBe("draft");
});

test("rerun leaves modified topics, moved items, versions, history and translation locks unchanged", () => {
  sql(`UPDATE resource_topics SET title=jsonb_set(title,'{zhHant}','"保留管理員名稱"'),status='draft',version=8 WHERE id='forms';
    UPDATE resource_links SET topic_id='calendar',version=8 WHERE id='tutor-reflection';
    UPDATE localized_translation_states SET origin='protected_legacy' WHERE resource_scope='topic' AND resource_id='forms';`);
  const snapshot = () => json(`SELECT json_build_object(
    'topics',(SELECT json_agg(r ORDER BY id) FROM resource_topics r),
    'items',(SELECT json_agg(r ORDER BY id) FROM resource_links r),
    'states',(SELECT json_agg(s ORDER BY resource_type,resource_scope,resource_id,field_key,locale) FROM localized_translation_states s));`);
  const before = snapshot();
  sql(`BEGIN; ${migration} COMMIT;`); sql(`BEGIN; ${migration} COMMIT;`);
  expect(snapshot()).toEqual(before);
});

test("invalid legacy data rolls back the entire migration rather than silently rewriting content", () => {
  sql("UPDATE resource_links SET url='https://' WHERE id='tutor-reflection'", "checkpoint_legacy");
  expect(() => sql(`BEGIN; ${migration} COMMIT;`, "checkpoint_legacy")).toThrow();
  expect(sql("SELECT to_regclass('public.resource_topics') IS NULL", "checkpoint_legacy")).toBe("t");
  expect(sql("SELECT count(*) FROM information_schema.columns WHERE table_name='resource_links' AND column_name IN ('topic_id','type')", "checkpoint_legacy")).toBe("0");
  expect(sql("SELECT url FROM resource_links WHERE id='tutor-reflection'", "checkpoint_legacy")).toBe("https://");
  sql("UPDATE resource_links SET url='https://example.org/corrected' WHERE id='tutor-reflection'", "checkpoint_legacy");
  sql(`BEGIN; ${migration} COMMIT;`, "checkpoint_legacy");
  expect(sql("SELECT count(*) FROM resource_topics", "checkpoint_legacy")).toBe("7");
});
