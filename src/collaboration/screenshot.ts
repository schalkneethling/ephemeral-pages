import { htmlIcon } from "../icons.ts";
import type { CreateScreenshotResponse } from "../domain.ts";

export type ScreenshotResponse = CreateScreenshotResponse;

export function setupScreenshotCapture(pageId: string): void {
  const button = document.querySelector<HTMLButtonElement>("#capture-page");
  const result = document.querySelector<HTMLElement>("#capture-result");
  const status = document.querySelector<HTMLElement>("#capture-message");
  const download = document.querySelector<HTMLAnchorElement>("#capture-download");
  if (!button || !result || !status || !download) return;

  let inFlight = false;
  const buttonHtml = button.innerHTML;
  button.hidden = false;

  button.addEventListener("click", async () => {
    if (inFlight) return;
    inFlight = true;
    button.disabled = true;
    button.innerHTML = `${htmlIcon("loader", "icon btn-icon icon-spin")} Capturing…`;
    result.hidden = false;
    status.hidden = false;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-busy", "true");
    delete status.dataset.state;
    status.textContent = "Capturing the current shared page…";
    download.hidden = true;
    download.removeAttribute("href");
    download.removeAttribute("download");
    download.textContent = "";
    let terminal = false;

    try {
      const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/screenshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      if (!response.ok) {
        const failure = captureFailure(response.status, response.headers.get("Retry-After"));
        terminal = failure.terminal;
        showCaptureError(status, failure.message);
        return;
      }

      const capture = validateScreenshotResponse(await response.json(), pageId);
      if (!capture) {
        showCaptureError(status, captureFailure(500, null).message);
        return;
      }

      const capturedAt = new Date(capture.createdAt);
      status.textContent = `Screenshot captured at ${capturedAt.toLocaleString()}. Revision ${capture.revision}.`;
      status.dataset.state = "success";
      download.href = capture.url;
      download.download = `ephemeral-page-${safeDownloadSegment(pageId)}-revision-${capture.revision}.png`;
      download.textContent = `Download screenshot (revision ${capture.revision})`;
      download.hidden = false;
    } catch {
      showCaptureError(status, captureFailure(500, null).message);
    } finally {
      inFlight = false;
      status.removeAttribute("aria-busy");
      button.innerHTML = buttonHtml;
      button.disabled = terminal;
    }
  });
}

export function captureFailure(
  responseStatus: number,
  retryAfter: string | null,
): { message: string; terminal: boolean } {
  if (responseStatus === 410) {
    return {
      message: "This page expired before the screenshot could be captured.",
      terminal: true,
    };
  }
  if (responseStatus === 429) {
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
    return {
      message: seconds
        ? `Too many screenshot requests. Try again in ${seconds} seconds.`
        : "Too many screenshot requests. Try again later.",
      terminal: false,
    };
  }
  if (responseStatus === 503) {
    return {
      message: "The daily screenshot quota is exhausted. Try again later.",
      terminal: false,
    };
  }
  return {
    message: "The screenshot could not be captured. Please try again.",
    terminal: false,
  };
}

export function validateScreenshotResponse(
  value: unknown,
  expectedPageId: string,
  origin = window.location.origin,
): ScreenshotResponse | null {
  if (!isRecord(value)) return null;
  const createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : NaN;
  const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.pageId !== expectedPageId ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.expiresAt) ||
    expiresAt < createdAt ||
    !isNonNegativeInteger(value.revision) ||
    !isNonNegativeInteger(value.sizeBytes) ||
    typeof value.url !== "string"
  ) {
    return null;
  }

  try {
    const url = new URL(value.url, origin);
    const expectedPath = `/api/pages/${encodeURIComponent(expectedPageId)}/screenshots/${encodeURIComponent(value.id)}`;
    if (
      url.origin !== origin ||
      url.pathname !== expectedPath ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return {
      id: value.id,
      pageId: value.pageId,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      revision: value.revision,
      sizeBytes: value.sizeBytes,
      url: url.href,
    };
  } catch {
    return null;
  }
}

function showCaptureError(status: HTMLElement, message: string) {
  status.setAttribute("role", "alert");
  status.setAttribute("aria-live", "assertive");
  status.dataset.state = "error";
  status.textContent = message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeDownloadSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "page";
}
