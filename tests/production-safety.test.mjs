import { describe, expect, it } from "vitest";
import { readOnlyDecision } from "./production/read-only.mjs";
import { assertResourceRendering } from "./production/resource-rendering.mjs";

describe("production inspection read-only boundary", () => {
  const origin = "https://www.ihearus.org";
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("blocks %s before it reaches any server", method => {
    for (const url of [`${origin}/api/resources`, "https://forms.gle/example"]) {
      expect(readOnlyDecision({ url, method })).toBe("non-read-method");
    }
  });
  it.each(["/api/admin/resources", "/api/auth/signout", "/api/auth/callback/google", "/api/resources?admin=1", "/admin/resources"])("blocks administrative GET %s", path => {
    expect(readOnlyDecision({ url: `${origin}${path}`, method: "GET" })).not.toBeNull();
  });
  it("allows only approved public page navigation", () => {
    expect(readOnlyDecision({ url: `${origin}/team`, method: "GET", navigation: true })).toBeNull();
    for (const url of ["https://forms.gle/example", `${origin}/internal`, `${origin}/admin`]) {
      expect(readOnlyDecision({ url, method: "GET", navigation: true })).toBe("non-public-navigation");
    }
  });
  it("allows public data and HTTPS image reads, but rejects credentials and HTTP", () => {
    for (const url of [`${origin}/api/resources`, `${origin}/api/site-media/home.hero/image?v=123`, `${origin}/assets/site.css`, "https://i.ytimg.com/vi/example/hqdefault.jpg"]) {
      expect(readOnlyDecision({ url, method: "GET" })).toBeNull();
    }
    for (const url of ["http://www.ihearus.org/", "https://user:password@www.ihearus.org/"]) {
      expect(readOnlyDecision({ url, method: "GET" })).toBe("unsafe-url");
    }
  });
});

function resourcesFixture(locale = "en") {
  const title = { en: "Guide & ? # % 😀", zhHant: "指南 & ? # % 😀", zhHans: "指南 & ? # % 😀" };
  const data = {
    guidesTakeover: "complete",
    topics: [{ id: "guides", sortOrder: 1 }],
    items: [
      { id: "external", topicId: "guides", type: "external_link", sortOrder: 1, title: { en: "Form" }, description: { en: "English fallback" }, url: "https://example.org/form?x=1&y=2" },
      { id: "email", topicId: "guides", type: "email_request", sortOrder: 2, title, description: { en: "" }, url: "" },
      { id: "text", topicId: "guides", type: "text", sortOrder: 3, title: { en: "Notice" }, description: { en: "No destination required" }, url: "" },
    ],
  };
  const subject = (locale === "en" ? "Resource guide request: " : "索取指南：") + title[locale];
  const rendered = {
    topicIds: ["guides"], legacyGuides: 0,
    rows: [
      { id: "external", topicId: "guides", type: "external_link", title: "Form ↗ (opens in a new tab)", description: "English fallback", links: [{ href: data.items[0].url, target: "_blank", rel: "noopener noreferrer" }] },
      { id: "email", topicId: "guides", type: "email_request", title: title[locale], description: "", links: [{ href: "mailto:ihearprogram@gmail.com?subject=" + encodeURIComponent(subject), target: "", rel: "" }] },
      { id: "text", topicId: "guides", type: "text", title: "Notice", description: "No destination required", links: [] },
    ],
  };
  return { data, rendered };
}

describe("production Resources inspection matches the typed CMS contract", () => {
  it.each(["en", "zhHant", "zhHans"])("accepts mixed types, empty email/text URLs and localized/fallback text in %s", locale => {
    const { data, rendered } = resourcesFixture(locale);
    expect(() => assertResourceRendering(data, rendered, locale)).not.toThrow();
  });
  it.each([
    ["missing text item", (_data, rendered) => rendered.rows.pop()],
    ["duplicate item", (_data, rendered) => rendered.rows.push(rendered.rows[0])],
    ["duplicate legacy Guides", (_data, rendered) => { rendered.legacyGuides = 1; }],
    ["unexpected item type", (data, rendered) => { data.items[2].type = rendered.rows[2].type = "video"; }],
    ["unpublished data", data => { data.topics[0].status = "draft"; }],
    ["wrong parent", (_data, rendered) => { rendered.rows[1].topicId = "private"; }],
    ["wrong ordering", (_data, rendered) => rendered.rows.reverse()],
    ["link on text item", (_data, rendered) => { rendered.rows[2].links = rendered.rows[0].links; }],
    ["insecure external URL", (data, rendered) => { data.items[0].url = rendered.rows[0].links[0].href = "http://example.org/"; }],
    ["wrong external destination", (_data, rendered) => { rendered.rows[0].links[0].href = "https://example.org/wrong"; }],
    ["missing external protection", (_data, rendered) => { rendered.rows[0].links[0].rel = ""; }],
    ["wrong email recipient", (_data, rendered) => { rendered.rows[1].links[0].href = rendered.rows[1].links[0].href.replace("ihearprogram@gmail.com", "wrong@example.org"); }],
    ["double-encoded subject", (_data, rendered) => { const link = rendered.rows[1].links[0]; link.href = link.href.replace(/(?<=subject=).+/, encodeURIComponent); }],
  ])("rejects %s instead of weakening the production check", (_name, mutate) => {
    const { data, rendered } = resourcesFixture();
    mutate(data, rendered);
    expect(() => assertResourceRendering(data, rendered)).toThrow();
  });
});
