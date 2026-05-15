import { describe, expect, it, vi } from "vitest";

import { cleanupExpiredPages, cleanupExpiredRateLimits } from "../netlify/functions/cleanup.ts";
import { validateServerHtml } from "../netlify/functions/html-validation.ts";
import {
  createPage,
  createReport,
  deletePage,
  getPageContent,
  getPageMetadata,
} from "../netlify/functions/pages.ts";
import type { PageStore } from "../netlify/functions/storage.ts";
import {
  buildAppShellCsp,
  buildUploadedPageHttpCsp,
  buildUploadedPageCsp,
  injectCsp,
} from "./csp.ts";
import {
  ALLOWED_EXPIRATIONS,
  DEFAULT_HOURS,
  MAX_HOURS,
  MIN_HOURS,
  expirationDayKey,
  expirationIndexKey,
  mapUnavailableStatus,
  pageHtmlKey,
  pageMetadataKey,
  type PageMetadata,
  validateExpirationHours,
} from "./domain.ts";
import { matchAdminRoute, matchApiRoute, matchViewRoute } from "./routes.ts";
import { formatExpiryText, supportsTemporal } from "./ttl.ts";

describe("page policy", () => {
  it("keeps the agreed expiration bounds and default", () => {
    expect(MIN_HOURS).toBe(1);
    expect(DEFAULT_HOURS).toBe(12);
    expect(MAX_HOURS).toBe(168);
    expect(ALLOWED_EXPIRATIONS.find((option) => option.default)?.hours).toBe(12);
    expect(ALLOWED_EXPIRATIONS.map((option) => option.hours)).toEqual([
      1, 3, 5, 7, 12, 24, 72, 120, 168,
    ]);
  });

  it("validates only allowed whole-hour expiration options", () => {
    expect(validateExpirationHours(undefined)).toMatchObject({ ok: true, value: 12 });
    expect(validateExpirationHours(1)).toMatchObject({ ok: true, value: 1 });
    expect(validateExpirationHours(168)).toMatchObject({ ok: true, value: 168 });
    expect(validateExpirationHours(2)).toMatchObject({
      ok: false,
      error: "Expiration must use one of the allowed options",
    });
    expect(validateExpirationHours(0)).toMatchObject({
      ok: false,
      error: "Expiration must be at least 1 hour(s)",
    });
    expect(validateExpirationHours(169)).toMatchObject({
      ok: false,
      error: "Expiration cannot exceed 7 days",
    });
    expect(validateExpirationHours(Number.NaN)).toMatchObject({
      ok: false,
      error: "Invalid expiration value",
    });
  });

  it("validates server HTML with parse5 source nodes", () => {
    expect(validateServerHtml("<!doctype html><title>Hello</title><p>Hello</p>")).toMatchObject({
      ok: false,
      error: "The uploaded file must include a source-authored <html> or <head> element.",
    });
    expect(validateServerHtml("<html><body>Hello</body></html>")).toMatchObject({ ok: true });
    expect(validateServerHtml("<head><title>Hello</title></head><p>Hello</p>")).toMatchObject({
      ok: true,
    });
    expect(validateServerHtml("<p>Hello</p>")).toMatchObject({
      ok: false,
      error: "The uploaded file must include a source-authored <html> or <head> element.",
    });
    expect(validateServerHtml("this mentions <script but is not markup")).toMatchObject({
      ok: false,
      error: "The uploaded file must include a source-authored <html> or <head> element.",
    });
    expect(validateServerHtml("<p")).toMatchObject({
      ok: false,
      error: "The uploaded file must include a source-authored <html> or <head> element.",
    });
    expect(validateServerHtml("plain text")).toMatchObject({
      ok: false,
      error: "The uploaded file must include a source-authored <html> or <head> element.",
    });
    expect(validateServerHtml("")).toMatchObject({
      ok: false,
      error: "HTML content is required",
    });
  });

  it("builds storage keys consistently", () => {
    const expiresAt = new Date("2026-05-13T12:00:00Z");
    expect(pageHtmlKey("abc")).toBe("pages/abc/index.html");
    expect(pageMetadataKey("abc")).toBe("pages/abc/meta.json");
    expect(expirationDayKey(expiresAt)).toBe("expires/2026-05-13");
    expect(expirationIndexKey("abc", expiresAt)).toBe("expires/2026-05-13/abc.json");
  });
});

describe("routing", () => {
  it("matches API routes with URLPattern", () => {
    expect(matchApiRoute(new Request("https://example.com/api/pages", { method: "POST" }))).toEqual(
      {
        name: "create-page",
      },
    );
    expect(
      matchApiRoute(new Request("https://example.com/api/reports", { method: "POST" })),
    ).toEqual({
      name: "create-report",
    });
    expect(matchApiRoute(new Request("https://example.com/api/pages/page-1"))).toEqual({
      name: "get-page",
      id: "page-1",
    });
    expect(matchApiRoute(new Request("https://example.com/api/pages/page-1/content"))).toEqual({
      name: "get-page-content",
      id: "page-1",
    });
    expect(
      matchApiRoute(
        new Request("https://example.com/api/admin/pages/page-1", { method: "DELETE" }),
      ),
    ).toEqual({
      name: "delete-page",
      id: "page-1",
    });
    expect(
      matchApiRoute(new Request("https://example.com/api/pages/page-1", { method: "POST" })),
    ).toBe(null);
  });

  it("matches the admin route", () => {
    expect(matchAdminRoute("/admin")).toBe(true);
    expect(matchAdminRoute("/admin/delete")).toBe(false);
  });

  it("matches the public page route with URLPattern", () => {
    expect(matchViewRoute("/p/page-1")).toEqual({ id: "page-1" });
    expect(matchViewRoute("/pages/page-1")).toBe(null);
  });
});

describe("uploaded page CSP", () => {
  it("allows inline scripts/styles and trusted CDNs only", () => {
    const csp = buildUploadedPageCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).toContain("https://unpkg.com");
    expect(csp).toContain("https://cdnjs.cloudflare.com");
    expect(csp).toContain(
      "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    );
    expect(csp).toContain("font-src https://fonts.gstatic.com");
    expect(csp).not.toContain(
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    );
    expect(csp).not.toContain("connect-src");
    expect(csp).not.toMatch(/(^| )https:(;| |$)/);
  });

  it("builds HTTP sandbox CSP for direct uploaded content responses", () => {
    const csp = buildUploadedPageHttpCsp();
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("builds a tight app shell CSP", () => {
    const csp = buildAppShellCsp();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("injects CSP into documents and fragments", () => {
    expect(injectCsp("<html><head><title>x</title></head><body></body></html>")).toContain(
      '<head>\n  <meta http-equiv="Content-Security-Policy"',
    );
    expect(injectCsp("<html><body></body></html>")).toContain("<head>");
    expect(() => injectCsp("<div>Hello</div>")).toThrow(
      "Cannot inject CSP into HTML without an <html> or <head> element.",
    );
  });
});

describe("unavailable state mapping", () => {
  it("maps only 404 and 410 to page unavailable states", () => {
    expect(mapUnavailableStatus(404)).toBe("not-found");
    expect(mapUnavailableStatus(410)).toBe("expired");
    expect(mapUnavailableStatus(500)).toBe(null);
  });
});

describe("expiry copy", () => {
  const temporal = {
    Instant: {
      from(value: string) {
        return { epochMilliseconds: new Date(value).getTime() };
      },
    },
  };

  it("uses Temporal for coarse relative expiry text when available", () => {
    const now = new Date("2026-05-14T08:00:00.000Z");

    expect(formatExpiryText("2026-05-14T08:20:00.000Z", now, temporal)).toBe("expires in 20m");
    expect(formatExpiryText("2026-05-14T20:00:00.000Z", now, temporal)).toBe("expires in 12h");
    expect(formatExpiryText("2026-05-17T08:00:00.000Z", now, temporal)).toBe("expires in 3d");
  });

  it("shows expired when the Temporal-backed timer reaches zero", () => {
    expect(
      formatExpiryText("2026-05-14T08:00:00.000Z", new Date("2026-05-14T08:00:00.000Z"), temporal),
    ).toBe("expired");
  });

  it("falls back to localized absolute expiry text without Temporal", () => {
    expect(
      formatExpiryText("2026-05-14T20:00:00.000Z", new Date("2026-05-14T08:00:00.000Z"), undefined),
    ).toContain("expires ");
  });

  it("detects Temporal support without requiring a polyfill", () => {
    expect(supportsTemporal(temporal)).toBe(true);
    expect(supportsTemporal(undefined)).toBe(false);
  });
});

describe("page handlers", () => {
  it("creates a page and stores HTML, metadata, and the expiration index", async () => {
    const store = createMemoryStore();

    const response = await createPage(
      jsonRequest({ html: "<html><body>Hello</body></html>" }),
      store,
    );
    const body = (await response.json()) as { id: string; url: string; expiresAt: string };

    expect(response.status).toBe(201);
    expect(body.url).toBe(`/p/${body.id}`);
    expect(await store.getHtml(body.id)).toBe("<html><body>Hello</body></html>");
    expect(await store.getMetadata(body.id)).toMatchObject({
      id: body.id,
      expiresAt: body.expiresAt,
    });
    expect(await store.listExpirationEntries(expirationDayKey(new Date(body.expiresAt)))).toContain(
      expirationIndexKey(body.id, new Date(body.expiresAt)),
    );
  });

  it("rejects invalid create payloads", async () => {
    const store = createMemoryStore();

    const wrongContentType = await createPage(
      new Request("https://example.com/api/pages", {
        method: "POST",
        body: JSON.stringify({ html: "<html></html>" }),
      }),
      store,
    );
    const plainText = await createPage(jsonRequest({ html: "hello" }), store);

    expect(wrongContentType.status).toBe(415);
    expect(plainText.status).toBe(400);
  });

  it("returns metadata and content for active pages", async () => {
    const store = createMemoryStore();
    const metadata = await store.seed("<html><body>Active</body></html>", {
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const metaResponse = await getPageMetadata(metadata.id, store);
    const contentResponse = await getPageContent(metadata.id, store);

    expect(metaResponse.status).toBe(200);
    expect(contentResponse.status).toBe(200);
    expect(await contentResponse.text()).toBe("<html><body>Active</body></html>");
    expect(contentResponse.headers.get("Content-Security-Policy")).toBe(buildUploadedPageHttpCsp());
    expect(contentResponse.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does not expose wildcard CORS headers", async () => {
    const store = createMemoryStore();

    const response = await createPage(
      jsonRequest({ html: "<html><body>Hello</body></html>" }),
      store,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(null);
  });

  it("returns gone for expired pages before cleanup hard-deletes them", async () => {
    const store = createMemoryStore();
    const metadata = await store.seed("<html><body>Expired</body></html>", {
      expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    expect((await getPageMetadata(metadata.id, store)).status).toBe(410);
    expect((await getPageContent(metadata.id, store)).status).toBe(410);
  });

  it("protects admin hard deletes with a bearer token", async () => {
    const store = createMemoryStore();
    const metadata = await store.seed("<html><body>Reported</body></html>", {
      id: "reported",
    });

    const missingToken = await deletePage(
      new Request("https://example.com/api/admin/pages/reported", { method: "DELETE" }),
      metadata.id,
      store,
      "secret-token",
    );
    const wrongToken = await deletePage(
      new Request("https://example.com/api/admin/pages/reported", {
        method: "DELETE",
        headers: { Authorization: "Bearer wrong-token" },
      }),
      metadata.id,
      store,
      "secret-token",
    );

    expect(missingToken.status).toBe(401);
    expect(wrongToken.status).toBe(403);
    expect(await store.getHtml(metadata.id)).toBe("<html><body>Reported</body></html>");
  });

  it("rate-limits repeated failed admin deletes", async () => {
    const store = createMemoryStore();
    await store.seed("<html><body>Reported</body></html>", { id: "reported" });
    const request = () =>
      new Request("https://example.com/api/admin/pages/reported", {
        method: "DELETE",
        headers: {
          Authorization: "Bearer wrong-token",
          "x-nf-client-connection-ip": "203.0.113.10",
        },
      });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await deletePage(request(), "reported", store, "secret-token")).status).toBe(403);
    }

    expect((await deletePage(request(), "reported", store, "secret-token")).status).toBe(429);
  });

  it("hard-deletes page resources with the admin token", async () => {
    const store = createMemoryStore();
    const metadata = await store.seed("<html><body>Reported</body></html>", {
      id: "reported",
      expiresAt: "2026-05-15T08:00:00.000Z",
    });

    const response = await deletePage(
      new Request("https://example.com/api/admin/pages/reported", {
        method: "DELETE",
        headers: { Authorization: "Bearer secret-token" },
      }),
      metadata.id,
      store,
      "secret-token",
    );

    expect(response.status).toBe(200);
    expect(await store.getHtml(metadata.id)).toBe(null);
    expect(await store.getMetadata(metadata.id)).toBe(null);
    expect(
      await store.listExpirationEntries(expirationDayKey(new Date(metadata.expiresAt))),
    ).not.toContain(expirationIndexKey(metadata.id, new Date(metadata.expiresAt)));
  });

  it("accepts same-origin abuse reports and rejects cross-origin reports", async () => {
    const store = createMemoryStore();
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetch);

    try {
      const sameOrigin = await createReport(
        jsonRequest(
          { pageId: "reported", flaggedUrl: "https://example.com/p/reported" },
          "https://example.com/api/reports",
        ),
        store,
      );
      const crossOrigin = await createReport(
        jsonRequest(
          { pageId: "reported", flaggedUrl: "https://attacker.test/p/reported" },
          "https://example.com/api/reports",
        ),
        store,
      );

      expect(sameOrigin.status).toBe(200);
      expect(crossOrigin.status).toBe(400);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rate-limits page uploads", async () => {
    const store = createMemoryStore();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        (await createPage(jsonRequest({ html: "<html><body>Hello</body></html>" }), store)).status,
      ).toBe(201);
    }

    expect(
      (await createPage(jsonRequest({ html: "<html><body>Hello</body></html>" }), store)).status,
    ).toBe(429);
  });
});

describe("cleanup", () => {
  it("hard-deletes expired content, metadata, and index entries", async () => {
    const store = createMemoryStore();
    const expired = await store.seed("<html><body>Expired</body></html>", {
      id: "expired",
      expiresAt: "2026-05-13T09:00:00.000Z",
    });
    const active = await store.seed("<html><body>Active</body></html>", {
      id: "active",
      expiresAt: "2026-05-13T11:00:00.000Z",
    });

    const deleted = await cleanupExpiredPages(store, new Date("2026-05-13T10:00:00.000Z"));

    expect(deleted).toBe(1);
    expect(await store.getHtml(expired.id)).toBe(null);
    expect(await store.getMetadata(expired.id)).toBe(null);
    expect(await store.getHtml(active.id)).toBe("<html><body>Active</body></html>");
  });

  it("is idempotent for already-deleted or partial records", async () => {
    const store = createMemoryStore();
    await store.addExpirationEntry("expires/2026-05-13/missing.json", { id: "missing" });

    expect(await cleanupExpiredPages(store, new Date("2026-05-14T00:00:00.000Z"))).toBe(1);
    expect(await cleanupExpiredPages(store, new Date("2026-05-14T00:00:00.000Z"))).toBe(0);
  });

  it("hard-deletes expired rate-limit records", async () => {
    const store = createMemoryStore();
    const expiredKey = "rate-limits/upload/actor/expired.json";
    const activeKey = "rate-limits/upload/actor/active.json";

    await store.addRateLimitEntry(expiredKey, { count: 10, resetAt: 1_778_671_999_999 });
    await store.addRateLimitEntry(activeKey, { count: 1, resetAt: 1_778_672_600_000 });

    expect(await cleanupExpiredRateLimits(store, 1_778_672_000_000)).toBe(1);
    expect(await store.getRateLimit(expiredKey)).toBe(null);
    expect(await store.getRateLimit(activeKey)).toEqual({ count: 1, resetAt: 1_778_672_600_000 });
  });

  it("hard-deletes malformed rate-limit records", async () => {
    const store = createMemoryStore();
    const malformedKey = "rate-limits/upload/actor/malformed.json";

    await store.addRawEntry(malformedKey, "{");

    expect(await cleanupExpiredRateLimits(store, 1_778_672_000_000)).toBe(1);
    expect(await store.getRateLimit(malformedKey)).toBe(null);
  });
});

function jsonRequest(body: unknown, url = "https://example.com/api/pages"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-nf-client-connection-ip": "203.0.113.1" },
    body: JSON.stringify(body),
  });
}

function createMemoryStore(): PageStore & {
  seed(html: string, overrides?: Partial<PageMetadata>): Promise<PageMetadata>;
  addExpirationEntry(key: string, value: { id: string }): Promise<void>;
  addRateLimitEntry(key: string, value: { count: number; resetAt: number }): Promise<void>;
  addRawEntry(key: string, value: string): Promise<void>;
} {
  const values = new Map<string, string>();

  return {
    async savePage(html, metadata) {
      values.set(pageHtmlKey(metadata.id), html);
      values.set(pageMetadataKey(metadata.id), JSON.stringify(metadata));
      values.set(
        expirationIndexKey(metadata.id, new Date(metadata.expiresAt)),
        JSON.stringify({ id: metadata.id }),
      );
    },
    async getMetadata(id) {
      return readJson<PageMetadata>(values.get(pageMetadataKey(id)));
    },
    async getHtml(id) {
      return values.get(pageHtmlKey(id)) ?? null;
    },
    async deletePage(id, expiresAt) {
      values.delete(pageHtmlKey(id));
      values.delete(pageMetadataKey(id));
      if (expiresAt) values.delete(expirationIndexKey(id, new Date(expiresAt)));
    },
    async getRateLimit(key) {
      return readJson(values.get(key));
    },
    async setRateLimit(key, record) {
      values.set(key, JSON.stringify(record));
    },
    async deleteRateLimit(key) {
      values.delete(key);
    },
    async listRateLimitEntries() {
      return [...values.keys()].filter((key) => key.startsWith("rate-limits/"));
    },
    async listExpirationDirectories() {
      return [
        ...new Set(
          [...values.keys()]
            .filter((key) => key.startsWith("expires/"))
            .map((key) => key.split("/").slice(0, 2).join("/")),
        ),
      ];
    },
    async listExpirationEntries(dayKey) {
      return [...values.keys()].filter((key) => key.startsWith(`${dayKey}/`));
    },
    async getExpirationEntry(key) {
      return readJson<{ id: string }>(values.get(key));
    },
    async deleteExpirationEntry(key) {
      values.delete(key);
    },
    async seed(html, overrides = {}) {
      const metadata: PageMetadata = {
        id: overrides.id ?? crypto.randomUUID(),
        createdAt: overrides.createdAt ?? new Date("2026-05-13T08:00:00.000Z").toISOString(),
        expiresAt: overrides.expiresAt ?? new Date("2026-05-14T08:00:00.000Z").toISOString(),
        sizeBytes: overrides.sizeBytes ?? html.length,
      };
      await this.savePage(html, metadata);
      return metadata;
    },
    async addExpirationEntry(key, value) {
      values.set(key, JSON.stringify(value));
    },
    async addRateLimitEntry(key, value) {
      values.set(key, JSON.stringify(value));
    },
    async addRawEntry(key, value) {
      values.set(key, value);
    },
  };
}

function readJson<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
