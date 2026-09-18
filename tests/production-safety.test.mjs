import { describe, expect, it } from "vitest";
import { readOnlyDecision } from "./production/read-only.mjs";

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
    for (const url of ["https://forms.gle/example", `${origin}/submit-bio`, `${origin}/admin`]) {
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
