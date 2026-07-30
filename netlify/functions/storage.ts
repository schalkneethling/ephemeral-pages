import { getStore, type Store } from "@netlify/blobs";

import {
  expirationIndexKey,
  pageHtmlKey,
  pageMetadataKey,
  type PageMetadata,
} from "../../src/domain.ts";

const STORE_NAME = "ephemeral-pages";

export interface PageStore {
  savePage(html: string, metadata: PageMetadata): Promise<void>;
  getMetadata(id: string): Promise<PageMetadata | null>;
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
}

export interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export interface IdempotencyRecord {
  digest: string;
  pageId: string;
  response: {
    id: string;
    createdAt: string;
    expiresAt: string;
    url: string;
  };
  expiresAt: string;
}

export interface VersionedRecord<T> {
  record: T;
  etag: string;
}

export type WriteCondition = { onlyIfNew: true } | { onlyIfMatch: string };
export interface ConditionalWriteResult {
  modified: boolean;
  etag?: string;
}

export function createPageStore(
  store = getStore({ name: STORE_NAME, consistency: "strong" }),
): PageStore {
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
      return getJson<PageMetadata>(store, pageMetadataKey(id));
    },

    async getHtml(id) {
      return store.get(pageHtmlKey(id), { type: "text" });
    },

    async deletePage(id, expiresAt) {
      await store.delete(pageHtmlKey(id));
      await store.delete(pageMetadataKey(id));

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
      const result = await store.list({ prefix: "idempotency/" });
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
