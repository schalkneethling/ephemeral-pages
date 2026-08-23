import { getStore, type Store } from "@netlify/blobs";

import {
  expirationIndexKey,
  IDEMPOTENCY_PREFIX,
  pageHtmlKey,
  pageMetadataKey,
  screenshotLockKey,
  screenshotMetadataKey,
  screenshotPngKey,
  screenshotPrefix,
  SCREENSHOT_BUDGET_PREFIX,
  type ScreenshotMetadata,
} from "../../src/domain.ts";
import type { PageMetadata } from "../../src/domain.ts";

const STORE_NAME = "ephemeral-pages";

export type StoredPageMetadata = Omit<PageMetadata, "collaboration"> & {
  collaboration?:
    | boolean
    | {
        enabled: true;
        capabilityVersion: string;
      };
};

export type StoredCollaborationSettings = NonNullable<
  Exclude<StoredPageMetadata["collaboration"], boolean>
>;

export function getStoredCollaborationSettings(
  metadata: StoredPageMetadata | null,
): StoredCollaborationSettings | null {
  return metadata && typeof metadata.collaboration === "object" ? metadata.collaboration : null;
}

export type PageStore = {
  savePage(html: string, metadata: StoredPageMetadata): Promise<void>;
  getMetadata(id: string): Promise<StoredPageMetadata | null>;
  getHtml(id: string): Promise<string | null>;
  deletePage(id: string, expiresAt?: string): Promise<void>;
  getRateLimit(key: string): Promise<VersionedRecord<RateLimitRecord> | null>;
  setRateLimit(
    key: string,
    record: RateLimitRecord,
    condition: WriteCondition,
  ): Promise<ConditionalWriteResult>;
  deleteRateLimit(key: string): Promise<void>;
  listRateLimitEntries(): Promise<string[]>;
  getIdempotency(key: string): Promise<VersionedRecord<IdempotencyRecord> | null>;
  setIdempotency(
    key: string,
    record: IdempotencyRecord,
    condition: WriteCondition,
  ): Promise<ConditionalWriteResult>;
  deleteIdempotency(key: string): Promise<void>;
  listIdempotencyEntries(): Promise<string[]>;
  listExpirationDirectories(): Promise<string[]>;
  listExpirationEntries(dayKey: string): Promise<string[]>;
  getExpirationEntry(key: string): Promise<{ id: string } | null>;
  deleteExpirationEntry(key: string): Promise<void>;
};

export type ScreenshotCaptureLock = {
  token: string;
  expiresAt: number;
};

export type ScreenshotDailyBudgetRecord = {
  count: number;
  resetAt: number;
};

export type ScreenshotUsage = {
  count: number;
  totalBytes: number;
};

export type ScreenshotStore = {
  saveScreenshot(png: ArrayBuffer, metadata: ScreenshotMetadata): Promise<void>;
  getScreenshotMetadata(pageId: string, screenshotId: string): Promise<ScreenshotMetadata | null>;
  getScreenshotPng(pageId: string, screenshotId: string): Promise<ArrayBuffer | null>;
  getScreenshotLock(pageId: string): Promise<VersionedRecord<ScreenshotCaptureLock> | null>;
  setScreenshotLock(
    pageId: string,
    record: ScreenshotCaptureLock,
    condition: WriteCondition,
  ): Promise<ConditionalWriteResult>;
  getScreenshotUsage(pageId: string): Promise<ScreenshotUsage>;
  getScreenshotBudget(key: string): Promise<VersionedRecord<ScreenshotDailyBudgetRecord> | null>;
  setScreenshotBudget(
    key: string,
    record: ScreenshotDailyBudgetRecord,
    condition: WriteCondition,
  ): Promise<ConditionalWriteResult>;
  listScreenshotBudgetEntries(): Promise<string[]>;
  deleteScreenshotBudget(key: string): Promise<void>;
};

export type RateLimitRecord = {
  count: number;
  resetAt: number;
};

export type IdempotencyRecord = {
  digest: string;
  pageId: string;
  response: {
    id: string;
    createdAt: string;
    expiresAt: string;
    url: string;
  };
  expiresAt: string;
};

export type VersionedRecord<T> = {
  record: T;
  etag: string;
};

export type WriteCondition = { onlyIfNew: true } | { onlyIfMatch: string };
export type ConditionalWriteResult = {
  modified: boolean;
  etag?: string;
};

export function createPageStore(
  store = getStore({ name: STORE_NAME, consistency: "strong" }),
): PageStore & ScreenshotStore {
  return {
    async savePage(html, metadata) {
      const expirationKey = expirationIndexKey(metadata.id, new Date(metadata.expiresAt));
      await store.setJSON(expirationKey, { id: metadata.id });
      try {
        await store.set(pageHtmlKey(metadata.id), html);
        await store.setJSON(pageMetadataKey(metadata.id), metadata);
      } catch (error) {
        const pageCompensation = await Promise.allSettled([
          store.delete(pageHtmlKey(metadata.id)),
          store.delete(pageMetadataKey(metadata.id)),
        ]);
        if (pageCompensation.every((result) => result.status === "fulfilled")) {
          await store.delete(expirationKey).catch(() => {
            console.error(
              JSON.stringify({ event: "storage_compensation_failure", page_id: metadata.id }),
            );
          });
        } else {
          console.error(
            JSON.stringify({ event: "storage_compensation_failure", page_id: metadata.id }),
          );
        }
        throw error;
      }
    },

    async getMetadata(id) {
      return getJson<StoredPageMetadata>(store, pageMetadataKey(id));
    },

    async getHtml(id) {
      return store.get(pageHtmlKey(id), { type: "text" });
    },

    async deletePage(id, expiresAt) {
      await store.delete(pageHtmlKey(id));
      await store.delete(pageMetadataKey(id));

      for await (const page of store.list({ prefix: screenshotPrefix(id), paginate: true })) {
        await Promise.all(page.blobs.map((blob) => store.delete(blob.key)));
      }

      if (expiresAt) {
        await store.delete(expirationIndexKey(id, new Date(expiresAt)));
      }
    },

    async getRateLimit(key) {
      return getVersionedJson<RateLimitRecord>(store, key);
    },

    async setRateLimit(key, record, condition) {
      return store.setJSON(key, record, condition);
    },

    async deleteRateLimit(key) {
      await store.delete(key);
    },

    async listRateLimitEntries() {
      const result = await store.list({ prefix: "rate-limits/" });
      return result.blobs.map((blob) => blob.key);
    },

    async getIdempotency(key) {
      return getVersionedJson<IdempotencyRecord>(store, key);
    },

    async setIdempotency(key, record, condition) {
      return store.setJSON(key, record, condition);
    },

    async deleteIdempotency(key) {
      await store.delete(key);
    },

    async listIdempotencyEntries() {
      const result = await store.list({ prefix: `${IDEMPOTENCY_PREFIX}/` });
      return result.blobs.map((blob) => blob.key);
    },

    async listExpirationDirectories() {
      const result = await store.list({ prefix: "expires/", directories: true });
      return result.directories ?? [];
    },

    async listExpirationEntries(dayKey) {
      const result = await store.list({ prefix: `${dayKey}/` });
      return result.blobs.map((blob) => blob.key);
    },

    async getExpirationEntry(key) {
      return getJson<{ id: string }>(store, key);
    },

    async deleteExpirationEntry(key) {
      await store.delete(key);
    },

    async saveScreenshot(png, metadata) {
      const pngKey = screenshotPngKey(metadata.pageId, metadata.id);
      const metadataKey = screenshotMetadataKey(metadata.pageId, metadata.id);
      await store.set(pngKey, png);
      try {
        await store.setJSON(metadataKey, metadata);
      } catch (error) {
        await store.delete(pngKey).catch(() => {
          console.error(
            JSON.stringify({
              event: "screenshot_storage_compensation_failure",
            }),
          );
        });
        throw error;
      }
    },

    async getScreenshotMetadata(pageId, screenshotId) {
      return getJson<ScreenshotMetadata>(store, screenshotMetadataKey(pageId, screenshotId));
    },

    async getScreenshotPng(pageId, screenshotId) {
      return store.get(screenshotPngKey(pageId, screenshotId), { type: "arrayBuffer" });
    },

    async getScreenshotLock(pageId) {
      return getVersionedJson<ScreenshotCaptureLock>(store, screenshotLockKey(pageId));
    },

    async setScreenshotLock(pageId, record, condition) {
      return store.setJSON(screenshotLockKey(pageId), record, condition);
    },

    async getScreenshotUsage(pageId) {
      let count = 0;
      let totalBytes = 0;
      for await (const page of store.list({ prefix: screenshotPrefix(pageId), paginate: true })) {
        const metadataKeys = page.blobs
          .map((blob) => blob.key)
          .filter((key) => key.endsWith(".json") && key !== screenshotLockKey(pageId));
        for (const key of metadataKeys) {
          const metadata = await getJson<ScreenshotMetadata>(store, key);
          if (
            !metadata ||
            metadata.pageId !== pageId ||
            !Number.isSafeInteger(metadata.sizeBytes) ||
            metadata.sizeBytes < 0
          ) {
            throw new Error("Screenshot usage metadata is invalid");
          }
          count += 1;
          totalBytes += metadata.sizeBytes;
          if (!Number.isSafeInteger(totalBytes)) {
            throw new Error("Screenshot usage exceeds the supported range");
          }
        }
      }
      return { count, totalBytes };
    },

    async getScreenshotBudget(key) {
      return getVersionedJson<ScreenshotDailyBudgetRecord>(store, key);
    },

    async setScreenshotBudget(key, record, condition) {
      return store.setJSON(key, record, condition);
    },

    async listScreenshotBudgetEntries() {
      const keys: string[] = [];
      for await (const page of store.list({
        prefix: `${SCREENSHOT_BUDGET_PREFIX}/`,
        paginate: true,
      })) {
        keys.push(...page.blobs.map((blob) => blob.key));
      }
      return keys;
    },

    async deleteScreenshotBudget(key) {
      await store.delete(key);
    },
  };
}

async function getVersionedJson<T>(store: Store, key: string): Promise<VersionedRecord<T> | null> {
  const result = await store.getWithMetadata(key, { type: "text" });
  if (!result?.etag) return null;
  try {
    return { record: JSON.parse(result.data) as T, etag: result.etag };
  } catch {
    return null;
  }
}

async function getJson<T>(store: Store, key: string): Promise<T | null> {
  const data = await store.get(key, { type: "text" });
  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
