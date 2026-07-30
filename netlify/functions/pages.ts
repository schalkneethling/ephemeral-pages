import type { Config } from "@netlify/functions";

import { buildUploadedPageHttpCsp } from "../../src/csp.ts";
import {
  expirationDate,
  htmlByteLength,
  idempotencyKey,
  isExpired,
  PAGE_UNAVAILABLE_REASON,
  type ApiErrorResponse,
  type CreatePageRequest,
  type CreatePageResponse,
  type PageMetadata,
  type PageUnavailableReason,
  validateExpirationHours,
} from "../../src/domain.ts";
import { resolveUploadIdentity, verifyGitHubOidcToken } from "./github-oidc.ts";
import { matchApiRoute } from "../../src/routes.ts";
import { decodeAndValidateHtml } from "./html-validation.ts";
import {
  captureException,
  captureSecurityEvent,
  checkRateLimit,
  getAdminDeleteToken,
  getEnv,
  hashValue,
  initSentry,
  resetRateLimit,
} from "./security.ts";
import { createPageStore, type IdempotencyRecord, type PageStore } from "./storage.ts";

const NETLIFY_RATE_LIMIT_WINDOW_SECONDS = 60;
const NETLIFY_RATE_LIMIT_REQUESTS = 120;

export const config: Config & {
  rateLimit: { aggregateBy: string[]; windowSize: number; windowLimit: number };
} = {
  path: "/api/*",
  rateLimit: {
    aggregateBy: ["ip", "domain"],
    windowSize: NETLIFY_RATE_LIMIT_WINDOW_SECONDS,
    windowLimit: NETLIFY_RATE_LIMIT_REQUESTS,
  },
};

export default async function handler(req: Request) {
  initSentry();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 405, headers: { Allow: "DELETE, GET, POST" } });
  }

  const route = matchApiRoute(req);
  if (!route) {
    return jsonError("Method not allowed", 405);
  }

  const store = createPageStore();

  try {
    switch (route.name) {
      case "create-page":
        return await createPage(req, store);
      case "create-report":
        return await createReport(req, store);
      case "get-page":
        return await getPageMetadata(route.id, store);
      case "get-page-content":
        return await getPageContent(route.id, store);
      case "delete-page":
        return await deletePage(req, route.id, store, getAdminDeleteToken());
    }
  } catch (error) {
    captureException(error);
    return jsonError("Internal server error", 500);
  }
}

export async function createPage(
  req: Request,
  store: PageStore,
  dependencies: {
    verifyOidc?: typeof verifyGitHubOidcToken;
    oidcAudience?: string;
    publicBaseUrl?: string;
    now?: () => Date;
    createId?: () => string;
  } = {},
): Promise<Response> {
  if (!isJsonRequest(req)) {
    return jsonError("Content-Type must be application/json", 415);
  }

  const identity = await resolveUploadIdentity(
    req,
    dependencies.verifyOidc,
    dependencies.oidcAudience,
  );
  if (!identity.ok) {
    return jsonError(identity.error, identity.status);
  }

  const actor = identity.identity;
  const actorSubject = actor.type === "github" ? actor.repositoryId : actor.ip;
  const limit = await checkRateLimit(req, store, "upload", "global", Date.now(), {
    type: actor.type,
    subject: actorSubject,
  });
  if (!limit.ok) return limit.response;
  const actorHash = limit.actorHash;

  const body = await parseJson<CreatePageRequest>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("Request body must be valid JSON", 400);
  }

  const encoding = "encoding" in body ? body.encoding : undefined;
  const html = await decodeAndValidateHtml(body.html, encoding);
  if (!html.ok) {
    captureSecurityEvent("upload_payload_rejected", "info", { reason: html.reason });
    return jsonError(html.error, html.status);
  }

  const expirationHours = validateExpirationHours(body.expirationHours);
  if (!expirationHours.ok) {
    return jsonError(expirationHours.error, 400);
  }

  const requestDigest = await digestRequest(html.value, expirationHours.value);
  const idempotency = await resolveIdempotency(req, store, actor.type, actorHash, requestDigest);
  if (!idempotency.ok) return idempotency.response;
  if (idempotency.record) {
    captureSecurityEvent("idempotency_hit", "info", {
      actor_type: actor.type,
      actor_hash: actorHash,
    });
    return json(idempotency.record.response, 200, limit.headers);
  }

  const publicBaseUrl = resolvePublicBaseUrl(
    req,
    dependencies.publicBaseUrl ?? getEnv("PUBLIC_BASE_URL"),
  );
  if (!publicBaseUrl) {
    return jsonError("Public page URL is not configured correctly", 500);
  }

  const id = dependencies.createId?.() ?? crypto.randomUUID();
  const now = dependencies.now?.() ?? new Date();
  const expiresAt = expirationDate(expirationHours.value, now);
  const metadata: PageMetadata = {
    id,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sizeBytes: htmlByteLength(html.value),
  };

  await store.savePage(html.value, metadata);

  const responseBody: CreatePageResponse = {
    id,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    url: new URL(`/p/${id}`, publicBaseUrl).href,
  };

  if (idempotency.key) {
    const record: IdempotencyRecord = {
      digest: requestDigest,
      pageId: id,
      response: responseBody,
      expiresAt: metadata.expiresAt,
    };
    let claim;
    try {
      claim = await store.setIdempotency(idempotency.key, record, { onlyIfNew: true });
    } catch {
      await compensatePage(store, id, metadata.expiresAt);
      return jsonError("Idempotency is temporarily unavailable", 503, { "Retry-After": "2" });
    }
    if (!claim.modified) {
      let authoritative;
      try {
        authoritative = await store.getIdempotency(idempotency.key);
      } catch {
        return jsonError("Idempotency is temporarily unavailable", 503, { "Retry-After": "2" });
      } finally {
        await compensatePage(store, id, metadata.expiresAt);
      }
      if (!authoritative) {
        return jsonError("Idempotency is temporarily unavailable", 503, { "Retry-After": "2" });
      }
      if (authoritative.record.digest !== requestDigest) {
        return idempotencyConflict(actor.type, actorHash);
      }
      return json(authoritative.record.response, 200, limit.headers);
    }
  }

  captureSecurityEvent("upload_accepted", "info", {
    actor_type: actor.type,
    actor_hash: actorHash,
    compressed_bytes: String(html.compressedBytes),
    raw_bytes: String(html.rawBytes),
    ttl_hours: String(expirationHours.value),
  });
  return json(responseBody, 201, limit.headers);
}

export async function createReport(req: Request, store: PageStore): Promise<Response> {
  const limit = await checkRateLimit(req, store, "report");
  if (!limit.ok) {
    return limit.response;
  }

  if (!isJsonRequest(req)) {
    return jsonError("Content-Type must be application/json", 415);
  }

  const body = await parseJson<{ pageId?: unknown; flaggedUrl?: unknown }>(req);
  if (!body || typeof body.pageId !== "string" || typeof body.flaggedUrl !== "string") {
    return jsonError("Report payload is invalid", 400);
  }

  const flaggedUrl = sameOriginPageUrl(body.flaggedUrl, req.url);
  if (!flaggedUrl || flaggedUrl.pageId !== body.pageId) {
    return jsonError("Report URL is invalid", 400);
  }

  const reportBody = new URLSearchParams({
    "form-name": "abuse-report",
    pageId: flaggedUrl.pageId,
    flaggedUrl: flaggedUrl.url.href,
    reportedAt: new Date().toISOString(),
    userAgent: req.headers.get("user-agent") ?? "unknown",
    adminReviewUrl: `${flaggedUrl.url.origin}/admin?url=${encodeURIComponent(flaggedUrl.url.href)}`,
  });

  const response = await fetch(new URL("/__forms.html", req.url), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: reportBody,
  });

  if (!response.ok) {
    throw new Error(`Report form submission failed with status ${response.status}`);
  }

  return json({ reported: true }, 200);
}

export async function getPageMetadata(id: string, store: PageStore): Promise<Response> {
  const page = await findAvailablePage(id, store);
  if (!page.ok) {
    return jsonError(page.error, page.status);
  }

  return json(
    {
      id: page.metadata.id,
      createdAt: page.metadata.createdAt,
      expiresAt: page.metadata.expiresAt,
    },
    200,
  );
}

export async function getPageContent(id: string, store: PageStore): Promise<Response> {
  const page = await findAvailablePage(id, store);
  if (!page.ok) {
    return new Response(page.error, { status: page.status, headers: htmlHeaders() });
  }

  const html = await store.getHtml(id);
  if (!html) {
    return new Response(PAGE_UNAVAILABLE_REASON.notFound, {
      status: 404,
      headers: htmlHeaders(),
    });
  }

  return new Response(html, { status: 200, headers: htmlHeaders() });
}

export async function deletePage(
  req: Request,
  id: string,
  store: PageStore,
  adminToken: string | undefined,
): Promise<Response> {
  const limit = await checkRateLimit(req, store, "failedDelete", id);
  if (!limit.ok) {
    return limit.response;
  }

  if (!adminToken) {
    return jsonError("Admin delete is not configured", 500);
  }

  const suppliedToken = bearerToken(req);
  if (!suppliedToken) {
    captureSecurityEvent("admin_delete_token_missing", "warning", {
      actor_hash: limit.actorHash,
      page_id: id,
    });
    return jsonError("Missing admin token", 401);
  }

  if (suppliedToken !== adminToken) {
    captureSecurityEvent("admin_delete_token_invalid", "warning", {
      actor_hash: limit.actorHash,
      page_id: id,
    });
    return jsonError("Invalid admin token", 403);
  }

  await resetRateLimit(store, "failedDelete", limit.actorHash, id);
  const metadata = await store.getMetadata(id);
  await store.deletePage(id, metadata?.expiresAt);

  return json({ deleted: true, id, existed: Boolean(metadata) }, 200);
}

async function findAvailablePage(
  id: string,
  store: PageStore,
): Promise<
  | { ok: true; metadata: PageMetadata }
  | { ok: false; status: 404 | 410; error: PageUnavailableReason }
> {
  const metadata = await store.getMetadata(id);
  if (!metadata) {
    return { ok: false, status: 404, error: PAGE_UNAVAILABLE_REASON.notFound };
  }

  if (isExpired(metadata.expiresAt)) {
    return { ok: false, status: 410, error: PAGE_UNAVAILABLE_REASON.gone };
  }

  return { ok: true, metadata };
}

function bearerToken(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isJsonRequest(req: Request): boolean {
  const contentType = req.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function parseJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function digestRequest(html: string, expirationHours: number): Promise<string> {
  const data = JSON.stringify({ html, expirationHours });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function resolveIdempotency(
  req: Request,
  store: PageStore,
  actorType: "anonymous" | "github",
  actorHash: string,
  digest: string,
): Promise<
  | { ok: true; key: string | null; record: IdempotencyRecord | null }
  | { ok: false; response: Response }
> {
  const supplied = req.headers.get("idempotency-key");
  if (supplied === null) return { ok: true, key: null, record: null };
  if (supplied.length < 1 || supplied.length > 200 || !/^[\x20-\x7E]+$/.test(supplied)) {
    return {
      ok: false,
      response: jsonError("Idempotency-Key must be 1-200 printable ASCII characters", 400),
    };
  }

  let keyHash: string;
  try {
    keyHash = await hashValue(`idempotency:${supplied}`);
  } catch {
    return { ok: false, response: jsonError("Rate limiting is not configured", 500) };
  }
  const key = idempotencyKey(actorHash, keyHash);
  let existing;
  try {
    existing = await store.getIdempotency(key);
  } catch {
    return {
      ok: false,
      response: jsonError("Idempotency is temporarily unavailable", 503, { "Retry-After": "2" }),
    };
  }
  if (!existing) return { ok: true, key, record: null };
  if (isExpired(existing.record.expiresAt)) {
    try {
      await store.deleteIdempotency(key);
    } catch {
      return {
        ok: false,
        response: jsonError("Idempotency is temporarily unavailable", 503, { "Retry-After": "2" }),
      };
    }
    return { ok: true, key, record: null };
  }
  if (existing.record.digest !== digest) {
    return { ok: false, response: idempotencyConflict(actorType, actorHash) };
  }
  return { ok: true, key, record: existing.record };
}

function resolvePublicBaseUrl(req: Request, configuredUrl: string | undefined): string | null {
  try {
    const url = new URL(configuredUrl ?? new URL(req.url).origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function idempotencyConflict(actorType: string, actorHash: string): Response {
  captureSecurityEvent("idempotency_conflict", "warning", {
    actor_type: actorType,
    actor_hash: actorHash,
  });
  return jsonError("Idempotency-Key was already used for a different request", 409);
}

async function compensatePage(store: PageStore, id: string, expiresAt: string): Promise<void> {
  try {
    await store.deletePage(id, expiresAt);
  } catch {
    captureSecurityEvent("storage_compensation_failure", "error", { stage: "idempotency" });
  }
}

function json<T>(
  body: T,
  status: number,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...additionalHeaders,
    },
  });
}

function jsonError(
  error = "Something went wrong",
  status: number,
  headers: Record<string, string> = {},
): Response {
  return json<ApiErrorResponse>({ error }, status, headers);
}

function htmlHeaders(): HeadersInit {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": buildUploadedPageHttpCsp(),
    "X-Content-Type-Options": "nosniff",
  };
}

function sameOriginPageUrl(value: string, requestUrl: string): { url: URL; pageId: string } | null {
  try {
    const url = new URL(value);
    const origin = new URL(requestUrl).origin;
    if (url.origin !== origin) {
      return null;
    }

    const match = url.pathname.match(/^\/p\/([^/]+)$/);
    const pageId = match?.[1];
    return pageId ? { url, pageId } : null;
  } catch {
    return null;
  }
}
