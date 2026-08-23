import { jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";

import { pageMetadataKey } from "../../src/domain.ts";
import { buildCollaborativeUploadedPageHttpCsp } from "../../src/csp.ts";
import { matchApiRoute } from "../../src/routes.ts";
import {
  capabilityKeysFromEnv,
  COLLABORATION_TICKET_TTL_SECONDS,
  createEditorCapability,
  verifyEditorCapability,
  type CapabilityKeys,
  type TicketConfiguration,
} from "../functions/collaboration-auth.ts";
import { createCollaborationRoomDeletionNotifier } from "../functions/collaboration-service.ts";
import { cleanupExpiredPages } from "../functions/cleanup.ts";
import {
  createCollaborationTicket,
  createPage,
  deletePage,
  getPageContent,
} from "../functions/pages.ts";
import type {
  ConditionalWriteResult,
  IdempotencyRecord,
  PageStore,
  RateLimitRecord,
  StoredPageMetadata,
  VersionedRecord,
  WriteCondition,
} from "../functions/storage.ts";

const KEYS: CapabilityKeys = {
  current: { version: "v2", secret: "current-capability-secret-32-bytes-minimum" },
  previous: {
    version: "v1",
    secret: "previous-capability-secret-32-bytes-minimum",
    validUntil: "2026-08-24T08:00:00.000Z",
  },
};
const ROTATED_KEYS: CapabilityKeys = {
  current: { version: "v3", secret: "rotated-capability-secret-32-bytes-minimum" },
  previous: { ...KEYS.current, validUntil: "2026-08-24T08:00:00.000Z" },
};
const TICKET: TicketConfiguration = {
  secret: "ticket-signing-secret-at-least-32-bytes-long",
  audience: "ephemeral-collaboration",
  websocketUrl: "wss://collaboration.example.com",
};
const NOW = new Date("2026-08-23T08:00:00.000Z");

describe("collaboration capabilities", () => {
  it("creates deterministic page-bound capabilities and verifies current and previous keys", async () => {
    const expiry = "2026-08-24T08:00:00.000Z";
    const current = await createEditorCapability("page-1", expiry, KEYS.current);
    const repeated = await createEditorCapability("page-1", expiry, KEYS.current);
    const previous = await createEditorCapability("page-old", expiry, KEYS.previous!);

    expect(current).toBe(repeated);
    expect(current).not.toBe(await createEditorCapability("page-2", expiry, KEYS.current));
    expect(current).not.toBe(
      await createEditorCapability("page-1", "2026-08-25T08:00:00.000Z", KEYS.current),
    );
    await expect(verifyEditorCapability(current, "page-1", expiry, "v2", KEYS, NOW)).resolves.toBe(
      true,
    );
    await expect(
      verifyEditorCapability(previous, "page-old", expiry, "v1", KEYS, NOW),
    ).resolves.toBe(true);
    await expect(verifyEditorCapability(current, "page-2", expiry, "v2", KEYS, NOW)).resolves.toBe(
      false,
    );
    await expect(
      verifyEditorCapability(`${current.slice(0, -1)}A`, "page-1", expiry, "v2", KEYS, NOW),
    ).resolves.toBe(false);
    await expect(
      verifyEditorCapability(
        previous,
        "page-old",
        expiry,
        "v1",
        KEYS,
        new Date(KEYS.previous!.validUntil),
      ),
    ).resolves.toBe(false);
  });

  it("loads a strict current/previous rotation window without exposing secrets", () => {
    const values: Record<string, string> = {
      COLLABORATION_CAPABILITY_CURRENT_VERSION: "v2",
      COLLABORATION_CAPABILITY_CURRENT_SECRET: KEYS.current.secret,
      COLLABORATION_CAPABILITY_PREVIOUS_VERSION: "v1",
      COLLABORATION_CAPABILITY_PREVIOUS_SECRET: KEYS.previous!.secret,
      COLLABORATION_CAPABILITY_PREVIOUS_VALID_UNTIL: KEYS.previous!.validUntil,
    };
    expect(capabilityKeysFromEnv((name) => values[name], NOW)).toEqual(KEYS);
    expect(
      capabilityKeysFromEnv(
        (name) => (name === "COLLABORATION_CAPABILITY_CURRENT_VERSION" ? "v2" : undefined),
        NOW,
      ),
    ).toBe(null);
    expect(capabilityKeysFromEnv((name) => values[name], new Date(KEYS.previous!.validUntil))).toBe(
      null,
    );
    expect(
      capabilityKeysFromEnv(
        (name) =>
          name === "COLLABORATION_CAPABILITY_PREVIOUS_VALID_UNTIL"
            ? "2026-08-31T08:00:00.000Z"
            : values[name],
        NOW,
      ),
    ).toBe(null);
  });
});

describe("collaboration page APIs", () => {
  it("creates an opt-in page without persisting its capability and replays it idempotently", async () => {
    const store = memoryStore();
    const request = () =>
      jsonRequest({ html: "<html><body>Board</body></html>", collaboration: true }, "/api/pages", {
        "Idempotency-Key": "board-upload",
      });
    const dependencies = {
      publicBaseUrl: "https://pages.example.com",
      createId: () => "board-1",
      now: () => NOW,
      capabilityKeys: KEYS,
    };

    const first = await createPage(request(), store, dependencies);
    const replay = await createPage(request(), store, {
      ...dependencies,
      capabilityKeys: ROTATED_KEYS,
    });
    const firstBody = await first.json();
    const replayBody = await replay.json();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(firstBody).toEqual(replayBody);
    expect(firstBody).toMatchObject({
      url: "https://pages.example.com/p/board-1",
      collaboration: {
        viewUrl: "https://pages.example.com/p/board-1",
      },
    });
    expect(firstBody.collaboration.editUrl).toMatch(
      /^https:\/\/pages\.example\.com\/p\/board-1#edit=v2\.[A-Za-z0-9_-]{43}$/,
    );
    expect(JSON.stringify(await store.getMetadata("board-1"))).not.toContain(
      firstBody.collaboration.editUrl,
    );
    expect(JSON.stringify(store.values.get(pageMetadataKey("board-1")))).not.toContain("edit=");
    expect(JSON.stringify([...store.idempotency.values()])).not.toContain("edit=");
    expect(await store.getHtml("board-1")).toContain("data-ephemeral-collaboration-sdk");
    const content = await getPageContent("board-1", store);
    expect(content.headers.get("Content-Security-Policy")).toBe(
      buildCollaborativeUploadedPageHttpCsp(),
    );
  });

  it("mints short-lived viewer and editor tickets and rejects invalid or expired access", async () => {
    const store = memoryStore();
    await store.savePage("<html></html>", {
      id: "room-1",
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
      sizeBytes: 13,
      collaboration: { enabled: true, capabilityVersion: "v1" },
    });
    const capability = await createEditorCapability(
      "room-1",
      "2026-08-23T08:00:30.000Z",
      KEYS.previous!,
    );
    const dependencies = {
      capabilityKeys: KEYS,
      ticketConfiguration: TICKET,
      now: () => NOW,
      createTicketId: () => "ticket-1",
    };

    const viewer = await createCollaborationTicket(
      jsonRequest({}, "/api/pages/room-1/collaboration-ticket"),
      "room-1",
      store,
      dependencies,
    );
    const editor = await createCollaborationTicket(
      jsonRequest({ capability }, "/api/pages/room-1/collaboration-ticket"),
      "room-1",
      store,
      dependencies,
    );
    const invalid = await createCollaborationTicket(
      jsonRequest({ capability: `${capability}x` }, "/api/pages/room-1/collaboration-ticket"),
      "room-1",
      store,
      dependencies,
    );

    expect(viewer.status).toBe(200);
    expect(editor.status).toBe(200);
    expect(await viewer.clone().json()).toMatchObject({
      websocketUrl: "wss://collaboration.example.com/rooms/room-1/websocket",
      role: "view",
    });
    expect(await editor.clone().json()).toMatchObject({ role: "edit" });
    expect(invalid.status).toBe(403);

    const viewerToken = (await viewer.json()).ticket as string;
    const verified = await jwtVerify(viewerToken, new TextEncoder().encode(TICKET.secret), {
      audience: TICKET.audience,
      issuer: "ephemeral-pages",
      currentDate: NOW,
    });
    expect(verified.payload).toMatchObject({
      sub: "room-1",
      roomId: "room-1",
      role: "view",
      jti: "ticket-1",
      ticketId: "ticket-1",
      audience: TICKET.audience,
      version: 1,
    });
    expect(verified.payload.exp! - verified.payload.iat!).toBe(30);
    expect(verified.payload.exp! - verified.payload.iat!).toBeLessThanOrEqual(
      COLLABORATION_TICKET_TTL_SECONDS,
    );

    const expired = await createCollaborationTicket(
      jsonRequest({}, "/api/pages/room-1/collaboration-ticket"),
      "room-1",
      store,
      { ...dependencies, now: () => new Date(NOW.getTime() + 30_000) },
    );
    expect(expired.status).toBe(410);
  });

  it("exposes the route and notifies collaboration deletion after an admin hard delete", async () => {
    expect(
      matchApiRoute(
        new Request("https://example.com/api/pages/room-1/collaboration-ticket", {
          method: "POST",
        }),
      ),
    ).toEqual({ name: "create-collaboration-ticket", id: "room-1" });

    const store = memoryStore();
    await store.savePage("<html></html>", {
      id: "room-1",
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      sizeBytes: 13,
      collaboration: { enabled: true, capabilityVersion: "v2" },
    });
    const notify = vi.fn(async () => {});
    const response = await deletePage(
      new Request("https://example.com/api/admin/pages/room-1", {
        method: "DELETE",
        headers: {
          Authorization: "Bearer admin-secret",
          "x-nf-client-connection-ip": "203.0.113.2",
        },
      }),
      "room-1",
      store,
      "admin-secret",
      { notifyCollaborationDeleted: notify },
    );

    expect(response.status).toBe(200);
    expect(notify).toHaveBeenCalledWith("room-1", "2026-08-23T08:01:00.000Z");
  });
});

describe("collaboration service", () => {
  it("sends authenticated fixed-origin deletion requests", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(null, { status: 204 });
    };
    const notify = createCollaborationRoomDeletionNotifier({
      serviceUrl: "https://collaboration.example.com/base",
      serviceToken: "internal-secret",
      fetchImpl,
    });
    await notify!("room/one", "2026-08-23T08:00:00.000Z");

    expect(requests).toHaveLength(1);
    expect(requests[0].input).toBeInstanceOf(URL);
    expect((requests[0].input as URL).href).toBe(
      "https://collaboration.example.com/rooms/room%2Fone",
    );
    expect(requests[0].init?.headers).toEqual({
      Authorization: "Bearer internal-secret",
      "X-Ephemeral-Page-Expires-At": "1787472000",
    });
  });

  it("keeps scheduled deletion successful when room notification fails", async () => {
    const deletePageFromStore = vi.fn(async () => {});
    const deleteExpirationEntry = vi.fn(async () => {});
    const notify = vi.fn(async () => {
      throw new Error("worker unavailable");
    });
    const store = {
      listExpirationDirectories: async () => ["expires/2026-08-23"],
      listExpirationEntries: async () => ["expires/2026-08-23/room-1.json"],
      getExpirationEntry: async () => ({ id: "room-1" }),
      getMetadata: async () => ({
        id: "room-1",
        createdAt: "2026-08-23T06:00:00.000Z",
        expiresAt: "2026-08-23T07:00:00.000Z",
        sizeBytes: 13,
        collaboration: { enabled: true as const, capabilityVersion: "v2" },
      }),
      deletePage: deletePageFromStore,
      deleteExpirationEntry,
    } as unknown as PageStore;

    await expect(
      cleanupExpiredPages(store, NOW, { notifyCollaborationDeleted: notify }),
    ).resolves.toBe(1);
    expect(deletePageFromStore).toHaveBeenCalledWith("room-1", "2026-08-23T07:00:00.000Z");
    expect(notify).toHaveBeenCalledWith("room-1", "2026-08-23T07:00:00.000Z");
    expect(deleteExpirationEntry).toHaveBeenCalled();
  });
});

function jsonRequest(
  body: unknown,
  path: string,
  additionalHeaders: Record<string, string> = {},
): Request {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nf-client-connection-ip": "203.0.113.1",
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
  });
}

function memoryStore(): PageStore & {
  values: Map<string, string>;
  idempotency: Map<string, VersionedRecord<IdempotencyRecord>>;
} {
  const values = new Map<string, string>();
  const rateLimits = new Map<string, VersionedRecord<RateLimitRecord>>();
  const idempotency = new Map<string, VersionedRecord<IdempotencyRecord>>();
  let etag = 0;
  const write = <T>(
    records: Map<string, VersionedRecord<T>>,
    key: string,
    record: T,
    condition: WriteCondition,
  ): ConditionalWriteResult => {
    const existing = records.get(key);
    if ("onlyIfNew" in condition && existing) return { modified: false };
    if ("onlyIfMatch" in condition && existing?.etag !== condition.onlyIfMatch) {
      return { modified: false };
    }
    const next = String(++etag);
    records.set(key, { record, etag: next });
    return { modified: true, etag: next };
  };

  return {
    values,
    idempotency,
    async savePage(html, metadata) {
      values.set(`pages/${metadata.id}/index.html`, html);
      values.set(pageMetadataKey(metadata.id), JSON.stringify(metadata));
    },
    async getMetadata(id) {
      const value = values.get(pageMetadataKey(id));
      return value ? (JSON.parse(value) as StoredPageMetadata) : null;
    },
    async getHtml(id) {
      return values.get(`pages/${id}/index.html`) ?? null;
    },
    async deletePage(id) {
      values.delete(`pages/${id}/index.html`);
      values.delete(pageMetadataKey(id));
    },
    async getRateLimit(key) {
      return rateLimits.get(key) ?? null;
    },
    async setRateLimit(key, record, condition) {
      return write(rateLimits, key, record, condition);
    },
    async deleteRateLimit(key) {
      rateLimits.delete(key);
    },
    async listRateLimitEntries() {
      return [...rateLimits.keys()];
    },
    async getIdempotency(key) {
      return idempotency.get(key) ?? null;
    },
    async setIdempotency(key, record, condition) {
      return write(idempotency, key, record, condition);
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
