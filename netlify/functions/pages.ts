import type { Config } from "@netlify/functions";

import { buildUploadedPageHttpCsp } from "../../src/csp.ts";
import {
  expirationDate,
  htmlByteLength,
  isExpired,
  PAGE_UNAVAILABLE_REASON,
  type ApiErrorResponse,
  type CreatePageRequest,
  type CreatePageResponse,
  type PageMetadata,
  type PageUnavailableReason,
  validateExpirationHours,
} from "../../src/domain.ts";
import { matchApiRoute } from "../../src/routes.ts";
import { validateServerHtml } from "./html-validation.ts";
import {
  captureException,
  captureSecurityEvent,
  checkRateLimit,
  getAdminDeleteToken,
  initSentry,
  resetRateLimit,
} from "./security.ts";
import { createPageStore, type PageStore } from "./storage.ts";

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

export async function createPage(req: Request, store: PageStore): Promise<Response> {
  const limit = await checkRateLimit(req, store, "upload");
  if (!limit.ok) {
    return limit.response;
  }

  if (!isJsonRequest(req)) {
    return jsonError("Content-Type must be application/json", 415);
  }

  const body = await parseJson<CreatePageRequest>(req);
  if (!body) {
    return jsonError("Request body must be valid JSON", 400);
  }

  const html = validateServerHtml(body.html);
  if (!html.ok) {
    return jsonError(html.error, 400);
  }

  const expirationHours = validateExpirationHours(body.expirationHours);
  if (!expirationHours.ok) {
    return jsonError(expirationHours.error, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = expirationDate(expirationHours.value, now);
  const metadata: PageMetadata = {
    id,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sizeBytes: htmlByteLength(html.value),
  };

  await store.savePage(html.value, metadata);

  return json<CreatePageResponse>(
    {
      id,
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
      url: `/p/${id}`,
    },
    201,
  );
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
  return contentType?.toLowerCase().includes("application/json") ?? false;
}

async function parseJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function json<T>(body: T, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function jsonError(error = "Something went wrong", status: number): Response {
  return json<ApiErrorResponse>({ error }, status);
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
