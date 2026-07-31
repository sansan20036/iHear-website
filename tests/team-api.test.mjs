import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("../lib/live-revisions", () => ({ revisionAfterMutation: vi.fn() }));
vi.mock("../lib/team-store", () => {
  class TeamNotFoundError extends Error {}
  class TeamConflictError extends Error {}
  class TeamDuplicatePlacementError extends Error {}
  class TeamConfigurationError extends Error {}
  return {
    TEAM_CACHE_TAG: "team-profiles-v1",
    TeamNotFoundError,
    TeamConflictError,
    TeamDuplicatePlacementError,
    TeamConfigurationError,
    listPublishedTeamProfiles: vi.fn(),
    listAllTeamProfiles: vi.fn(),
    createTeamProfile: vi.fn(),
    updateTeamProfile: vi.fn(),
    deleteTeamProfile: vi.fn(),
    reorderTeamProfiles: vi.fn(),
  };
});

import { revalidatePath, revalidateTag } from "next/cache";
import { auth } from "../auth.js";
import { GET, POST } from "../app/api/team-profiles/route";
import { DELETE, PATCH } from "../app/api/team-profiles/[id]/route";
import { PATCH as REORDER } from "../app/api/team-profiles/reorder/route";
import * as store from "../lib/team-store";
import { revisionAfterMutation } from "../lib/live-revisions";

const email = "sansan20036@gmail.com";
const localized = (en) => ({ en, zhHant: "", zhHans: "" });
const payload = {
  name: "Test Tutor",
  initials: "TT",
  consentConfirmed: true,
  section: "tutor",
  status: "published",
  sortOrder: 10,
  school: "Test School",
  grade: "10",
  showSchool: true,
  showGrade: true,
  role: localized("Lead Tutor"),
  schoolDisplay: localized("Test School"),
  languages: localized("English"),
  strengths: localized("Confidence"),
  summary: localized("A patient tutor."),
  bio: localized("A complete biography."),
  hobbies: localized("Reading"),
};
const stored = {
  id: "tutor-test",
  personId: "person-test",
  ...payload,
  publicationConsentAt: "2026-07-31T00:00:00.000Z",
  profileVersion: 1,
  personVersion: 1,
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  updatedBy: email,
};
const json = (url, method, body) =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const context = { params: Promise.resolve({ id: stored.id }) };

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { email, isAdmin: true } });
  store.listPublishedTeamProfiles.mockResolvedValue([stored]);
  store.listAllTeamProfiles.mockResolvedValue([stored]);
  store.createTeamProfile.mockResolvedValue(stored);
  store.updateTeamProfile.mockResolvedValue({ ...stored, profileVersion: 2, personVersion: 2 });
  store.deleteTeamProfile.mockResolvedValue(stored.id);
  store.reorderTeamProfiles.mockResolvedValue(true);
  revisionAfterMutation.mockResolvedValue({ revision: "2", updatedAt: "2026-07-31T00:00:00.000Z" });
});

describe("team profile API", () => {
  test("public listing is cached for one second and excludes private consent metadata", async () => {
    const response = await GET(new Request("http://localhost/api/team-profiles"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, s-maxage=1");
    expect(body.tutors).toHaveLength(1);
    expect(body.tutors[0]).not.toHaveProperty("publicationConsentAt");
  });

  test("admin listing is private and includes people for shared placements", async () => {
    const response = await GET(new Request("http://localhost/api/team-profiles?includeDrafts=true"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.admin).toBe(true);
    expect(body.people).toEqual([
      expect.objectContaining({ id: "person-test", consentConfirmed: true }),
    ]);
  });

  test("all write operations and draft reads reject anonymous users", async () => {
    auth.mockResolvedValue(null);
    const responses = await Promise.all([
      GET(new Request("http://localhost/api/team-profiles?includeDrafts=true")),
      POST(json("http://localhost/api/team-profiles", "POST", payload)),
      PATCH(json("http://localhost/api/team-profiles/tutor-test", "PATCH", {
        ...payload,
        profileVersion: 1,
        personVersion: 1,
      }), context),
      DELETE(json("http://localhost/api/team-profiles/tutor-test", "DELETE", {
        profileVersion: 1,
        personVersion: 1,
      }), context),
      REORDER(json("http://localhost/api/team-profiles/reorder", "PATCH", {
        section: "tutor",
        ordered: [{ id: "tutor-test", version: 1 }],
      })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
  });

  test("creates, updates, deletes, and invalidates caches", async () => {
    expect((await POST(json("http://localhost/api/team-profiles", "POST", payload))).status).toBe(201);
    expect((await PATCH(json("http://localhost/api/team-profiles/tutor-test", "PATCH", {
      ...payload,
      profileVersion: 1,
      personVersion: 1,
    }), context)).status).toBe(200);
    expect((await DELETE(json("http://localhost/api/team-profiles/tutor-test", "DELETE", {
      profileVersion: 1,
      personVersion: 1,
    }), context)).status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith("team-profiles-v1", { expire: 0 });
    expect(revalidatePath).toHaveBeenCalledWith("/team");
    expect(revalidatePath).toHaveBeenCalledWith("/api/live-revisions");
  });

  test("rejects publishing without consent or required English content", async () => {
    const response = await POST(json("http://localhost/api/team-profiles", "POST", {
      ...payload,
      consentConfirmed: false,
      summary: localized(""),
    }));
    expect(response.status).toBe(400);
    expect(store.createTeamProfile).not.toHaveBeenCalled();
  });

  test("returns 409 when an optimistic update loses concurrency", async () => {
    store.updateTeamProfile.mockRejectedValue(new store.TeamConflictError("changed"));
    const response = await PATCH(json("http://localhost/api/team-profiles/tutor-test", "PATCH", {
      ...payload,
      profileVersion: 1,
      personVersion: 1,
    }), context);
    expect(response.status).toBe(409);
  });

  test("reorder validates versions and uses one transaction call", async () => {
    const response = await REORDER(json("http://localhost/api/team-profiles/reorder", "PATCH", {
      section: "tutor",
      ordered: [{ id: "tutor-test", version: 1 }],
    }));
    expect(response.status).toBe(200);
    expect(store.reorderTeamProfiles).toHaveBeenCalledWith(
      "tutor",
      [{ id: "tutor-test", version: 1 }],
      email,
    );
  });
});
