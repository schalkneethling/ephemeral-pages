import * as Sentry from "@sentry/node";

import { RATE_LIMIT_PREFIX, type ApiErrorResponse } from "../../src/domain.ts";
import type { PageStore, RateLimitRecord } from "./storage.ts";

declare const Netlify:
  | {
      env: {
        get(name: string): string | undefined;
      };
    }
  | undefined;

// These define how many attempts are allowed per rate-limit
// window, and how long that window lasts.
export const RATE_LIMITS = {
  upload: { limit: 10, windowMs: 600000 },
  report: { limit: 10, windowMs: 600000 },
  failedDelete: { limit: 5, windowMs: 900000 },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

let sentryInitialized = false;

export function initSentry() {
  if (sentryInitialized) {
    return;
  }

  const dsn = getEnv("SENTRY_DSN");
  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment: getEnv("SENTRY_ENVIRONMENT") ?? "production",
    tracesSampleRate: 0,
  });
  sentryInitialized = true;
}

export function captureSecurityEvent(
  message: string,
  level: Sentry.SeverityLevel,
  tags: Record<string, string>,
) {
  initSentry();
  if (!sentryInitialized) {
    return;
  }

  Sentry.captureMessage(message, { level, tags });
}

export function captureException(error: unknown) {
  initSentry();
  if (!sentryInitialized) {
    return;
  }

  Sentry.captureException(error);
}

export async function checkRateLimit(
  req: Request,
  store: PageStore,
  name: RateLimitName,
  subject = "global",
  now = Date.now(),
): Promise<{ ok: true; actorHash: string } | { ok: false; actorHash: string; response: Response }> {
  const secret = getRateLimitSecret();
  if (!secret) {
    captureSecurityEvent("rate_limit_secret_missing", "error", { rate_limit: name });
    return {
      ok: false,
      actorHash: "unavailable",
      response: jsonError("Rate limiting is not configured", 500),
    };
  }

  const actorHash = await hashValue(`${clientIp(req)}:${userAgent(req)}`, secret);
  const subjectHash = await hashValue(subject, secret);
  const key = rateLimitKey(name, actorHash, subjectHash);
  const policy = RATE_LIMITS[name];
  const existing = await store.getRateLimit(key);
  const record = activeRecord(existing, now, policy.windowMs);

  if (record.count >= policy.limit) {
    captureSecurityEvent("rate_limit_exceeded", "warning", {
      rate_limit: name,
      actor_hash: actorHash,
      subject_hash: subjectHash,
    });
    return {
      ok: false,
      actorHash,
      response: jsonError("Too many requests. Please try again later.", 429),
    };
  }

  await store.setRateLimit(key, { count: record.count + 1, resetAt: record.resetAt });
  return { ok: true, actorHash };
}

export async function resetRateLimit(
  store: PageStore,
  name: RateLimitName,
  actorHash: string,
  subject: string,
) {
  const secret = getRateLimitSecret();
  if (!secret) {
    return;
  }

  const subjectHash = await hashValue(subject, secret);
  await store.deleteRateLimit(rateLimitKey(name, actorHash, subjectHash));
}

export function getEnv(name: string): string | undefined {
  if (typeof Netlify === "undefined") {
    return undefined;
  }

  return Netlify.env.get(name);
}

export function getAdminDeleteToken(): string | undefined {
  return getEnv("ADMIN_DELETE_TOKEN");
}

function getRateLimitSecret(): string | undefined {
  if (typeof Netlify === "undefined") {
    return "local-development-rate-limit-secret";
  }

  return Netlify.env.get("RATE_LIMIT_SECRET");
}

function activeRecord(
  existing: RateLimitRecord | null,
  now: number,
  windowMs: number,
): RateLimitRecord {
  if (!existing || existing.resetAt <= now) {
    return { count: 0, resetAt: now + windowMs };
  }

  return existing;
}

function rateLimitKey(name: RateLimitName, actorHash: string, subjectHash: string): string {
  return `${RATE_LIMIT_PREFIX}/${name}/${actorHash}/${subjectHash}.json`;
}

function clientIp(req: Request): string {
  // Netlify supplies this header in production; x-forwarded-for keeps local tests flexible.
  const directIp = req.headers.get("x-nf-client-connection-ip");
  if (directIp) {
    return directIp;
  }

  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown-ip";
}

function userAgent(req: Request): string {
  return req.headers.get("user-agent") || "unknown-user-agent";
}

async function hashValue(value: string, secret: string): Promise<string> {
  // Create a deterministic HMAC digest for rate-limit keys so raw IPs and user agents are never
  // stored in Netlify Blobs. We only need stable pseudonymous keys, so there is nothing to verify
  // later; each request recomputes the same signature and looks up the matching counter.
  // importKey(format, keyData, algorithm, extractable, keyUsages)
  // @see https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/importKey
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // sign(algorithm, key, data)
  // @see https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  // Convert the binary HMAC signature into a stable lowercase hex string so it is safe to use as
  // part of a deterministic Netlify Blobs key.
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error } satisfies ApiErrorResponse), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
