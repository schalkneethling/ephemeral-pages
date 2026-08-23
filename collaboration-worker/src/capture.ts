import { COLLABORATION_PROTOCOL_VERSION } from "../../src/collaboration/protocol.ts";
import { logError, logMetric } from "./metrics.ts";
import type { CaptureReservation, CollaborationRoom, FrozenCapture } from "./room.ts";

const CAPTURE_WIDTH = 1_440;
const CAPTURE_HEIGHT = 900;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const READY_SELECTOR = "#ephemeral-capture-ready";

export type CaptureRoomRpc = Pick<
  CollaborationRoom,
  "consumeCapture" | "createCapture" | "finishCapture"
>;

export type ScreenshotBrowser = {
  quickAction(action: "screenshot", options: BrowserRunScreenshotOptions): Promise<Response>;
};

export type CaptureConfiguration = {
  pageContentOrigin: string;
  publicWorkerOrigin: string;
};

export async function captureRoomScreenshot(
  roomId: string,
  room: CaptureRoomRpc,
  browser: ScreenshotBrowser,
  configuration: CaptureConfiguration,
): Promise<Response> {
  const origins = captureOrigins(configuration);
  if (!origins) return errorResponse("Capture service is misconfigured", 500);

  const reservation = await room.createCapture(roomId);
  if (!reservation.ok) return captureReservationError(reservation);

  logMetric("capture_accepted", {
    room_id: roomId,
    revision: reservation.revision,
  });

  try {
    const renderUrl = new URL(
      `/rooms/${encodeURIComponent(roomId)}/captures/${reservation.token}/render`,
      origins.publicWorker,
    );
    let screenshot: Response;
    try {
      screenshot = await browser.quickAction("screenshot", {
        url: renderUrl.href,
        viewport: {
          width: CAPTURE_WIDTH,
          height: CAPTURE_HEIGHT,
          deviceScaleFactor: 1,
        },
        gotoOptions: { timeout: 4_000, waitUntil: "domcontentloaded" },
        waitForSelector: { selector: READY_SELECTOR, timeout: 4_000 },
        actionTimeout: 2_000,
        cacheTTL: 0,
        screenshotOptions: {
          type: "png",
          encoding: "binary",
          fullPage: false,
          captureBeyondViewport: false,
        },
      });
    } catch {
      logMetric("capture_rejected", { room_id: roomId, reason: "browser_exception" });
      return errorResponse("Screenshot service is unavailable", 503);
    }

    const browserMilliseconds = readNonNegativeInteger(screenshot.headers.get("X-Browser-Ms-Used"));
    if (!screenshot.ok) {
      await cancelQuietly(screenshot.body);
      logMetric("capture_rejected", {
        room_id: roomId,
        reason: "browser_response",
        browser_status: screenshot.status,
        ...(browserMilliseconds === null ? {} : { browser_ms: browserMilliseconds }),
      });
      return errorResponse("Screenshot service is unavailable", 503, retryAfterHeader(screenshot));
    }
    if (!screenshot.headers.get("Content-Type")?.toLowerCase().startsWith("image/png")) {
      await cancelQuietly(screenshot.body);
      logMetric("capture_rejected", { room_id: roomId, reason: "invalid_content_type" });
      return errorResponse("Screenshot service is unavailable", 503);
    }

    const declaredLength = readNonNegativeInteger(screenshot.headers.get("Content-Length"));
    if (declaredLength !== null && declaredLength > MAX_CAPTURE_BYTES) {
      await cancelQuietly(screenshot.body);
      logMetric("capture_rejected", { room_id: roomId, reason: "output_too_large" });
      return errorResponse("Screenshot output exceeds the service limit", 503);
    }
    const output = await readBoundedBody(screenshot.body, MAX_CAPTURE_BYTES);
    if (!output.ok) {
      logMetric("capture_rejected", { room_id: roomId, reason: output.reason });
      return errorResponse(
        output.reason === "output_too_large"
          ? "Screenshot output exceeds the service limit"
          : "Screenshot service is unavailable",
        503,
      );
    }

    logMetric("capture_completed", {
      room_id: roomId,
      revision: reservation.revision,
      output_bytes: output.bytes.byteLength,
      ...(browserMilliseconds === null ? {} : { browser_ms: browserMilliseconds }),
    });
    return new Response(output.bytes, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "image/png",
        "Content-Length": String(output.bytes.byteLength),
        "X-Content-Type-Options": "nosniff",
        "X-Ephemeral-Capture-Revision": String(reservation.revision),
        "X-Ephemeral-Captured-At": reservation.capturedAt,
      },
    });
  } finally {
    try {
      await room.finishCapture(roomId, reservation.token);
    } catch (error) {
      logError("Failed to release capture lease", error);
    }
  }
}

export async function renderFrozenCapture(
  roomId: string,
  token: string,
  room: CaptureRoomRpc,
  pageContentOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const contentOrigin = configuredOrigin(pageContentOrigin);
  if (!contentOrigin) return errorResponse("Capture service is misconfigured", 500);

  const frozen = await room.consumeCapture(roomId, token);
  if (!frozen.ok) return frozenCaptureError(frozen);

  const contentUrl = new URL(`/api/pages/${encodeURIComponent(roomId)}/content`, contentOrigin);
  let contentResponse: Response;
  try {
    contentResponse = await fetchImpl(contentUrl, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/html" },
    });
  } catch {
    logMetric("capture_rejected", { room_id: roomId, reason: "trusted_fetch_exception" });
    return errorResponse("Page content is unavailable", 502);
  }
  const contentType = contentResponse.headers.get("Content-Type")?.toLowerCase() ?? "";
  await cancelQuietly(contentResponse.body);
  if (!contentResponse.ok || !contentType.startsWith("text/html")) {
    const status =
      contentResponse.status === 404 ? 404 : contentResponse.status === 410 ? 410 : 502;
    return errorResponse("Page content is unavailable", status);
  }

  logMetric("capture_rendered", {
    room_id: roomId,
    revision: frozen.revision,
  });
  return captureWrapperResponse(contentUrl, contentOrigin, frozen);
}

export function configuredOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function captureOrigins(configuration: CaptureConfiguration) {
  const pageContent = configuredOrigin(configuration.pageContentOrigin);
  const publicWorker = configuredOrigin(configuration.publicWorkerOrigin);
  return pageContent && publicWorker ? { pageContent, publicWorker } : null;
}

function captureReservationError(reservation: Exclude<CaptureReservation, { ok: true }>): Response {
  if (reservation.code === "capacity") {
    return errorResponse("A screenshot is already in progress", 429, { "Retry-After": "60" });
  }
  if (reservation.code === "not_initialized") {
    return errorResponse("Collaboration state is not initialized", 409);
  }
  return errorResponse("Room is unavailable", 410);
}

function frozenCaptureError(frozen: Exclude<FrozenCapture, { ok: true }>): Response {
  return frozen.code === "invalid"
    ? errorResponse("Capture token is invalid", 404)
    : errorResponse("Capture token is no longer available", 410);
}

function captureWrapperResponse(
  contentUrl: URL,
  contentOrigin: string,
  frozen: Extract<FrozenCapture, { ok: true }>,
): Response {
  const nonce = randomNonce();
  const snapshotState = serializeJsonForInlineScript(frozen.stateJson);
  const source = "ephemeral-collaboration";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ephemeral Pages capture</title>
  <style nonce="${nonce}">html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}iframe{display:block;width:100vw;height:100vh;border:0}</style>
  <script nonce="${nonce}">
  (() => {
    "use strict";
    const snapshot = { state: ${snapshotState}, revision: ${frozen.revision} };
    let delivered = false;
    window.__EPHEMERAL_CAPTURE_READY__ = false;
    window.addEventListener("message", (event) => {
      const frame = document.getElementById("capture-frame");
      if (delivered || !frame || event.source !== frame.contentWindow) return;
      const envelope = event.data;
      if (!envelope || envelope.source !== ${JSON.stringify(source)} || envelope.version !== ${COLLABORATION_PROTOCOL_VERSION} || envelope.direction !== "page-to-parent" || !envelope.message || envelope.message.type !== "sdk-ready") return;
      delivered = true;
      frame.contentWindow.postMessage({
        source: ${JSON.stringify(source)},
        version: ${COLLABORATION_PROTOCOL_VERSION},
        direction: "parent-to-page",
        message: { type: "snapshot", mode: "view", state: snapshot.state, revision: snapshot.revision }
      }, "*");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__EPHEMERAL_CAPTURE_READY__ = true;
        const marker = document.createElement("span");
        marker.id = "ephemeral-capture-ready";
        marker.hidden = true;
        document.body.append(marker);
      }));
    });
  })();
  </script>
</head>
<body>
  <iframe id="capture-frame" sandbox="allow-scripts" title="Frozen collaborative page" src="${escapeHtmlAttribute(contentUrl.href)}"></iframe>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        `frame-src ${contentOrigin}`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function serializeJsonForInlineScript(value: string): string {
  return value
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function readNonNegativeInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function retryAfterHeader(response: Response): HeadersInit | undefined {
  const value = response.headers.get("Retry-After");
  return value && /^\d+$/.test(value) ? { "Retry-After": value } : undefined;
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: "empty_output" | "output_read_failed" | "output_too_large" }
> {
  if (!body) return { ok: false, reason: "empty_output" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximumBytes - totalBytes) {
        await cancelReaderQuietly(reader);
        return { ok: false, reason: "output_too_large" };
      }
      if (value.byteLength > 0) {
        chunks.push(value);
        totalBytes += value.byteLength;
      }
    }
  } catch {
    await cancelReaderQuietly(reader);
    return { ok: false, reason: "output_read_failed" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) return { ok: false, reason: "empty_output" };
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

async function cancelQuietly(body: ReadableStream | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Cancellation is best effort; never surface an upstream exception containing its request URL.
  }
}

async function cancelReaderQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best effort; never surface an upstream exception containing its request URL.
  }
}

function errorResponse(message: string, status: number, headers?: HeadersInit): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...Object.fromEntries(new Headers(headers)),
      },
    },
  );
}
