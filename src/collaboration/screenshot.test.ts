import { describe, expect, it } from "vitest";

import { captureFailure, validateScreenshotResponse } from "./screenshot.ts";

const ORIGIN = "https://ephemeral.example";
const PAGE_ID = "page-123";

function screenshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "shot-456",
    pageId: PAGE_ID,
    createdAt: "2026-08-23T10:15:00.000Z",
    expiresAt: "2026-08-23T22:15:00.000Z",
    revision: 7,
    sizeBytes: 42_000,
    url: `/api/pages/${PAGE_ID}/screenshots/shot-456`,
    ...overrides,
  };
}

describe("screenshot browser contract", () => {
  it("accepts a page-bound same-origin download URL", () => {
    expect(validateScreenshotResponse(screenshot(), PAGE_ID, ORIGIN)).toEqual({
      ...screenshot(),
      url: `${ORIGIN}/api/pages/${PAGE_ID}/screenshots/shot-456`,
    });
  });

  it.each([
    ["cross-origin URL", { url: "https://attacker.example/image.png" }],
    ["wrong page URL", { url: "/api/pages/other/screenshots/shot-456" }],
    ["wrong screenshot URL", { url: `/api/pages/${PAGE_ID}/screenshots/other` }],
    ["URL query", { url: `/api/pages/${PAGE_ID}/screenshots/shot-456?token=secret` }],
    ["wrong page response", { pageId: "other" }],
    ["negative revision", { revision: -1 }],
    ["fractional size", { sizeBytes: 1.5 }],
    ["invalid capture time", { createdAt: "not-a-date" }],
    ["non-ISO capture time", { createdAt: "2026-08-23" }],
    ["expiry before capture", { expiresAt: "2026-08-23T09:15:00.000Z" }],
  ])("rejects %s", (_name, overrides) => {
    expect(validateScreenshotResponse(screenshot(overrides), PAGE_ID, ORIGIN)).toBeNull();
  });

  it("maps rate, quota, and expiry failures to accessible copy", () => {
    expect(captureFailure(429, "30")).toEqual({
      message: "Too many screenshot requests. Try again in 30 seconds.",
      terminal: false,
    });
    expect(captureFailure(503, null)).toEqual({
      message: "The daily screenshot quota is exhausted. Try again later.",
      terminal: false,
    });
    expect(captureFailure(410, null)).toEqual({
      message: "This page expired before the screenshot could be captured.",
      terminal: true,
    });
  });
});
