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
  getRateLimit(key: string): Promise<RateLimitRecord | null>;
  setRateLimit(key: string, record: RateLimitRecord): Promise<void>;
  deleteRateLimit(key: string): Promise<void>;
  listRateLimitEntries(): Promise<string[]>;
  listExpirationDirectories(): Promise<string[]>;
  listExpirationEntries(dayKey: string): Promise<string[]>;
  getExpirationEntry(key: string): Promise<{ id: string } | null>;
  deleteExpirationEntry(key: string): Promise<void>;
}

export interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export function createPageStore(
  store = getStore({ name: STORE_NAME, consistency: "strong" }),
): PageStore {
  return {
    async savePage(html, metadata) {
      await store.set(pageHtmlKey(metadata.id), html);
      await store.setJSON(pageMetadataKey(metadata.id), metadata);
      await store.setJSON(expirationIndexKey(metadata.id, new Date(metadata.expiresAt)), {
        id: metadata.id,
      });
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
      return getJson<RateLimitRecord>(store, key);
    },

    async setRateLimit(key, record) {
      await store.setJSON(key, record);
    },

    async deleteRateLimit(key) {
      await store.delete(key);
    },

    async listRateLimitEntries() {
      const result = await store.list({ prefix: "rate-limits/" });
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
