import { describe, expect, it } from "vitest";

import type { PageStore } from "../../netlify/functions/storage.ts";
import { expirationIndexKey, pageHtmlKey, pageMetadataKey, type PageMetadata } from "../domain.ts";
import { publishPage, readPage } from "./tools.ts";

const FULL_HTML = `<!doctype html>
<html>
<head><title>Report</title></head>
<body><h1>Report</h1></body>
</html>`;

function incomingRequest(additionalHeaders: Record<string, string> = {}): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      "x-nf-client-connection-ip": "203.0.113.1",
      ...additionalHeaders,
    },
  });
}

describe("MCP page tool adapters", () => {
  it("publishes a full HTML document and returns public metadata", async () => {
    const store = createMemoryStore();
    const result = await publishPage(
      incomingRequest(),
      { html: FULL_HTML, expirationHours: 24 },
      store,
    );

    expect(result.isError).toBe(false);
    if (result.isError) return;

    expect(result.structuredContent.id).toBeTruthy();
    expect(result.structuredContent.url).toBe(
      `https://example.com/p/${result.structuredContent.id}`,
    );
    expect(result.structuredContent.createdAt).toBeTruthy();
    expect(result.structuredContent.expiresAt).toBeTruthy();
    expect(result.text).toContain(result.structuredContent.url);
    expect(
      new Date(result.structuredContent.expiresAt).getTime() -
        new Date(result.structuredContent.createdAt).getTime(),
    ).toBe(24 * 3_600_000);
    expect(await store.getHtml(result.structuredContent.id)).toBe(FULL_HTML);
  });

  it("defaults the TTL to 12 hours when expirationHours is omitted or nullish", async () => {
    const omitted = await publishPage(incomingRequest(), { html: FULL_HTML }, createMemoryStore());
    const nullish = await publishPage(
      incomingRequest(),
      { html: FULL_HTML, expirationHours: undefined, idempotencyKey: undefined },
      createMemoryStore(),
    );

    expect(omitted.isError).toBe(false);
    expect(nullish.isError).toBe(false);
    if (omitted.isError || nullish.isError) return;
    expect(
      new Date(omitted.structuredContent.expiresAt).getTime() -
        new Date(omitted.structuredContent.createdAt).getTime(),
    ).toBe(12 * 3_600_000);
    expect(
      new Date(nullish.structuredContent.expiresAt).getTime() -
        new Date(nullish.structuredContent.createdAt).getTime(),
    ).toBe(12 * 3_600_000);
  });

  it("returns metadata for a known id without HTML", async () => {
    const store = createMemoryStore();
    const created = await publishPage(incomingRequest(), { html: FULL_HTML }, store);
    expect(created.isError).toBe(false);
    if (created.isError) return;

    const result = await readPage(incomingRequest(), { id: created.structuredContent.id }, store);

    expect(result.isError).toBe(false);
    if (result.isError) return;
    expect(result.structuredContent).toEqual(created.structuredContent);
    expect(JSON.stringify(result.structuredContent)).not.toContain("<html");
    expect(result.text).not.toContain("<html");
  });

  it("returns the existing API error for incomplete HTML or a bad TTL", async () => {
    const store = createMemoryStore();
    const fragment = await publishPage(incomingRequest(), { html: "<p>Hello</p>" }, store);
    const badTtl = await publishPage(
      incomingRequest(),
      { html: FULL_HTML, expirationHours: 2 },
      store,
    );

    expect(fragment).toMatchObject({
      isError: true,
      text: "The uploaded file must include a source-authored <html> or <head> element.",
    });
    expect(badTtl).toMatchObject({
      isError: true,
      text: "Expiration must use one of the allowed options",
    });
  });

  it("ignores incoming Authorization so a leftover Bearer token cannot fail the publish", async () => {
    const store = createMemoryStore();
    const result = await publishPage(
      incomingRequest({ Authorization: "Bearer leftover-client-token" }),
      { html: FULL_HTML },
      store,
    );

    expect(result.isError).toBe(false);
    if (result.isError) return;
    expect(result.structuredContent.id).toBeTruthy();
    expect(await store.getHtml(result.structuredContent.id)).toBe(FULL_HTML);
  });

  it("replays the same idempotent publish and conflicts on a changed payload", async () => {
    const store = createMemoryStore();
    const incoming = incomingRequest();
    const first = await publishPage(
      incoming,
      { html: FULL_HTML, idempotencyKey: "run-123" },
      store,
    );
    const replay = await publishPage(
      incoming,
      { html: FULL_HTML, idempotencyKey: "run-123" },
      store,
    );
    const conflict = await publishPage(
      incoming,
      {
        html: "<!doctype html><html><head></head><body><p>Changed</p></body></html>",
        idempotencyKey: "run-123",
      },
      store,
    );

    expect(first.isError).toBe(false);
    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({
      isError: true,
      text: "Idempotency-Key was already used for a different request",
    });
  });
});

function createMemoryStore(): PageStore {
  const values = new Map<string, string>();
  const etags = new Map<string, string>();
  let etagCounter = 0;

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
      const value = values.get(pageMetadataKey(id));
      return value ? (JSON.parse(value) as PageMetadata) : null;
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
      const value = values.get(key);
      const etag = etags.get(key);
      return value && etag ? { record: JSON.parse(value), etag } : null;
    },
    async setRateLimit(key, record, condition) {
      if ("onlyIfNew" in condition && values.has(key)) return { modified: false };
      if ("onlyIfMatch" in condition && etags.get(key) !== condition.onlyIfMatch) {
        return { modified: false };
      }
      values.set(key, JSON.stringify(record));
      const etag = String(++etagCounter);
      etags.set(key, etag);
      return { modified: true, etag };
    },
    async deleteRateLimit(key) {
      values.delete(key);
      etags.delete(key);
    },
    async listRateLimitEntries() {
      return [...values.keys()].filter((key) => key.startsWith("rate-limits/"));
    },
    async getIdempotency(key) {
      const value = values.get(key);
      const etag = etags.get(key);
      return value && etag ? { record: JSON.parse(value), etag } : null;
    },
    async setIdempotency(key, record, condition) {
      if ("onlyIfNew" in condition && values.has(key)) return { modified: false };
      if ("onlyIfMatch" in condition && etags.get(key) !== condition.onlyIfMatch) {
        return { modified: false };
      }
      values.set(key, JSON.stringify(record));
      const etag = String(++etagCounter);
      etags.set(key, etag);
      return { modified: true, etag };
    },
    async deleteIdempotency(key) {
      values.delete(key);
      etags.delete(key);
    },
    async listIdempotencyEntries() {
      return [...values.keys()].filter((key) => key.startsWith("idempotency/"));
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
      const value = values.get(key);
      return value ? (JSON.parse(value) as { id: string }) : null;
    },
    async deleteExpirationEntry(key) {
      values.delete(key);
    },
  };
}
