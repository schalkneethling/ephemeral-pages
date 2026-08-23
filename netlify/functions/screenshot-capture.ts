export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
export const SCREENSHOT_CAPTURE_TIMEOUT_MS = 20_000;
export const SCREENSHOT_DAILY_BUDGET = 25;
export const SCREENSHOT_PAGE_LIFETIME_COUNT = 12;
export const SCREENSHOT_PAGE_LIFETIME_BYTES = 96 * 1024 * 1024;

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export type ScreenshotCaptureResult = {
  png: ArrayBuffer;
  revision: number;
  capturedAt: string;
};

export type ScreenshotCapture = (
  pageId: string,
  pageExpiresAt: string,
  signal: AbortSignal,
) => Promise<ScreenshotCaptureResult>;

export class ScreenshotCaptureError extends Error {
  readonly kind: "expired" | "quota" | "upstream" | "invalid_response";

  constructor(message: string, kind: "expired" | "quota" | "upstream" | "invalid_response") {
    super(message);
    this.name = "ScreenshotCaptureError";
    this.kind = kind;
  }
}

export function createScreenshotCaptureClient({
  serviceUrl,
  serviceToken,
  fetchImpl = fetch,
}: {
  serviceUrl: string | undefined;
  serviceToken: string | undefined;
  fetchImpl?: typeof fetch;
}): ScreenshotCapture | null {
  if (!serviceUrl || !serviceToken) return null;

  let baseUrl: URL;
  try {
    baseUrl = new URL(serviceUrl);
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.hash) {
      return null;
    }
  } catch {
    return null;
  }

  return async (pageId, pageExpiresAt, signal) => {
    const pageExpiry = Math.floor(new Date(pageExpiresAt).getTime() / 1_000);
    if (!Number.isSafeInteger(pageExpiry) || pageExpiry <= 0) {
      throw new ScreenshotCaptureError("Page expiry is invalid", "invalid_response");
    }

    const response = await fetchImpl(
      new URL(`/rooms/${encodeURIComponent(pageId)}/captures`, baseUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          "X-Ephemeral-Page-Expires-At": String(pageExpiry),
        },
        body: null,
        signal,
      },
    );
    if (!response.ok) {
      if (response.status === 410) {
        throw new ScreenshotCaptureError("Collaborative page has expired", "expired");
      }
      if (response.status === 429 || response.status === 503) {
        throw new ScreenshotCaptureError("Screenshot capacity is exhausted", "quota");
      }
      throw new ScreenshotCaptureError("Screenshot service request failed", "upstream");
    }

    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "image/png") {
      throw new ScreenshotCaptureError("Screenshot response is not a PNG", "invalid_response");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      response.headers.has("content-length") &&
      (!Number.isSafeInteger(declaredLength) ||
        declaredLength < PNG_SIGNATURE.length ||
        declaredLength > MAX_SCREENSHOT_BYTES)
    ) {
      throw new ScreenshotCaptureError("Screenshot response size is invalid", "invalid_response");
    }

    const revisionHeader = response.headers.get("X-Ephemeral-Capture-Revision");
    const revision = revisionHeader === null ? Number.NaN : Number(revisionHeader);
    const capturedAt = response.headers.get("X-Ephemeral-Captured-At");
    if (!Number.isSafeInteger(revision) || revision < 0 || !canonicalTimestamp(capturedAt)) {
      throw new ScreenshotCaptureError("Screenshot metadata is invalid", "invalid_response");
    }

    const png = await readBoundedBody(response, MAX_SCREENSHOT_BYTES);
    const bytes = new Uint8Array(png);
    if (
      bytes.byteLength < PNG_SIGNATURE.length ||
      bytes.byteLength > MAX_SCREENSHOT_BYTES ||
      !PNG_SIGNATURE.every((value, index) => bytes[index] === value)
    ) {
      throw new ScreenshotCaptureError("Screenshot PNG is invalid", "invalid_response");
    }

    return { png, revision, capturedAt: capturedAt! };
  };
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<ArrayBuffer> {
  if (!response.body) {
    throw new ScreenshotCaptureError("Screenshot response body is missing", "invalid_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ScreenshotCaptureError("Screenshot response is too large", "invalid_response");
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function canonicalTimestamp(value: string | null): value is string {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
