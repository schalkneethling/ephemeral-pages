import type { Config } from "@netlify/functions";

import { isExpired } from "../../src/domain.ts";
import { createPageStore, type PageStore, type RateLimitRecord } from "./storage.ts";

export const config: Config = {
  schedule: "0 * * * *",
};

export default async function handler() {
  const store = createPageStore();
  const pagesDeleted = await cleanupExpiredPages(store);
  const rateLimitsDeleted = await cleanupExpiredRateLimits(store);
  const deleted = pagesDeleted + rateLimitsDeleted;

  console.log(
    `Cleanup: hard-deleted ${pagesDeleted} expired page(s) and ${rateLimitsDeleted} expired rate-limit record(s)`,
  );
  return new Response(JSON.stringify({ deleted, pagesDeleted, rateLimitsDeleted }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function cleanupExpiredPages(store: PageStore, now = new Date()): Promise<number> {
  const dateDirs = await store.listExpirationDirectories();
  let deleted = 0;

  for (const dateDir of dateDirs) {
    if (expirationDirectoryIsInFuture(dateDir, now)) {
      continue;
    }

    const entryKeys = await store.listExpirationEntries(dateDir.replace(/\/$/, ""));
    for (const entryKey of entryKeys) {
      const entry = await store.getExpirationEntry(entryKey);
      if (!entry?.id) {
        await store.deleteExpirationEntry(entryKey);
        continue;
      }

      const metadata = await store.getMetadata(entry.id);
      if (metadata && !isExpired(metadata.expiresAt, now)) {
        continue;
      }

      await store.deletePage(entry.id, metadata?.expiresAt);
      await store.deleteExpirationEntry(entryKey);
      deleted += 1;
    }
  }

  return deleted;
}

export async function cleanupExpiredRateLimits(
  store: PageStore,
  now = Date.now(),
): Promise<number> {
  const entryKeys = await store.listRateLimitEntries();
  let deleted = 0;

  for (const entryKey of entryKeys) {
    const record = await store.getRateLimit(entryKey);
    if (!activeRateLimitRecord(record, now)) {
      await store.deleteRateLimit(entryKey);
      deleted += 1;
    }
  }

  return deleted;
}

function expirationDirectoryIsInFuture(dateDir: string, now: Date): boolean {
  const day = dateDir.replace(/^expires\//, "").replace(/\/$/, "");
  const dayStart = new Date(`${day}T00:00:00Z`);

  if (Number.isNaN(dayStart.getTime())) {
    return false;
  }

  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return dayStart > todayStart;
}

function activeRateLimitRecord(record: RateLimitRecord | null, now: number): boolean {
  return (
    typeof record?.count === "number" &&
    Number.isFinite(record.count) &&
    typeof record.resetAt === "number" &&
    Number.isFinite(record.resetAt) &&
    record.resetAt > now
  );
}
