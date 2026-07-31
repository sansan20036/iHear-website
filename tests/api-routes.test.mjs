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
  class ImpactDuplicatePeriodError extends Error {
    constructor() {
      super("A published impact metric already exists for this month");
      this.issues = { period: "這個月份已有一筆已發布成果" };
    }
  }
  class ImpactConfigurationError extends Error {}

  return {
    IMPACT_CACHE_TAG: "journey-timeline-v2",
    ImpactNotFoundError,
    ImpactConflictError,
    ImpactDuplicatePeriodError,
    ImpactConfigurationError,
    createImpactMilestone: vi.fn(),
    deleteImpactMilestone: vi.fn(),
    getCurrentSiteMetrics: vi.fn(),
    listAllImpactMilestones: vi.fn(),
    listPublishedImpactMilestones: vi.fn(),
    updateImpactMilestone: vi.fn(),
  };
});

vi.mock("../lib/content-store", () => {
  class ContentConflictError extends Error {}
  return {
    ContentConflictError,
    publicContentStore: vi.fn((store) => {
      const content = { ...store };
      delete content.updatedBy;
      return content;
    }),
    readContentStore: vi.fn(),
    updateContentItem: vi.fn(),
  };
});

vi.mock("../lib/live-revisions", () => ({
  getLiveRevisions: vi.fn(),
  revisionAfterMutation: vi.fn(),
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
import { GET as getSiteMetrics } from "../app/api/site-metrics/route";
import { GET as getLiveRevisionApi } from "../app/api/live-revisions/route";
import * as contentStore from "../lib/content-store";
import * as impactStore from "../lib/impact-store";
import * as liveRevisions from "../lib/live-revisions";

const adminEmail = "sansan20036@gmail.com";
const nonAdminEmail = "signed-in-visitor@example.com";
const validPayload = {
  kind: "event",
  period: "2026-07",
  volunteers: 0,
  volunteersPlus: false,
  students: 0,
  studentsPlus: false,
  sessions: 0,
  sessionsPlus: false,
  countries: 0,
  countryNames: {
    zhHant: "",
    zhHans: "",
    en: "",
  },
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
const currentMetrics = {
  ...storedMilestone,
  id: "impact-2026-06",
  kind: "metrics",
  period: "2026-06",
  volunteers: 35,
  volunteersPlus: true,
  students: 50,
  studentsPlus: true,
  sessions: 1200,
  sessionsPlus: true,
  countries: 4,
  countryNames: {
    zhHant: "臺灣 · 中國 · 美國 · 加拿大",
    zhHans: "台湾 · 中国 · 美国 · 加拿大",
    en: "Taiwan · China · United States · Canada",
  },
  title: { zhHant: "", zhHans: "", en: "" },
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
  impactStore.getCurrentSiteMetrics.mockResolvedValue(currentMetrics);
  impactStore.listAllImpactMilestones.mockResolvedValue([storedMilestone]);
  impactStore.createImpactMilestone.mockResolvedValue(storedMilestone);
  impactStore.updateImpactMilestone.mockResolvedValue({ ...storedMilestone, version: 2 });
  impactStore.deleteImpactMilestone.mockResolvedValue(storedMilestone.id);
  contentStore.readContentStore.mockResolvedValue({
    version: 2,
    updatedAt: "",
    updatedBy: adminEmail,
    pages: {},
    itemUpdatedAt: {},
  });
  contentStore.updateContentItem.mockResolvedValue({
    version: 2,
    updatedAt: "2026-07-28T00:00:00.000Z",
    updatedBy: adminEmail,
    pages: { "/about": { "main>h2:nth-of-type(1)": "更新內容" } },
    itemUpdatedAt: { "/about": { "main>h2:nth-of-type(1)": "2026-07-28T00:00:00.000Z" } },
  });
  liveRevisions.revisionAfterMutation.mockResolvedValue({
    revision: "2",
    updatedAt: "2026-07-28T00:00:00.000Z",
  });
  liveRevisions.getLiveRevisions.mockResolvedValue({
    content: { revision: "2", updatedAt: "2026-07-28T00:00:00.000Z" },
    impact: { revision: "3", updatedAt: "2026-07-28T00:00:00.000Z" },
    team: { revision: "4", updatedAt: "2026-07-28T00:00:00.000Z" },
  });
});

describe("public API caching", () => {
  test("live revisions expose only public version metadata", async () => {
    const response = await getLiveRevisionApi();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=3");
    expect(body).toEqual({
      version: 1,
      revisions: {
        content: { revision: "2", updatedAt: "2026-07-28T00:00:00.000Z" },
        impact: { revision: "3", updatedAt: "2026-07-28T00:00:00.000Z" },
        team: { revision: "4", updatedAt: "2026-07-28T00:00:00.000Z" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("@");
  });

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
    const body = await response.json();
    expect(body.updatedBy).toBeUndefined();
    expect(body.version).toBe(2);
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

  test("all protected milestone and content routes reject signed-in non-admin users", async () => {
    auth.mockResolvedValue({
      user: { email: nonAdminEmail, isAdmin: true },
    });

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
          value: "不應寫入",
          expectedUpdatedAt: null,
        }),
      ),
      translateMilestone(
        jsonRequest("http://localhost/api/impact-milestones/translate", "POST", {
          sourceLocale: "zhHant",
          title: "不應翻譯",
          description: "不應翻譯",
        }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(impactStore.listAllImpactMilestones).not.toHaveBeenCalled();
    expect(impactStore.createImpactMilestone).not.toHaveBeenCalled();
    expect(impactStore.updateImpactMilestone).not.toHaveBeenCalled();
    expect(impactStore.deleteImpactMilestone).not.toHaveBeenCalled();
    expect(contentStore.updateContentItem).not.toHaveBeenCalled();
    expect(liveRevisions.revisionAfterMutation).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
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

  test("current site metrics use shared one-second edge caching", async () => {
    const response = await getSiteMetrics();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, s-maxage=1");
    expect((await response.json()).metrics).toMatchObject({
      id: "impact-2026-06",
      countries: 4,
    });
  });

  test("current site metrics return null when no published metrics exist", async () => {
    impactStore.getCurrentSiteMetrics.mockResolvedValue(null);

    const response = await getSiteMetrics();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ metrics: null });
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
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(revalidatePath).toHaveBeenCalledWith("/api/impact-milestones");
    expect(revalidatePath).toHaveBeenCalledWith("/api/site-metrics");
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
        expectedUpdatedAt: null,
      }),
    );

    expect(response.status).toBe(200);
    expect(contentStore.updateContentItem).toHaveBeenCalledWith({
      page: "/about",
      key: "main>h2:nth-of-type(1)",
      value: "更新內容",
      expectedUpdatedAt: null,
      updatedBy: adminEmail,
    });
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/about");
    expect(revalidatePath).toHaveBeenCalledWith("/api/content/get");
    expect(revalidatePath).toHaveBeenCalledWith("/api/live-revisions");
    expect((await response.json()).content.updatedBy).toBeUndefined();
  });

  test("requires an inline content precondition", async () => {
    const response = await updateContent(
      jsonRequest("http://localhost/api/content/update", "POST", {
        page: "/about",
        key: "main>h2:nth-of-type(1)",
        value: "更新內容",
      }),
    );

    expect(response.status).toBe(428);
    expect(contentStore.updateContentItem).not.toHaveBeenCalled();
  });

  test("returns 409 when inline content loses optimistic concurrency", async () => {
    contentStore.updateContentItem.mockRejectedValue(new contentStore.ContentConflictError());
    const response = await updateContent(
      jsonRequest("http://localhost/api/content/update", "POST", {
        page: "/about",
        key: "main>h2:nth-of-type(1)",
        value: "更新內容",
        expectedUpdatedAt: "2026-07-28T00:00:00.000Z",
      }),
    );

    expect(response.status).toBe(409);
  });

  test("returns a period field issue for duplicate published metrics", async () => {
    impactStore.createImpactMilestone.mockRejectedValue(
      new impactStore.ImpactDuplicatePeriodError(),
    );
    const payload = {
      ...currentMetrics,
      id: undefined,
      version: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      createdBy: undefined,
      updatedBy: undefined,
      status: "published",
      sortOrder: 202606,
    };

    const response = await createMilestone(
      jsonRequest("http://localhost/api/impact-milestones", "POST", payload),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).issues).toEqual({
      period: "這個月份已有一筆已發布成果",
    });
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

  test("rejects published metrics without complete country data", async () => {
    const response = await createMilestone(
      jsonRequest("http://localhost/api/impact-milestones", "POST", {
        ...currentMetrics,
        countries: 0,
        countryNames: { zhHant: "", zhHans: "", en: "" },
        status: "published",
        sortOrder: 202606,
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
