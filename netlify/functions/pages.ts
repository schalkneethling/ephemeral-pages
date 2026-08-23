import type { Config } from "@netlify/functions";

import { NETLIFY_EDGE_RATE_LIMIT } from "../../src/constants.ts";
import { injectCollaborationBootstrap } from "../../src/collaboration/bootstrap.ts";
import { buildCollaborativeUploadedPageHttpCsp, buildUploadedPageHttpCsp } from "../../src/csp.ts";
import {
  expirationDate,
  htmlByteLength,
  idempotencyKey,
  isExpired,
  PAGE_UNAVAILABLE_REASON,
  screenshotBudgetKey,
  type ApiErrorResponse,
  type CollaborationRole,
  type CreateCollaborationTicketRequest,
  type CreateCollaborationTicketResponse,
  type CreatePageRequest,
  type CreatePageResponse,
  type CreateScreenshotResponse,
  type PageUnavailableReason,
  type ScreenshotMetadata,
  validateExpirationHours,
} from "../../src/domain.ts";
import { pagePublicUrl, resolvePublicBaseUrl } from "../../src/public-url.ts";
import { matchApiRoute } from "../../src/routes.ts";
import {
  capabilityKeysFromEnv,
  collaborationWebSocketUrl,
  createEditorCapability,
  mintCollaborationTicket,
  ticketConfigurationFromEnv,
  verifyEditorCapability,
  type CapabilityKeys,
  type TicketConfiguration,
} from "./collaboration-auth.ts";
import {
  createCollaborationRoomDeletionNotifier,
  type CollaborationRoomDeletionNotifier,
} from "./collaboration-service.ts";
import { resolveUploadIdentity, verifyGitHubOidcToken } from "./github-oidc.ts";
import { decodeAndValidateHtml } from "./html-validation.ts";
import {
  createScreenshotCaptureClient,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_CAPTURE_TIMEOUT_MS,
  SCREENSHOT_DAILY_BUDGET,
  SCREENSHOT_PAGE_LIFETIME_BYTES,
  SCREENSHOT_PAGE_LIFETIME_COUNT,
  ScreenshotCaptureError,
  type ScreenshotCapture,
} from "./screenshot-capture.ts";
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
import {
  createPageStore,
  getStoredCollaborationSettings,
  type IdempotencyRecord,
  type PageStore,
  type ScreenshotStore,
  type StoredPageMetadata,
} from "./storage.ts";

export const config = {
  path: "/api/*",
  rateLimit: NETLIFY_EDGE_RATE_LIMIT,
} satisfies Config;

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
      case "create-collaboration-ticket":
        return await createCollaborationTicket(req, route.id, store);
      case "create-screenshot":
        return await createScreenshot(req, route.id, store);
      case "get-screenshot":
        return await getScreenshot(route.id, route.screenshotId, store);
      case "get-page":
        return await getPageMetadata(route.id, store);
      case "get-page-content":
        return await getPageContent(route.id, store);
      case "delete-page":
        return await deletePage(req, route.id, store, getAdminDeleteToken(), {
          notifyCollaborationDeleted:
            createCollaborationRoomDeletionNotifier({
              serviceUrl: getEnv("COLLABORATION_SERVICE_URL"),
              serviceToken: getEnv("COLLABORATION_SERVICE_TOKEN"),
            }) ?? undefined,
        });
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
    capabilityKeys?: CapabilityKeys;
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

  if (body.collaboration !== undefined && typeof body.collaboration !== "boolean") {
    return jsonError("Collaboration must be a boolean", 400);
  }
  const now = dependencies.now?.() ?? new Date();
  const collaborationEnabled = body.collaboration === true;
  const configuredCapabilityKeys = collaborationEnabled
    ? (dependencies.capabilityKeys ?? capabilityKeysFromEnv(getEnv, now))
    : undefined;
  if (collaborationEnabled && !configuredCapabilityKeys) {
    return jsonError("Collaboration is not configured", 503);
  }
  const capabilityKeys = configuredCapabilityKeys ?? undefined;

  const requestDigest = await digestRequest(
    html.value,
    expirationHours.value,
    collaborationEnabled,
  );
  const idempotency = await resolveIdempotency(req, store, actor.type, actorHash, requestDigest);
  if (!idempotency.ok) return idempotency.response;
  if (idempotency.record) {
    captureSecurityEvent("idempotency_hit", "info", {
      actor_type: actor.type,
      actor_hash: actorHash,
    });
    const replay = await hydrateCreateResponse(
      idempotency.record.response,
      store,
      capabilityKeys,
      now,
    );
    if (!replay) return jsonError("Collaboration is not configured", 503);
    return json(replay, 200, limit.headers);
  }

  const publicBaseUrl = resolvePublicBaseUrl(
    req,
    dependencies.publicBaseUrl ?? getEnv("PUBLIC_BASE_URL"),
  );
  if (!publicBaseUrl) {
    return jsonError("Public page URL is not configured correctly", 500);
  }

  const id = dependencies.createId?.() ?? crypto.randomUUID();
  const expiresAt = expirationDate(expirationHours.value, now);
  const storedHtml = collaborationEnabled ? injectCollaborationBootstrap(html.value) : html.value;
  const metadata: StoredPageMetadata = {
    id,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sizeBytes: htmlByteLength(storedHtml),
    ...(collaborationEnabled
      ? {
          collaboration: {
            enabled: true as const,
            capabilityVersion: capabilityKeys!.current.version,
          },
        }
      : {}),
  };

  await store.savePage(storedHtml, metadata);

  const viewUrl = pagePublicUrl(id, publicBaseUrl);
  const responseBody: CreatePageResponse = {
    id,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    url: viewUrl,
  };
  if (collaborationEnabled) {
    const capability = await createEditorCapability(
      id,
      metadata.expiresAt,
      capabilityKeys!.current,
    );
    responseBody.collaboration = {
      viewUrl,
      editUrl: `${viewUrl}#edit=${capability}`,
    };
  }

  if (idempotency.key) {
    const record: IdempotencyRecord = {
      digest: requestDigest,
      pageId: id,
      response: baseCreateResponse(responseBody),
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
      const replay = await hydrateCreateResponse(
        authoritative.record.response,
        store,
        capabilityKeys,
        now,
      );
      if (!replay) return jsonError("Collaboration is not configured", 503);
      return json(replay, 200, limit.headers);
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
      collaboration: getStoredCollaborationSettings(page.metadata)?.enabled === true,
    },
    200,
  );
}

export async function createCollaborationTicket(
  req: Request,
  id: string,
  store: PageStore,
  dependencies: {
    capabilityKeys?: CapabilityKeys;
    ticketConfiguration?: TicketConfiguration;
    now?: () => Date;
    createTicketId?: () => string;
  } = {},
): Promise<Response> {
  if (!isJsonRequest(req)) {
    return jsonError("Content-Type must be application/json", 415);
  }

  const body = await parseJson<CreateCollaborationTicketRequest>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("Request body must be valid JSON", 400);
  }
  if (body.capability !== undefined && typeof body.capability !== "string") {
    return jsonError("Capability must be a string", 400);
  }

  const now = dependencies.now?.() ?? new Date();
  const page = await findAvailablePage(id, store, now);
  if (!page.ok) return jsonError(page.error, page.status);
  const collaboration = getStoredCollaborationSettings(page.metadata);
  if (collaboration?.enabled !== true) {
    return jsonError("Collaboration is not enabled for this page", 409);
  }

  let role: CollaborationRole = "view";
  if (body.capability !== undefined) {
    const keys = dependencies.capabilityKeys ?? capabilityKeysFromEnv(getEnv, now);
    if (!keys) return jsonError("Collaboration is not configured", 503);
    const accepted = await verifyEditorCapability(
      body.capability,
      id,
      page.metadata.expiresAt,
      collaboration.capabilityVersion,
      keys,
      now,
    );
    if (!accepted) return jsonError("Invalid editor capability", 403);
    role = "edit";
  }

  const configuration = dependencies.ticketConfiguration ?? ticketConfigurationFromEnv(getEnv);
  if (!configuration) return jsonError("Collaboration is not configured", 503);

  const ticket = await mintCollaborationTicket({
    pageId: id,
    role,
    pageExpiresAt: new Date(page.metadata.expiresAt),
    configuration,
    now,
    ticketId: dependencies.createTicketId?.(),
  });
  return json<CreateCollaborationTicketResponse>(
    { ticket, websocketUrl: collaborationWebSocketUrl(configuration.websocketUrl, id), role },
    200,
  );
}

export async function createScreenshot(
  req: Request,
  id: string,
  store: PageStore & ScreenshotStore,
  dependencies: {
    capture?: ScreenshotCapture;
    now?: () => Date;
    createId?: () => string;
    timeoutMs?: number;
    dailyBudget?: number;
  } = {},
): Promise<Response> {
  if (!isJsonRequest(req)) return jsonError("Content-Type must be application/json", 415);
  const body = await parseJson<Record<string, unknown>>(req);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
    return jsonError("Screenshot request body must be an empty JSON object", 400);
  }
  if (!validResourceId(id)) return jsonError(PAGE_UNAVAILABLE_REASON.notFound, 404);

  const now = dependencies.now?.() ?? new Date();
  const page = await findAvailablePage(id, store, now);
  if (!page.ok) return jsonError(page.error, page.status);
  if (getStoredCollaborationSettings(page.metadata)?.enabled !== true) {
    return jsonError("Screenshots require a collaborative page", 409);
  }

  const limit = await checkRateLimit(req, store, "screenshot", id, now.getTime());
  if (!limit.ok) return limit.response;

  const capture =
    dependencies.capture ??
    createScreenshotCaptureClient({
      serviceUrl: getEnv("COLLABORATION_SERVICE_URL"),
      serviceToken: getEnv("COLLABORATION_SERVICE_TOKEN"),
    });
  if (!capture) return jsonError("Screenshot capture is not configured", 503);

  const screenshotId = dependencies.createId?.() ?? crypto.randomUUID();
  if (!validResourceId(screenshotId)) return jsonError("Screenshot identifier is invalid", 500);
  const timeoutMs = dependencies.timeoutMs ?? SCREENSHOT_CAPTURE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > SCREENSHOT_CAPTURE_TIMEOUT_MS
  ) {
    return jsonError("Screenshot timeout is invalid", 500);
  }

  const lock = await acquireScreenshotLock(store, id, screenshotId, now.getTime(), timeoutMs);
  if (!lock) return jsonError("A screenshot capture is already in progress", 409);

  try {
    let usage;
    try {
      usage = await store.getScreenshotUsage(id);
    } catch {
      captureSecurityEvent("screenshot_usage_unavailable", "error", { reason: "storage" });
      return jsonError("Screenshot limits are temporarily unavailable", 503, {
        "Retry-After": "60",
      });
    }
    if (
      usage.count >= SCREENSHOT_PAGE_LIFETIME_COUNT ||
      usage.totalBytes >= SCREENSHOT_PAGE_LIFETIME_BYTES
    ) {
      captureSecurityEvent("screenshot_page_budget_exhausted", "info", { reason: "lifetime" });
      return jsonError("This page has reached its screenshot limit", 409);
    }

    const dailyBudget = dependencies.dailyBudget ?? SCREENSHOT_DAILY_BUDGET;
    if (
      !Number.isSafeInteger(dailyBudget) ||
      dailyBudget < 1 ||
      dailyBudget > SCREENSHOT_DAILY_BUDGET
    ) {
      return jsonError("Screenshot budget is invalid", 500);
    }
    const budget = await claimDailyScreenshotBudget(store, now, dailyBudget);
    if (!budget.ok) {
      captureSecurityEvent("screenshot_daily_budget_rejected", "warning", {
        reason: budget.reason,
      });
      return jsonError("Daily screenshot capacity is unavailable", 503, {
        "Retry-After": String(budget.retryAfterSeconds),
      });
    }

    const captured = await captureWithTimeout(capture, id, page.metadata.expiresAt, timeoutMs);
    const capturedAt = new Date(captured.capturedAt);
    if (
      Number.isNaN(capturedAt.getTime()) ||
      capturedAt.toISOString() !== captured.capturedAt ||
      capturedAt < new Date(page.metadata.createdAt) ||
      capturedAt >= new Date(page.metadata.expiresAt) ||
      capturedAt.getTime() > now.getTime() + 5 * 60 * 1_000 ||
      !Number.isSafeInteger(captured.revision) ||
      captured.revision < 0 ||
      !validPng(captured.png)
    ) {
      return jsonError("Screenshot metadata is invalid", 502);
    }
    if (usage.totalBytes + captured.png.byteLength > SCREENSHOT_PAGE_LIFETIME_BYTES) {
      captureSecurityEvent("screenshot_page_budget_exhausted", "info", { reason: "bytes" });
      return jsonError("This page has reached its screenshot storage limit", 409);
    }

    const metadata: ScreenshotMetadata = {
      id: screenshotId,
      pageId: id,
      createdAt: captured.capturedAt,
      expiresAt: page.metadata.expiresAt,
      revision: captured.revision,
      sizeBytes: captured.png.byteLength,
    };
    await store.saveScreenshot(captured.png, metadata);
    const response: CreateScreenshotResponse = {
      ...metadata,
      url: `/api/pages/${encodeURIComponent(id)}/screenshots/${encodeURIComponent(screenshotId)}`,
    };
    return json(response, 201, limit.headers);
  } catch (error) {
    if (error instanceof ScreenshotTimeoutError) {
      return jsonError("Screenshot capture timed out", 504);
    }
    if (error instanceof ScreenshotCaptureError) {
      if (error.kind === "expired") return jsonError(PAGE_UNAVAILABLE_REASON.gone, 410);
      if (error.kind === "quota") {
        return jsonError("Screenshot capacity is temporarily exhausted", 503, {
          "Retry-After": "3600",
        });
      }
      return jsonError("Screenshot service returned an invalid response", 502);
    }
    throw error;
  } finally {
    await releaseScreenshotLock(store, id, screenshotId, lock.etag);
  }
}

async function claimDailyScreenshotBudget(
  store: ScreenshotStore,
  now: Date,
  limit: number,
): Promise<
  { ok: true } | { ok: false; reason: "exhausted" | "unavailable"; retryAfterSeconds: number }
> {
  const key = screenshotBudgetKey(now);
  const resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now.getTime()) / 1_000));
  try {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const existing = await store.getScreenshotBudget(key);
      if (
        existing &&
        (!Number.isSafeInteger(existing.record.count) ||
          existing.record.count < 0 ||
          existing.record.resetAt !== resetAt)
      ) {
        return { ok: false, reason: "unavailable", retryAfterSeconds: 60 };
      }
      const count = existing?.record.count ?? 0;
      if (count >= limit) return { ok: false, reason: "exhausted", retryAfterSeconds };

      const write = await store.setScreenshotBudget(
        key,
        { count: count + 1, resetAt },
        existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true },
      );
      if (write.modified) return { ok: true };
    }
  } catch {
    return { ok: false, reason: "unavailable", retryAfterSeconds: 60 };
  }
  return { ok: false, reason: "unavailable", retryAfterSeconds: 60 };
}

async function acquireScreenshotLock(
  store: ScreenshotStore,
  pageId: string,
  token: string,
  now: number,
  timeoutMs: number,
): Promise<{ etag: string } | null> {
  const existing = await store.getScreenshotLock(pageId);
  if (
    typeof existing?.record.expiresAt === "number" &&
    Number.isFinite(existing.record.expiresAt) &&
    existing.record.expiresAt > now
  ) {
    return null;
  }

  const write = await store.setScreenshotLock(
    pageId,
    { token, expiresAt: now + timeoutMs + 5_000 },
    existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true },
  );
  return write.modified && write.etag ? { etag: write.etag } : null;
}

async function releaseScreenshotLock(
  store: ScreenshotStore,
  pageId: string,
  token: string,
  etag: string,
): Promise<void> {
  try {
    await store.setScreenshotLock(pageId, { token, expiresAt: 0 }, { onlyIfMatch: etag });
  } catch (error) {
    captureException(error);
    captureSecurityEvent("screenshot_lock_release_failed", "warning", { reason: "storage" });
  }
}

class ScreenshotTimeoutError extends Error {}

async function captureWithTimeout(
  capture: ScreenshotCapture,
  pageId: string,
  pageExpiresAt: string,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new ScreenshotTimeoutError("Screenshot capture timed out"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([capture(pageId, pageExpiresAt, controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function validPng(png: ArrayBuffer): boolean {
  if (png.byteLength < 8 || png.byteLength > MAX_SCREENSHOT_BYTES) return false;
  const bytes = new Uint8Array(png, 0, 8);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((value, index) => bytes[index] === value);
}

function validResourceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export async function getScreenshot(
  pageId: string,
  screenshotId: string,
  store: PageStore & ScreenshotStore,
  now = new Date(),
): Promise<Response> {
  if (!validResourceId(pageId) || !validResourceId(screenshotId)) {
    return jsonError(PAGE_UNAVAILABLE_REASON.notFound, 404);
  }
  const page = await findAvailablePage(pageId, store, now);
  if (!page.ok) return jsonError(page.error, page.status);
  if (getStoredCollaborationSettings(page.metadata)?.enabled !== true) {
    return jsonError(PAGE_UNAVAILABLE_REASON.notFound, 404);
  }

  const metadata = await store.getScreenshotMetadata(pageId, screenshotId);
  if (
    !metadata ||
    metadata.id !== screenshotId ||
    metadata.pageId !== pageId ||
    metadata.expiresAt !== page.metadata.expiresAt ||
    isExpired(metadata.expiresAt, now)
  ) {
    return jsonError(PAGE_UNAVAILABLE_REASON.notFound, 404);
  }
  const png = await store.getScreenshotPng(pageId, screenshotId);
  if (!png || png.byteLength !== metadata.sizeBytes || !validPng(png)) {
    return jsonError(PAGE_UNAVAILABLE_REASON.notFound, 404);
  }

  return new Response(png, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      "Content-Disposition": `inline; filename="ephemeral-page-${pageId}-${screenshotId}.png"`,
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
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

  const collaboration = getStoredCollaborationSettings(page.metadata)?.enabled === true;
  return new Response(html, { status: 200, headers: htmlHeaders(collaboration) });
}

export async function deletePage(
  req: Request,
  id: string,
  store: PageStore,
  adminToken: string | undefined,
  dependencies: { notifyCollaborationDeleted?: CollaborationRoomDeletionNotifier } = {},
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

  if (
    metadata &&
    getStoredCollaborationSettings(metadata)?.enabled &&
    dependencies.notifyCollaborationDeleted
  ) {
    try {
      await dependencies.notifyCollaborationDeleted(id, metadata.expiresAt);
    } catch (error) {
      captureException(error);
      captureSecurityEvent("collaboration_room_deletion_failed", "error", { page_id: id });
    }
  }

  return json({ deleted: true, id, existed: Boolean(metadata) }, 200);
}

async function findAvailablePage(
  id: string,
  store: PageStore,
  now = new Date(),
): Promise<
  | { ok: true; metadata: StoredPageMetadata }
  | { ok: false; status: 404 | 410; error: PageUnavailableReason }
> {
  const metadata = await store.getMetadata(id);
  if (!metadata) {
    return { ok: false, status: 404, error: PAGE_UNAVAILABLE_REASON.notFound };
  }

  if (isExpired(metadata.expiresAt, now)) {
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

async function digestRequest(
  html: string,
  expirationHours: number,
  collaboration: boolean,
): Promise<string> {
  const data = JSON.stringify({ html, expirationHours, collaboration });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function baseCreateResponse(response: CreatePageResponse): IdempotencyRecord["response"] {
  return {
    id: response.id,
    createdAt: response.createdAt,
    expiresAt: response.expiresAt,
    url: response.url,
  };
}

async function hydrateCreateResponse(
  response: IdempotencyRecord["response"],
  store: PageStore,
  keys: CapabilityKeys | undefined,
  now: Date,
): Promise<CreatePageResponse | null> {
  const metadata = await store.getMetadata(response.id);
  if (!metadata) return response;
  const collaboration = getStoredCollaborationSettings(metadata);
  if (collaboration?.enabled !== true) return response;
  if (!keys) return null;

  const key =
    keys.current.version === collaboration.capabilityVersion
      ? keys.current
      : keys.previous?.version === collaboration.capabilityVersion
        ? keys.previous
        : undefined;
  if (!key) return null;
  if (keys.previous?.version === collaboration.capabilityVersion) {
    const validUntil = new Date(keys.previous.validUntil);
    if (Number.isNaN(validUntil.getTime()) || now >= validUntil) return null;
  }

  const capability = await createEditorCapability(response.id, metadata.expiresAt, key);
  return {
    ...response,
    collaboration: {
      viewUrl: response.url,
      editUrl: `${response.url}#edit=${capability}`,
    },
  };
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

function htmlHeaders(collaboration = false): HeadersInit {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": collaboration
      ? buildCollaborativeUploadedPageHttpCsp()
      : buildUploadedPageHttpCsp(),
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
