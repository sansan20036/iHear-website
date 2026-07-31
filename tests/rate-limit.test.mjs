import { describe, expect, test } from "vitest";

import {
  clientIp,
  hashRateLimitIdentifier,
  rateLimitExceededResponse,
  withRateLimitHeaders,
} from "../lib/rate-limit";

describe("rate-limit privacy and responses", () => {
  test("uses Vercel's trusted forwarding header before generic proxy headers", () => {
    const request = new Request("http://localhost/api/example", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.10",
        "x-forwarded-for": "198.51.100.20, 198.51.100.21",
        "x-real-ip": "192.0.2.30",
      },
    });

    expect(clientIp(request)).toBe("203.0.113.10");
  });

  test("stores a stable HMAC digest without exposing the identifier", () => {
    const email = "Signed-In-Admin@example.com";
    const first = hashRateLimitIdentifier("admin-mutation", email, "test-secret");
    const second = hashRateLimitIdentifier("admin-mutation", email.toLowerCase(), "test-secret");
    const otherScope = hashRateLimitIdentifier("translation", email, "test-secret");

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
    expect(first).not.toContain("signed-in-admin");
    expect(otherScope).not.toBe(first);
  });

  test("returns a private 429 response with retry metadata", async () => {
    const response = rateLimitExceededResponse({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfter: 42,
      resetAt: "2026-07-31T12:00:42.000Z",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("ratelimit-limit")).toBe("10");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED", retryAfter: 42 });
  });

  test("adds quota metadata to an allowed response", () => {
    const response = withRateLimitHeaders(new Response(null, { status: 204 }), {
      limited: false,
      result: {
        allowed: true,
        limit: 30,
        remaining: 29,
        retryAfter: 60,
        resetAt: "2026-07-31T12:00:42.000Z",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("ratelimit-limit")).toBe("30");
    expect(response.headers.get("ratelimit-remaining")).toBe("29");
    expect(response.headers.get("ratelimit-reset")).toBeTruthy();
    expect(response.headers.get("retry-after")).toBeNull();
  });
});
