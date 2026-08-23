export const API_BASE = "/api";

export const MIN_HOURS = 1;
export const MAX_HOURS = 24 * 7;
export const DEFAULT_HOURS = 12;
export const MAX_RAW_HTML_BYTES = 20 * 1024 * 1024;
export const MAX_COMPRESSED_HTML_BYTES = 2 * 1024 * 1024;

export const ALLOWED_EXPIRATIONS: readonly ExpirationOption[] = [
  { hours: 1, label: "1 hour" },
  { hours: 3, label: "3 hours" },
  { hours: 5, label: "5 hours" },
  { hours: 7, label: "7 hours" },
  { hours: 12, label: "12 hours", default: true },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
  { hours: 120, label: "5 days" },
  { hours: 168, label: "7 days" },
] as const;

export type ExpirationOption = {
  hours: number;
  label: string;
  default?: boolean;
};

export type PageMetadata = {
  id: string;
  createdAt: string;
  expiresAt: string;
  sizeBytes: number;
  collaboration?: boolean;
};

export type CreatePageRequest = {
  html: string;
  expirationHours?: number;
  encoding?: "identity" | "br+base64";
  collaboration?: boolean;
};

export type CreatePageResponse = {
  id: string;
  createdAt: string;
  expiresAt: string;
  url: string;
  collaboration?: {
    viewUrl: string;
    editUrl: string;
  };
};

export type CollaborationRole = "view" | "edit";

export type CreateCollaborationTicketRequest = {
  capability?: string;
};

export type CreateCollaborationTicketResponse = {
  ticket: string;
  websocketUrl: string;
  role: CollaborationRole;
};

export type ScreenshotMetadata = {
  id: string;
  pageId: string;
  createdAt: string;
  expiresAt: string;
  revision: number;
  sizeBytes: number;
};

export type CreateScreenshotResponse = ScreenshotMetadata & {
  url: string;
};

export type ApiErrorResponse = {
  error: string;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const PAGE_UNAVAILABLE_REASON = Object.freeze({
  notFound: "Not found",
  gone: "Gone",
});

export type PageUnavailableReason =
  (typeof PAGE_UNAVAILABLE_REASON)[keyof typeof PAGE_UNAVAILABLE_REASON];

export const PAGE_PREFIX = "pages";
export const EXPIRES_PREFIX = "expires";
export const RATE_LIMIT_PREFIX = "rate-limits";
export const IDEMPOTENCY_PREFIX = "idempotency";
export const SCREENSHOT_BUDGET_PREFIX = "screenshot-budgets";

export function pageHtmlKey(id: string): string {
  return `${PAGE_PREFIX}/${id}/index.html`;
}

export function pageMetadataKey(id: string): string {
  return `${PAGE_PREFIX}/${id}/meta.json`;
}

export function screenshotPngKey(pageId: string, screenshotId: string): string {
  return `${PAGE_PREFIX}/${pageId}/screenshots/${screenshotId}.png`;
}

export function screenshotMetadataKey(pageId: string, screenshotId: string): string {
  return `${PAGE_PREFIX}/${pageId}/screenshots/${screenshotId}.json`;
}

export function screenshotPrefix(pageId: string): string {
  return `${PAGE_PREFIX}/${pageId}/screenshots/`;
}

export function screenshotLockKey(pageId: string): string {
  return `${screenshotPrefix(pageId)}_capture-lock.json`;
}

export function screenshotBudgetKey(now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `${SCREENSHOT_BUDGET_PREFIX}/${day}.json`;
}

export function expirationDate(hours: number, now = new Date()): Date {
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

export function expirationDayKey(expiresAt: Date): string {
  const yyyy = expiresAt.getUTCFullYear();
  const mm = String(expiresAt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(expiresAt.getUTCDate()).padStart(2, "0");
  return `${EXPIRES_PREFIX}/${yyyy}-${mm}-${dd}`;
}

export function expirationIndexKey(id: string, expiresAt: Date): string {
  return `${expirationDayKey(expiresAt)}/${id}.json`;
}

export function idempotencyKey(actorHash: string, keyHash: string): string {
  return `${IDEMPOTENCY_PREFIX}/${actorHash}/${keyHash}.json`;
}

export function validateExpirationHours(value: unknown): ValidationResult<number> {
  const hours = value === undefined ? DEFAULT_HOURS : value;

  if (typeof hours !== "number" || !Number.isFinite(hours)) {
    return { ok: false, error: "Invalid expiration value" };
  }

  if (!Number.isInteger(hours)) {
    return { ok: false, error: "Expiration must be a whole number of hours" };
  }

  if (hours < MIN_HOURS) {
    return { ok: false, error: `Expiration must be at least ${MIN_HOURS} hour(s)` };
  }

  if (hours > MAX_HOURS) {
    return { ok: false, error: `Expiration cannot exceed ${MAX_HOURS / 24} days` };
  }

  if (!ALLOWED_EXPIRATIONS.some((option) => option.hours === hours)) {
    return { ok: false, error: "Expiration must use one of the allowed options" };
  }

  return { ok: true, value: hours };
}

export function htmlByteLength(html: string): number {
  return new TextEncoder().encode(html).byteLength;
}

export function isExpired(expiresAt: string, now = new Date()): boolean {
  return now >= new Date(expiresAt);
}

export function mapUnavailableStatus(status: number): "expired" | "not-found" | null {
  if (status === 410) {
    return "expired";
  }

  if (status === 404) {
    return "not-found";
  }

  return null;
}
