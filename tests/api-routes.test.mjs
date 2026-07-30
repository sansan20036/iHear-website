import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({
  auth: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("../lib/impact-store", () => {
  class ImpactNotFoundError extends Error {}
  class ImpactConflictError extends Error {}
  class ImpactConfigurationError extends Error {}

  return {
    IMPACT_CACHE_TAG: "journey-timeline-v2",
    ImpactNotFoundError,
    ImpactConflictError,
    ImpactConfigurationError,
    createImpactMilestone: vi.fn(),
    deleteImpactMilestone: vi.fn(),
    listAllImpactMilestones: vi.fn(),
    listPublishedImpactMilestones: vi.fn(),
    updateImpactMilestone: vi.fn(),
  };
});

vi.mock("../lib/content-store", () => ({
  readContentStore: vi.fn(),
  updateContentItem: vi.fn(),
}));

import { revalidatePath, revalidateTag } from "next/cache";

import { auth } from "../auth.js";
import { POST as clearStaleAuth } from "../app/api/auth/clear-stale/route";
import { GET as getContent } from "../app/api/content/get/route";
import { POST as updateContent } from "../app/api/content/update/route";
import {
  GET as getMilestones,
  POST as createMilestone,
} from "../app/api/impact-milestones/route";
import {
  DELETE as deleteMilestone,
  PATCH as updateMilestone,
} from "../app/api/impact-milestones/[id]/route";
import { POST as translateMilestone } from "../app/api/impact-milestones/translate/route";
import * as contentStore from "../lib/content-store";
import * as impactStore from "../lib/impact-store";

const adminEmail = "sansan20036@gmail.com";
const validPayload = {
  kind: "event",
  period: "2026-07",
  volunteers: 0,
  volunteersPlus: false,
  students: 0,
  studentsPlus: false,
  sessions: 0,
  sessionsPlus: false,
  title: {
    zhHant: "測試標題",
    zhHans: "测试标题",
    en: "Test title",
  },
  description: {
    zhHant: "測試說明",
    zhHans: "测试说明",
    en: "Test description",
  },
  status: "published",
  sortOrder: 202607,
};
const storedMilestone = {
  id: "journey-api-test",
  ...validPayload,
  version: 1,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  createdBy: adminEmail,
  updatedBy: adminEmail,
};

function jsonRequest(url, method, body) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeContext(id = storedMilestone.id) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { email: adminEmail, isAdmin: true } });
  impactStore.listPublishedImpactMilestones.mockResolvedValue([storedMilestone]);
  impactStore.listAllImpactMilestones.mockResolvedValue([storedMilestone]);
  impactStore.createImpactMilestone.mockResolvedValue(storedMilestone);
  impactStore.updateImpactMilestone.mockResolvedValue({ ...storedMilestone, version: 2 });
  impactStore.deleteImpactMilestone.mockResolvedValue(storedMilestone.id);
  contentStore.readContentStore.mockResolvedValue({
    version: 1,
    updatedAt: "",
    pages: {},
  });
  contentStore.updateContentItem.mockResolvedValue({
    version: 1,
    updatedAt: "2026-07-28T00:00:00.000Z",
    updatedBy: adminEmail,
    pages: { "/about": { "main>h2:nth-of-type(1)": "更新內容" } },
  });
});

describe("public API caching", () => {
  test("published milestones use shared one-second edge caching", async () => {
    const response = await getMilestones(
      new Request("http://localhost/api/impact-milestones"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, s-maxage=1");
    expect((await response.json()).milestones).toHaveLength(1);
  });

  test("content overrides use shared one-second edge caching", async () => {
    const response = await getContent();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, s-maxage=1");
  });

  test("draft listing is private and never cached", async () => {
    const response = await getMilestones(
      new Request("http://localhost/api/impact-milestones?includeDrafts=true"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
  });
});

describe("authorization", () => {
  test("all protected milestone and content routes reject anonymous requests", async () => {
    auth.mockResolvedValue(null);

    const responses = await Promise.all([
      getMilestones(new Request("http://localhost/api/impact-milestones?includeDrafts=true")),
      createMilestone(jsonRequest("http://localhost/api/impact-milestones", "POST", validPayload)),
      updateMilestone(
        jsonRequest(
          `http://localhost/api/impact-milestones/${storedMilestone.id}`,
          "PATCH",
          { ...validPayload, version: 1 },
        ),
        routeContext(),
      ),
      deleteMilestone(
        jsonRequest(
          `http://localhost/api/impact-milestones/${storedMilestone.id}`,
          "DELETE",
          { version: 1 },
        ),
        routeContext(),
      ),
      updateContent(
        jsonRequest("http://localhost/api/content/update", "POST", {
          page: "/about",
          key: "main>h2:nth-of-type(1)",
          value: "更新內容",
        }),
      ),
      translateMilestone(
        jsonRequest("http://localhost/api/impact-milestones/translate", "POST", {
          sourceLocale: "zhHant",
          title: "測試",
          description: "測試",
        }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(impactStore.createImpactMilestone).not.toHaveBeenCalled();
    expect(impactStore.updateImpactMilestone).not.toHaveBeenCalled();
    expect(impactStore.deleteImpactMilestone).not.toHaveBeenCalled();
    expect(contentStore.updateContentItem).not.toHaveBeenCalled();
  });
});

describe("OAuth cookie cleanup", () => {
  test("expires stale Auth.js cookies at both supported paths", async () => {
    const response = await clearStaleAuth();
    const cookies = response.headers.getSetCookie();

    expect(response.status).toBe(200);
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining("authjs.state=; Path=/;"),
        expect.stringContaining("authjs.state=; Path=/api/auth;"),
        expect.stringContaining("__Secure-authjs.pkce.code_verifier=; Path=/;"),
        expect.stringContaining("__Secure-authjs.pkce.code_verifier=; Path=/api/auth;"),
      ]),
    );
    expect(cookies.filter((cookie) => cookie.startsWith("__Host-authjs.csrf-token="))).toHaveLength(1);
    expect(cookies.find((cookie) => cookie.startsWith("__Host-authjs.csrf-token="))).toContain("Path=/;");
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
  });
});

describe("authorized mutations", () => {
  test("creates a published milestone and invalidates its caches", async () => {
    const response = await createMilestone(
      jsonRequest("http://localhost/api/impact-milestones", "POST", validPayload),
    );

    expect(response.status).toBe(201);
    expect(impactStore.createImpactMilestone).toHaveBeenCalledWith(validPayload, adminEmail);
    expect(revalidateTag).toHaveBeenCalledWith("journey-timeline-v2", { expire: 0 });
    expect(revalidatePath).toHaveBeenCalledWith("/about");
    expect(revalidatePath).toHaveBeenCalledWith("/api/impact-milestones");
  });

  test("returns 409 when an update loses optimistic concurrency", async () => {
    impactStore.updateImpactMilestone.mockRejectedValue(
      new impactStore.ImpactConflictError("version conflict"),
    );

    const response = await updateMilestone(
      jsonRequest(
        `http://localhost/api/impact-milestones/${storedMilestone.id}`,
        "PATCH",
        { ...validPayload, version: 1 },
      ),
      routeContext(),
    );

    expect(response.status).toBe(409);
  });

  test("permanently deletes using the expected version", async () => {
    const response = await deleteMilestone(
      jsonRequest(
        `http://localhost/api/impact-milestones/${storedMilestone.id}`,
        "DELETE",
        { version: 1 },
      ),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(impactStore.deleteImpactMilestone).toHaveBeenCalledWith(storedMilestone.id, 1);
    expect(revalidateTag).toHaveBeenCalledWith("journey-timeline-v2", { expire: 0 });
  });

  test("updates inline content and invalidates page and API caches", async () => {
    const response = await updateContent(
      jsonRequest("http://localhost/api/content/update", "POST", {
        page: "/about",
        key: "main>h2:nth-of-type(1)",
        value: "更新內容",
      }),
    );

    expect(response.status).toBe(200);
    expect(contentStore.updateContentItem).toHaveBeenCalledWith({
      page: "/about",
      key: "main>h2:nth-of-type(1)",
      value: "更新內容",
      updatedBy: adminEmail,
    });
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/about");
    expect(revalidatePath).toHaveBeenCalledWith("/api/content/get");
  });

  test("rejects incomplete published translations before persistence", async () => {
    const response = await createMilestone(
      jsonRequest("http://localhost/api/impact-milestones", "POST", {
        ...validPayload,
        title: { ...validPayload.title, en: "" },
      }),
    );

    expect(response.status).toBe(400);
    expect(impactStore.createImpactMilestone).not.toHaveBeenCalled();
  });
});

describe("migration checksums", () => {
  test("uses the same checksum for LF and Windows CRLF files", async () => {
    const { migrationChecksum } = await import("../scripts/migration-checksum.mjs");

    expect(migrationChecksum("SELECT 1;\nSELECT 2;\n")).toBe(
      migrationChecksum("SELECT 1;\r\nSELECT 2;\r\n"),
    );
  });
});
