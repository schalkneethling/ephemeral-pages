import type { Config } from "@netlify/functions";

import { isExpired } from "../../src/domain.ts";
import {
  createCollaborationRoomDeletionNotifier,
  type CollaborationRoomDeletionNotifier,
} from "./collaboration-service.ts";
import { captureException, captureSecurityEvent, getEnv } from "./security.ts";
import {
  createPageStore,
  getStoredCollaborationSettings,
  type IdempotencyRecord,
  type PageStore,
  type RateLimitRecord,
  type ScreenshotDailyBudgetRecord,
  type ScreenshotStore,
} from "./storage.ts";

export const config: Config = {
  schedule: "0 * * * *",
};

export default async function handler() {
  const store = createPageStore();
  const notifyCollaborationDeleted =
    createCollaborationRoomDeletionNotifier({
      serviceUrl: getEnv("COLLABORATION_SERVICE_URL"),
      serviceToken: getEnv("COLLABORATION_SERVICE_TOKEN"),
    }) ?? undefined;
  const pagesDeleted = await cleanupExpiredPages(store, new Date(), {
    notifyCollaborationDeleted,
  });
  const rateLimitsDeleted = await cleanupExpiredRateLimits(store);
  const idempotencyDeleted = await cleanupExpiredIdempotency(store);
  const screenshotBudgetsDeleted = await cleanupExpiredScreenshotBudgets(store);
  const deleted = pagesDeleted + rateLimitsDeleted + idempotencyDeleted + screenshotBudgetsDeleted;

  console.log(
    `Cleanup: hard-deleted ${pagesDeleted} page(s), ${rateLimitsDeleted} rate-limit record(s), ${idempotencyDeleted} idempotency record(s), and ${screenshotBudgetsDeleted} screenshot budget record(s)`,
  );
  return new Response(
    JSON.stringify({
      deleted,
      pagesDeleted,
      rateLimitsDeleted,
      idempotencyDeleted,
      screenshotBudgetsDeleted,
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function cleanupExpiredPages(
  store: PageStore,
  now = new Date(),
  dependencies: { notifyCollaborationDeleted?: CollaborationRoomDeletionNotifier } = {},
): Promise<number> {
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
      if (
        metadata &&
        getStoredCollaborationSettings(metadata)?.enabled &&
        dependencies.notifyCollaborationDeleted
      ) {
        try {
          await dependencies.notifyCollaborationDeleted(entry.id, metadata.expiresAt);
        } catch (error) {
          captureException(error);
          captureSecurityEvent("collaboration_room_deletion_failed", "error", {
            page_id: entry.id,
            source: "scheduled_cleanup",
          });
        }
      }
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
  return sweepInactiveRecords({
    list: () => store.listRateLimitEntries(),
    get: async (key) => (await store.getRateLimit(key))?.record ?? null,
    delete: (key) => store.deleteRateLimit(key),
    isActive: (record) => activeRateLimitRecord(record, now),
  });
}

export async function cleanupExpiredIdempotency(
  store: PageStore,
  now = new Date(),
): Promise<number> {
  return sweepInactiveRecords({
    list: () => store.listIdempotencyEntries(),
    get: async (key) => (await store.getIdempotency(key))?.record ?? null,
    delete: (key) => store.deleteIdempotency(key),
    isActive: (record) => activeIdempotencyRecord(record, now),
  });
}

export async function cleanupExpiredScreenshotBudgets(
  store: ScreenshotStore,
  now = Date.now(),
): Promise<number> {
  return sweepInactiveRecords({
    list: () => store.listScreenshotBudgetEntries(),
    get: async (key) => (await store.getScreenshotBudget(key))?.record ?? null,
    delete: (key) => store.deleteScreenshotBudget(key),
    isActive: (record) => activeScreenshotBudgetRecord(record, now),
  });
}

async function sweepInactiveRecords<T>({
  list,
  get,
  delete: deleteRecord,
  isActive,
}: {
  list: () => Promise<string[]>;
  get: (key: string) => Promise<T | null>;
  delete: (key: string) => Promise<void>;
  isActive: (record: T | null) => boolean;
}): Promise<number> {
  const entryKeys = await list();
  let deleted = 0;
  for (const entryKey of entryKeys) {
    const record = await get(entryKey);
    if (!isActive(record)) {
      await deleteRecord(entryKey);
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

function activeIdempotencyRecord(record: IdempotencyRecord | null, now: Date): boolean {
  return (
    typeof record?.digest === "string" &&
    typeof record.pageId === "string" &&
    typeof record.expiresAt === "string" &&
    new Date(record.expiresAt) > now
  );
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

function activeScreenshotBudgetRecord(
  record: ScreenshotDailyBudgetRecord | null,
  now: number,
): boolean {
  return (
    typeof record?.count === "number" &&
    Number.isSafeInteger(record.count) &&
    record.count >= 0 &&
    typeof record.resetAt === "number" &&
    Number.isSafeInteger(record.resetAt) &&
    record.resetAt > now
  );
}
