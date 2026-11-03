import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DATABASE_MODES, configuredDatabaseUrl, databaseModeOf, logDatabaseModeOnce } from "../lib/database-mode";

// Synthetic URLs only: the project code, users and passwords are made up, and nothing connects.
const pooler = (port, host = "aws-0-ap-northeast-1.pooler.supabase.com") => `postgresql://postgres.testref0000000000000:TEST-only@${host}${port ? `:${port}` : ""}/postgres`;
const direct = (port) => `postgresql://postgres:TEST-only@db.testref0000000000000.supabase.co${port ? `:${port}` : ""}/postgres`;
const OUTPUT = /^ihear-db-mode=(transaction-pooler|session-pooler|direct|local|none|unknown)$/;
const PLANTED = "PLANTED-SECRET-5c1e";

let output;
function captureConsole() {
  output = [];
  for (const method of ["info", "log", "warn", "error", "debug"]) vi.spyOn(console, method).mockImplementation((...args) => { output.push({ method, args }); });
}

beforeEach(() => {
  delete globalThis.ihearDatabaseModeLogged;
  vi.stubEnv("POSTGRES_URL", "");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("IHEAR_FORCE_FILE_STORE", "");
  vi.stubEnv("PGHOST", "");
  vi.stubEnv("PGPORT", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete globalThis.ihearDatabaseModeLogged;
});

describe("databaseModeOf: only the host and the port decide, and nothing is guessed", () => {
  test.each([
    [pooler(6543), "transaction-pooler"],
    [pooler(5432), "session-pooler"],
    [pooler(""), "session-pooler"],
    [pooler(5433), "unknown"],
    [pooler(6543, "AWS-0-AP-NORTHEAST-1.POOLER.SUPABASE.COM"), "transaction-pooler"],
    [pooler(6543).replace("postgresql:", "postgres:") + "?sslmode=require&pgbouncer=true", "transaction-pooler"],
    [direct(5432), "direct"],
    [direct(""), "direct"],
    [direct(6543), "unknown"],
    ["postgres://postgres:TEST-only@127.0.0.1:5432/site", "local"],
    ["postgres://postgres:TEST-only@localhost/site", "local"],
    ["postgres://postgres:TEST-only@[::1]:5432/site", "local"],
    ["postgres://postgres:TEST-only@example.com:5432/site", "unknown"],
    ["postgres://u:TEST-only@pooler.supabase.com.example.net:6543/db", "unknown"],
    ["postgres://u:TEST-only@xpooler.supabase.com:6543/db", "unknown"],
    ["postgres://u:TEST-only@db.testref0000000000000.supabase.co.example.net:5432/db", "unknown"],
    ["postgres://u:TEST-only@a.pooler.supabase.com,b.pooler.supabase.com:6543/db", "unknown"],
    ["mysql://u:TEST-only@aws-0-ap-northeast-1.pooler.supabase.com:6543/db", "unknown"],
    ["not a url", "unknown"],
    ["postgres://TEST-only@[bad", "unknown"],
    ["", "none"],
  ])("%s -> %s", (url, mode) => {
    expect(databaseModeOf(url, {})).toBe(mode);
  });

  test("a URL without a host or port falls back to PGHOST and PGPORT, as postgres.js does", () => {
    expect(databaseModeOf(pooler(""), { PGPORT: "6543" })).toBe("transaction-pooler");
    expect(databaseModeOf("postgres:///db", { PGHOST: "aws-0-ap-northeast-1.pooler.supabase.com", PGPORT: "6543" })).toBe("transaction-pooler");
    expect(databaseModeOf("postgres:///db", {})).toBe("local");
    // Credentials without a host are no URL for postgres.js either.
    expect(databaseModeOf("postgres://u:TEST-only@/db", { PGHOST: "aws-0-ap-northeast-1.pooler.supabase.com" })).toBe("unknown");
    expect(databaseModeOf(pooler(6543), { PGPORT: "5432" })).toBe("transaction-pooler");
  });

  test("whatever the input, the answer is one of the fixed words", () => {
    let seed = 20261103;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    const alphabet = "postgres:/@.,[]%?#=-_6543 aAbBzZ0189:supabase.co.pooler.comé測";
    for (let index = 0; index < 500; index++) {
      const length = next() % 80;
      let text = "";
      for (let position = 0; position < length; position++) text += alphabet[next() % alphabet.length];
      const url = index % 2 ? `postgres://${text}` : text;
      expect(DATABASE_MODES).toContain(databaseModeOf(url, {}));
    }
  });
});

describe("configuredDatabaseUrl: the stores' rule", () => {
  test("POSTGRES_URL first, then DATABASE_URL; IHEAR_FORCE_FILE_STORE=1 means no database", () => {
    expect(configuredDatabaseUrl({ POSTGRES_URL: pooler(6543), DATABASE_URL: pooler(5432) })).toBe(pooler(6543));
    expect(configuredDatabaseUrl({ POSTGRES_URL: "", DATABASE_URL: pooler(5432) })).toBe(pooler(5432));
    expect(configuredDatabaseUrl({ IHEAR_FORCE_FILE_STORE: "1", POSTGRES_URL: pooler(6543) })).toBe("");
    expect(configuredDatabaseUrl({})).toBe("");
  });
});

describe("logDatabaseModeOnce: one fixed line per instance, never a secret, never an error", () => {
  test("writes exactly one line of the fixed form for each kind of configuration", () => {
    for (const [env, mode] of [
      [{ POSTGRES_URL: pooler(6543) }, "transaction-pooler"],
      [{ DATABASE_URL: pooler(5432) }, "session-pooler"],
      [{ POSTGRES_URL: direct(5432) }, "direct"],
      [{ POSTGRES_URL: "postgres://postgres:TEST-only@127.0.0.1:5432/site" }, "local"],
      [{ IHEAR_FORCE_FILE_STORE: "1", POSTGRES_URL: pooler(6543) }, "none"],
      [{ POSTGRES_URL: "postgres://u:TEST-only@example.com:5432/db" }, "unknown"],
    ]) {
      delete globalThis.ihearDatabaseModeLogged;
      vi.unstubAllEnvs();
      for (const [name, value] of Object.entries({ POSTGRES_URL: "", DATABASE_URL: "", IHEAR_FORCE_FILE_STORE: "", PGHOST: "", PGPORT: "", ...env })) vi.stubEnv(name, value);
      captureConsole();
      logDatabaseModeOnce();
      expect(output).toEqual([{ method: "info", args: [`ihear-db-mode=${mode}`] }]);
      vi.restoreAllMocks();
    }
  });

  test("planted secrets in the user, password, host, path and query never reach the output", () => {
    for (const [url, mode] of [
      [`postgresql://PLANTED-USER:${PLANTED}@aws-0-ap-northeast-1.pooler.supabase.com:6543/PLANTED-DB?application_name=PLANTED-QUERY`, "transaction-pooler"],
      [`postgres://PLANTED-USER:${PLANTED}@planted-host.example:5432/db`, "unknown"],
      [`postgres://${PLANTED}@[bad`, "unknown"],
      [`not a url ${PLANTED}`, "unknown"],
    ]) {
      delete globalThis.ihearDatabaseModeLogged;
      vi.stubEnv("POSTGRES_URL", url);
      captureConsole();
      logDatabaseModeOnce();
      expect(output).toHaveLength(1);
      expect(output[0].args).toHaveLength(1);
      expect(output[0].args[0]).toMatch(OUTPUT);
      expect(output[0].args[0]).toBe(`ihear-db-mode=${mode}`);
      const text = JSON.stringify(output);
      for (const forbidden of ["PLANTED", "planted", "supabase", "://", "@", "TEST-only", "6543", "5432"]) expect(text).not.toContain(forbidden);
      vi.restoreAllMocks();
    }
  });

  test("writes once however often it is called", () => {
    vi.stubEnv("POSTGRES_URL", pooler(6543));
    captureConsole();
    logDatabaseModeOnce();
    logDatabaseModeOnce();
    logDatabaseModeOnce();
    expect(output).toEqual([{ method: "info", args: ["ihear-db-mode=transaction-pooler"] }]);
  });

  test("a failing log call is swallowed and nothing else is written", () => {
    vi.stubEnv("POSTGRES_URL", `postgresql://u:${PLANTED}@aws-0-ap-northeast-1.pooler.supabase.com:6543/db`);
    captureConsole();
    console.info.mockImplementation(() => { throw new Error(`log failed ${PLANTED}`); });
    expect(() => logDatabaseModeOnce()).not.toThrow();
    expect(output).toEqual([]);
    expect(() => logDatabaseModeOnce()).not.toThrow();
  });
});
