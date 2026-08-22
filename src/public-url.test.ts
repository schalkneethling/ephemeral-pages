import { describe, expect, it } from "vitest";

import { pagePublicUrl, resolvePublicBaseUrl } from "./public-url.ts";

function requestAt(url: string): Request {
  return new Request(url);
}

describe("public URL helpers", () => {
  it("uses the request origin when no configured URL is given", () => {
    expect(resolvePublicBaseUrl(requestAt("https://example.com/mcp"), undefined)).toBe(
      "https://example.com",
    );
  });

  it("prefers a configured public base URL and strips the path", () => {
    expect(
      resolvePublicBaseUrl(requestAt("https://example.com/mcp"), "https://public.example/path"),
    ).toBe("https://public.example");
  });

  it("rejects invalid, credentialed, and non-http URLs", () => {
    const req = requestAt("https://example.com/mcp");
    expect(resolvePublicBaseUrl(req, "not a URL")).toBeNull();
    expect(resolvePublicBaseUrl(req, "https://user:pass@example.com")).toBeNull();
    expect(resolvePublicBaseUrl(req, "ftp://example.com")).toBeNull();
  });

  it("builds a public /p/:id URL from the origin", () => {
    expect(pagePublicUrl("page-1", "https://example.com")).toBe("https://example.com/p/page-1");
  });
});
