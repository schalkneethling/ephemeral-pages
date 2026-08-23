import {
  extractTicketProtocol,
  isAllowedOrigin,
  isValidRoomId,
  secureEqual,
  verifyTicket,
} from "./auth.ts";
import { captureRoomScreenshot, renderFrozenCapture } from "./capture.ts";
import { logError, logMetric } from "./metrics.ts";
import { CollaborationRoom, INTERNAL_ROOM_HEADERS } from "./room.ts";

export { CollaborationRoom };

const WEBSOCKET_PATH = /^\/rooms\/([A-Za-z0-9_-]{1,128})\/websocket$/;
const ROOM_PATH = /^\/rooms\/([A-Za-z0-9_-]{1,128})$/;
const CAPTURE_PATH = /^\/rooms\/([A-Za-z0-9_-]{1,128})\/captures$/;
const CAPTURE_RENDER_PATH =
  /^\/rooms\/([A-Za-z0-9_-]{1,128})\/captures\/([A-Za-z0-9_-]{43})\/render$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ status: "ok" }, { headers: noStoreHeaders() });
      }

      const websocketMatch = WEBSOCKET_PATH.exec(url.pathname);
      if (websocketMatch) return await connect(request, env, websocketMatch[1]);

      const captureMatch = CAPTURE_PATH.exec(url.pathname);
      if (captureMatch) return await capture(request, env, captureMatch[1]);

      const renderMatch = CAPTURE_RENDER_PATH.exec(url.pathname);
      if (renderMatch) return await renderCapture(request, env, renderMatch[1], renderMatch[2]);

      const roomMatch = ROOM_PATH.exec(url.pathname);
      if (request.method === "DELETE" && roomMatch) {
        return await deleteRoom(request, env, roomMatch[1]);
      }

      return errorResponse("Not found", 404);
    } catch (error) {
      logError("Unhandled collaboration Worker error", error);
      return errorResponse("Internal server error", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function connect(request: Request, env: Env, roomId: string): Promise<Response> {
  if (request.method !== "GET") return errorResponse("Method not allowed", 405, { Allow: "GET" });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse("Expected a WebSocket upgrade", 426, { Upgrade: "websocket" });
  }
  if (!isAllowedOrigin(request.headers.get("Origin"), env.ALLOWED_ORIGINS)) {
    logMetric("connection_rejected", { room_id: roomId, reason: "origin" });
    return errorResponse("Origin is not allowed", 403);
  }

  const ticket = extractTicketProtocol(request.headers.get("Sec-WebSocket-Protocol"));
  if (!ticket) {
    logMetric("ticket_rejected", { room_id: roomId, reason: "protocol" });
    return errorResponse("WebSocket protocols are invalid", 401);
  }
  const verification = await verifyTicket(ticket, env.TICKET_HMAC_SECRET, env.TICKET_AUDIENCE);
  if (!verification.ok) {
    logMetric("ticket_rejected", { room_id: roomId, reason: verification.reason });
    return errorResponse("Ticket is invalid", 401);
  }
  if (verification.claims.roomId !== roomId) {
    logMetric("ticket_rejected", { room_id: roomId, reason: "room_mismatch" });
    return errorResponse("Ticket room does not match the request", 403);
  }

  const internalHeaders = new Headers({
    Upgrade: "websocket",
    [INTERNAL_ROOM_HEADERS.roomId]: verification.claims.roomId,
    [INTERNAL_ROOM_HEADERS.role]: verification.claims.role,
    [INTERNAL_ROOM_HEADERS.ticketId]: verification.claims.ticketId,
    [INTERNAL_ROOM_HEADERS.ticketExpiresAt]: String(verification.claims.expiresAt),
    [INTERNAL_ROOM_HEADERS.pageExpiresAt]: String(verification.claims.pageExpiresAt),
  });
  const internalRequest = new Request("https://collaboration.internal/websocket", {
    method: "GET",
    headers: internalHeaders,
  });
  return env.COLLABORATION_ROOMS.getByName(roomId).fetch(internalRequest);
}

async function deleteRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  if (!isValidRoomId(roomId)) return errorResponse("Room id is invalid", 400);
  if (!(await hasValidAdminToken(request, env.ADMIN_TOKEN))) {
    return errorResponse("Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
  }

  const pageExpiresAt = Number(request.headers.get("X-Ephemeral-Page-Expires-At"));
  if (!Number.isSafeInteger(pageExpiresAt) || pageExpiresAt <= 0) {
    return errorResponse("X-Ephemeral-Page-Expires-At must be epoch seconds", 400);
  }
  await env.COLLABORATION_ROOMS.getByName(roomId).deleteRoom(roomId, pageExpiresAt);
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}

async function capture(request: Request, env: Env, roomId: string): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST") return errorResponse("Method not allowed", 405, { Allow: "POST" });
  if (url.search || request.body !== null) {
    return errorResponse("Capture requests must not include a query or body", 400);
  }
  if (!(await hasValidAdminToken(request, env.ADMIN_TOKEN))) {
    return errorResponse("Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
  }

  return captureRoomScreenshot(roomId, env.COLLABORATION_ROOMS.getByName(roomId), env.BROWSER, {
    pageContentOrigin: env.PAGE_CONTENT_ORIGIN,
    publicWorkerOrigin: env.PUBLIC_WORKER_ORIGIN,
  });
}

async function renderCapture(
  request: Request,
  env: Env,
  roomId: string,
  token: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") return errorResponse("Method not allowed", 405, { Allow: "GET" });
  if (url.search) return errorResponse("Capture render requests must not include a query", 400);
  return renderFrozenCapture(
    roomId,
    token,
    env.COLLABORATION_ROOMS.getByName(roomId),
    env.PAGE_CONTENT_ORIGIN,
  );
}

async function hasValidAdminToken(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  return Boolean(provided) && secureEqual(provided, expected);
}

function errorResponse(message: string, status: number, headers?: HeadersInit): Response {
  return Response.json(
    { error: message },
    { status, headers: { ...noStoreHeaders(), ...Object.fromEntries(new Headers(headers)) } },
  );
}

function noStoreHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
}
