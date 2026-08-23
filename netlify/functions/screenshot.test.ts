import { describe, expect, it, vi } from "vitest";

import { matchApiRoute } from "../../src/routes.ts";
import { createScreenshot, getScreenshot } from "./pages.ts";
import {
  createScreenshotCaptureClient,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_DAILY_BUDGET,
  SCREENSHOT_PAGE_LIFETIME_BYTES,
  SCREENSHOT_PAGE_LIFETIME_COUNT,
  ScreenshotCaptureError,
} from "./screenshot-capture.ts";
import { cleanupExpiredScreenshotBudgets } from "./cleanup.ts";
import { createPageStore } from "./storage.ts";
import type {
  ConditionalWriteResult,
  IdempotencyRecord,
  PageStore,
  RateLimitRecord,
  ScreenshotCaptureLock,
  ScreenshotDailyBudgetRecord,
  ScreenshotStore,
  StoredPageMetadata,
  VersionedRecord,
  WriteCondition,
} from "./storage.ts";
import type { ScreenshotMetadata } from "../../src/domain.ts";

const NOW = new Date("2026-08-23T08:00:00.000Z");
const PAGE_EXPIRY = "2026-08-23T09:00:00.000Z";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).buffer;

describe("screenshot routing and capture client", () => {
  it("matches only the page-scoped screenshot routes", () => {
    expect(
      matchApiRoute(
        new Request("https://example.com/api/pages/page-1/screenshots", { method: "POST" }),
      ),
    ).toEqual({ name: "create-screenshot", id: "page-1" });
    expect(
      matchApiRoute(new Request("https://example.com/api/pages/page-1/screenshots/shot-1")),
    ).toEqual({ name: "get-screenshot", id: "page-1", screenshotId: "shot-1" });
  });

  it("calls a fixed authenticated Worker route and validates its PNG metadata", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const client = createScreenshotCaptureClient({
      serviceUrl: "https://collaboration.example.com/internal",
      serviceToken: "service-secret",
      fetchImpl: async (input, init) => {
        requests.push({ input, init });
        return new Response(PNG, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(PNG.byteLength),
            "X-Ephemeral-Capture-Revision": "7",
            "X-Ephemeral-Captured-At": NOW.toISOString(),
          },
        });
      },
    });

    const result = await client!("page-1", PAGE_EXPIRY, new AbortController().signal);

    expect(result).toMatchObject({ revision: 7, capturedAt: NOW.toISOString() });
    expect((requests[0].input as URL).href).toBe(
      "https://collaboration.example.com/rooms/page-1/captures",
    );
    expect(requests[0].init).toMatchObject({
      method: "POST",
      body: null,
      headers: {
        Authorization: "Bearer service-secret",
        "X-Ephemeral-Page-Expires-At": "1787475600",
      },
    });
  });

  it("rejects invalid and oversized Worker responses", async () => {
    const invalid = createScreenshotCaptureClient({
      serviceUrl: "https://collaboration.example.com",
      serviceToken: "service-secret",
      fetchImpl: async () =>
        new Response("not png", {
          headers: {
            "Content-Type": "text/plain",
            "X-Ephemeral-Capture-Revision": "0",
            "X-Ephemeral-Captured-At": NOW.toISOString(),
          },
        }),
    });
    await expect(
      invalid!("page-1", PAGE_EXPIRY, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "invalid_response" } satisfies Partial<ScreenshotCaptureError>);

    const oversized = createScreenshotCaptureClient({
      serviceUrl: "https://collaboration.example.com",
      serviceToken: "service-secret",
      fetchImpl: async () =>
        new Response(PNG, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(MAX_SCREENSHOT_BYTES + 1),
            "X-Ephemeral-Capture-Revision": "0",
            "X-Ephemeral-Captured-At": NOW.toISOString(),
          },
        }),
    });
    await expect(
      oversized!("page-1", PAGE_EXPIRY, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("screenshot page APIs", () => {
  it("captures a live collaborative page and serves a credential-free PNG download", async () => {
    const store = screenshotStore();
    store.seedPage(true);
    const capture = vi.fn(async () => ({
      png: PNG,
      revision: 12,
      capturedAt: NOW.toISOString(),
    }));

    const response = await createScreenshot(screenshotRequest({}), "page-1", store, {
      capture,
      now: () => NOW,
      createId: () => "shot-1",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "shot-1",
      pageId: "page-1",
      createdAt: NOW.toISOString(),
      expiresAt: PAGE_EXPIRY,
      revision: 12,
      sizeBytes: PNG.byteLength,
      url: "/api/pages/page-1/screenshots/shot-1",
    });
    expect(capture).toHaveBeenCalledWith("page-1", PAGE_EXPIRY, expect.any(AbortSignal));
    expect(store.usageObservedActiveLock).toBe(true);

    const download = await getScreenshot("page-1", "shot-1", store, NOW);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("image/png");
    expect(download.headers.get("Cache-Control")).toBe("no-store");
    expect(download.headers.get("Authorization")).toBe(null);
    expect(await download.arrayBuffer()).toEqual(PNG);
  });

  it("rejects caller URLs, ordinary pages, expired pages, and concurrent captures", async () => {
    const store = screenshotStore();
    store.seedPage(true);
    const capture = vi.fn(async () => ({ png: PNG, revision: 0, capturedAt: NOW.toISOString() }));

    expect(
      (
        await createScreenshot(
          screenshotRequest({ url: "https://attacker.test" }),
          "page-1",
          store,
          { capture, now: () => NOW },
        )
      ).status,
    ).toBe(400);

    store.seedPage(false);
    expect(
      (await createScreenshot(screenshotRequest({}), "page-1", store, { capture, now: () => NOW }))
        .status,
    ).toBe(409);

    store.seedPage(true, "2026-08-23T07:00:00.000Z");
    expect(
      (await createScreenshot(screenshotRequest({}), "page-1", store, { capture, now: () => NOW }))
        .status,
    ).toBe(410);

    store.seedPage(true);
    store.locks.set("page-1", {
      record: { token: "other", expiresAt: NOW.getTime() + 60_000 },
      etag: "active",
    });
    expect(
      (await createScreenshot(screenshotRequest({}), "page-1", store, { capture, now: () => NOW }))
        .status,
    ).toBe(409);
  });

  it("enforces per-page/IP quotas and releases the lock after timeout", async () => {
    const store = screenshotStore();
    store.seedPage(true);
    const capture = async () => ({ png: PNG, revision: 0, capturedAt: NOW.toISOString() });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await createScreenshot(screenshotRequest({}), "page-1", store, {
        capture,
        now: () => NOW,
        createId: () => `shot-${attempt}`,
      });
      expect(response.status).toBe(201);
    }
    expect(
      (
        await createScreenshot(screenshotRequest({}), "page-1", store, {
          capture,
          now: () => NOW,
        })
      ).status,
    ).toBe(429);

    const timeoutStore = screenshotStore();
    timeoutStore.seedPage(true);
    const timeout = await createScreenshot(screenshotRequest({}), "page-1", timeoutStore, {
      capture: () => new Promise(() => {}),
      now: () => NOW,
      createId: () => "timed-out",
      timeoutMs: 5,
    });
    expect(timeout.status).toBe(504);
    expect(timeoutStore.locks.get("page-1")?.record).toEqual({ token: "timed-out", expiresAt: 0 });
  });

  it("enforces the application-wide daily budget with conditional retries", async () => {
    expect(SCREENSHOT_DAILY_BUDGET).toBe(25);
    const store = screenshotStore();
    store.seedPage(true);
    store.budgetWriteConflicts = 1;
    const capture = vi.fn(async () => ({ png: PNG, revision: 0, capturedAt: NOW.toISOString() }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        (
          await createScreenshot(screenshotRequest({}), "page-1", store, {
            capture,
            now: () => NOW,
            createId: () => `budget-${attempt}`,
            dailyBudget: 2,
          })
        ).status,
      ).toBe(201);
    }
    const exhausted = await createScreenshot(screenshotRequest({}), "page-1", store, {
      capture,
      now: () => NOW,
      dailyBudget: 2,
    });

    expect(exhausted.status).toBe(503);
    expect(exhausted.headers.get("Retry-After")).toBe("57600");
    expect(capture).toHaveBeenCalledTimes(2);
    expect([...store.budgets.entries()]).toEqual([
      [
        "screenshot-budgets/2026-08-23.json",
        { record: { count: 2, resetAt: 1787529600000 }, etag: expect.any(String) },
      ],
    ]);
  });

  it("enforces per-page lifetime count and byte ceilings while holding the lock", async () => {
    const countStore = screenshotStore();
    countStore.seedPage(true);
    for (let index = 0; index < SCREENSHOT_PAGE_LIFETIME_COUNT; index += 1) {
      countStore.seedScreenshot("page-1", `existing-${index}`, PNG.byteLength);
    }
    const capture = vi.fn(async () => ({ png: PNG, revision: 0, capturedAt: NOW.toISOString() }));
    expect(
      (
        await createScreenshot(screenshotRequest({}), "page-1", countStore, {
          capture,
          now: () => NOW,
        })
      ).status,
    ).toBe(409);
    expect(capture).not.toHaveBeenCalled();
    expect(countStore.budgets.size).toBe(0);

    const byteStore = screenshotStore();
    byteStore.seedPage(true);
    byteStore.seedScreenshot("page-1", "large", SCREENSHOT_PAGE_LIFETIME_BYTES - 5);
    const projected = await createScreenshot(screenshotRequest({}), "page-1", byteStore, {
      capture,
      now: () => NOW,
    });
    expect(projected.status).toBe(409);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("cleans expired and malformed global budget records without page state", async () => {
    const store = screenshotStore();
    store.budgets.set("screenshot-budgets/expired.json", {
      record: { count: 25, resetAt: NOW.getTime() - 1 },
      etag: "expired",
    });
    store.budgets.set("screenshot-budgets/active.json", {
      record: { count: 2, resetAt: NOW.getTime() + 60_000 },
      etag: "active",
    });
    store.budgets.set("screenshot-budgets/malformed.json", {
      record: { count: -1, resetAt: NOW.getTime() + 60_000 },
      etag: "malformed",
    });

    expect(await cleanupExpiredScreenshotBudgets(store, NOW.getTime())).toBe(2);
    expect([...store.budgets.keys()]).toEqual(["screenshot-budgets/active.json"]);
  });

  it("deletes screenshots and capture locks with their page", async () => {
    const deleted: string[] = [];
    const backingStore = {
      async delete(key: string) {
        deleted.push(key);
      },
      list() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              blobs: [
                { key: "pages/page-1/screenshots/shot-1.png" },
                { key: "pages/page-1/screenshots/shot-1.json" },
                { key: "pages/page-1/screenshots/_capture-lock.json" },
              ],
            };
          },
        };
      },
    };
    const store = createPageStore(backingStore as never);

    await store.deletePage("page-1", PAGE_EXPIRY);

    expect(deleted).toEqual(
      expect.arrayContaining([
        "pages/page-1/index.html",
        "pages/page-1/meta.json",
        "pages/page-1/screenshots/shot-1.png",
        "pages/page-1/screenshots/shot-1.json",
        "pages/page-1/screenshots/_capture-lock.json",
        "expires/2026-08-23/page-1.json",
      ]),
    );
  });
});

function screenshotRequest(body: unknown): Request {
  return new Request("https://example.com/api/pages/page-1/screenshots", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nf-client-connection-ip": "203.0.113.9",
    },
    body: JSON.stringify(body),
  });
}

function screenshotStore(): PageStore &
  ScreenshotStore & {
    locks: Map<string, VersionedRecord<ScreenshotCaptureLock>>;
    budgets: Map<string, VersionedRecord<ScreenshotDailyBudgetRecord>>;
    budgetWriteConflicts: number;
    usageObservedActiveLock: boolean;
    seedPage(collaboration: boolean, expiresAt?: string, pageId?: string): void;
    seedScreenshot(pageId: string, screenshotId: string, sizeBytes: number): void;
  } {
  const pages = new Map<string, StoredPageMetadata>();
  const screenshots = new Map<string, { metadata: ScreenshotMetadata; png: ArrayBuffer }>();
  const locks = new Map<string, VersionedRecord<ScreenshotCaptureLock>>();
  const rates = new Map<string, VersionedRecord<RateLimitRecord>>();
  const idempotency = new Map<string, VersionedRecord<IdempotencyRecord>>();
  const budgets = new Map<string, VersionedRecord<ScreenshotDailyBudgetRecord>>();
  let etag = 0;
  const conditionalWrite = <T>(
    map: Map<string, VersionedRecord<T>>,
    key: string,
    record: T,
    condition: WriteCondition,
  ): ConditionalWriteResult => {
    const existing = map.get(key);
    if ("onlyIfNew" in condition && existing) return { modified: false };
    if ("onlyIfMatch" in condition && existing?.etag !== condition.onlyIfMatch) {
      return { modified: false };
    }
    const next = String(++etag);
    map.set(key, { record, etag: next });
    return { modified: true, etag: next };
  };

  return {
    locks,
    budgets,
    budgetWriteConflicts: 0,
    usageObservedActiveLock: false,
    seedPage(collaboration, expiresAt = PAGE_EXPIRY, pageId = "page-1") {
      pages.set(pageId, {
        id: pageId,
        createdAt: NOW.toISOString(),
        expiresAt,
        sizeBytes: 13,
        ...(collaboration ? { collaboration: { enabled: true, capabilityVersion: "v1" } } : {}),
      });
    },
    seedScreenshot(pageId, screenshotId, sizeBytes) {
      screenshots.set(`${pageId}/${screenshotId}`, {
        png: PNG,
        metadata: {
          id: screenshotId,
          pageId,
          createdAt: NOW.toISOString(),
          expiresAt: PAGE_EXPIRY,
          revision: 0,
          sizeBytes,
        },
      });
    },
    async savePage(_html, metadata) {
      pages.set(metadata.id, metadata);
    },
    async getMetadata(id) {
      return pages.get(id) ?? null;
    },
    async getHtml() {
      return null;
    },
    async deletePage(id) {
      pages.delete(id);
      for (const key of screenshots.keys()) if (key.startsWith(`${id}/`)) screenshots.delete(key);
    },
    async saveScreenshot(png, metadata) {
      screenshots.set(`${metadata.pageId}/${metadata.id}`, { png, metadata });
    },
    async getScreenshotMetadata(pageId, screenshotId) {
      return screenshots.get(`${pageId}/${screenshotId}`)?.metadata ?? null;
    },
    async getScreenshotPng(pageId, screenshotId) {
      return screenshots.get(`${pageId}/${screenshotId}`)?.png ?? null;
    },
    async getScreenshotLock(pageId) {
      return locks.get(pageId) ?? null;
    },
    async setScreenshotLock(pageId, record, condition) {
      return conditionalWrite(locks, pageId, record, condition);
    },
    async getScreenshotUsage(pageId) {
      this.usageObservedActiveLock = (locks.get(pageId)?.record.expiresAt ?? 0) > NOW.getTime();
      const metadata = [...screenshots.values()]
        .map((entry) => entry.metadata)
        .filter((entry) => entry.pageId === pageId);
      return {
        count: metadata.length,
        totalBytes: metadata.reduce((total, entry) => total + entry.sizeBytes, 0),
      };
    },
    async getScreenshotBudget(key) {
      return budgets.get(key) ?? null;
    },
    async setScreenshotBudget(key, record, condition) {
      if (this.budgetWriteConflicts > 0) {
        this.budgetWriteConflicts -= 1;
        return { modified: false };
      }
      return conditionalWrite(budgets, key, record, condition);
    },
    async listScreenshotBudgetEntries() {
      return [...budgets.keys()];
    },
    async deleteScreenshotBudget(key) {
      budgets.delete(key);
    },
    async getRateLimit(key) {
      return rates.get(key) ?? null;
    },
    async setRateLimit(key, record, condition) {
      return conditionalWrite(rates, key, record, condition);
    },
    async deleteRateLimit(key) {
      rates.delete(key);
    },
    async listRateLimitEntries() {
      return [...rates.keys()];
    },
    async getIdempotency(key) {
      return idempotency.get(key) ?? null;
    },
    async setIdempotency(key, record, condition) {
      return conditionalWrite(idempotency, key, record, condition);
    },
    async deleteIdempotency(key) {
      idempotency.delete(key);
    },
    async listIdempotencyEntries() {
      return [...idempotency.keys()];
    },
    async listExpirationDirectories() {
      return [];
    },
    async listExpirationEntries() {
      return [];
    },
    async getExpirationEntry() {
      return null;
    },
    async deleteExpirationEntry() {},
  };
}
