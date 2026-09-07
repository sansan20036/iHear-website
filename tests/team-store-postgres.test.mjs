import { beforeEach, describe, expect, test, vi } from "vitest";

const postgres = vi.hoisted(() => vi.fn());

vi.mock("postgres", () => ({ default: postgres }));

describe("team profile PostgreSQL ordering", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/ihear");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("IHEAR_FORCE_FILE_STORE", "0");
    delete globalThis.ihearTeamSql;
    postgres.mockReset();
  });

  test("uses a JSON recordset for one atomic bulk update", async () => {
    const queries = [];
    const json = vi.fn((value) => ({ serialized: value }));
    const tx = vi.fn(async (strings, ...values) => {
      if (!strings?.raw) throw new TypeError("SQL must be called as a tagged template");
      const text = strings.join("?");
      queries.push({ text, values });
      if (text.includes("SELECT id, version")) {
        return [
          { id: "tutor-amber", version: 4 },
          { id: "tutor-tristan", version: 2 },
        ];
      }
      return [];
    });
    tx.json = json;
    const sql = Object.assign(vi.fn(), {
      begin: vi.fn((callback) => callback(tx)),
    });
    postgres.mockReturnValue(sql);

    const { reorderTeamProfiles } = await import("../lib/team-store");
    await reorderTeamProfiles("tutor", [
      { id: "tutor-amber", version: 4 },
      { id: "tutor-tristan", version: 2 },
    ], "admin@example.com");

    expect(sql.begin).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith([
      { id: "tutor-amber", sort_order: 10 },
      { id: "tutor-tristan", sort_order: 20 },
    ]);
    const update = queries.find((query) => query.text.includes("UPDATE team_profiles"));
    expect(update?.text).toContain("jsonb_to_recordset");
    expect(update?.text).toContain("AS ordering(id TEXT, sort_order INTEGER)");
    expect(update?.text).toContain("profile.section");
    expect(update?.text).toContain("profile.deleted_at IS NULL");
  });
});
