import { SignJWT } from "jose";

import { MAX_HOURS, type CollaborationRole } from "../../src/domain.ts";

export const COLLABORATION_TICKET_TTL_SECONDS = 60;
const CAPABILITY_CONTEXT = "ephemeral-pages:editor-capability";
const TICKET_ISSUER = "ephemeral-pages";

export type CapabilityKey = {
  version: string;
  secret: string;
};

export type CapabilityKeys = {
  current: CapabilityKey;
  previous?: CapabilityKey & { validUntil: string };
};

export type TicketConfiguration = {
  secret: string;
  audience: string;
  websocketUrl: string;
};

export function capabilityKeysFromEnv(
  getEnv: (name: string) => string | undefined,
  now = new Date(),
): CapabilityKeys | null {
  const current = readCapabilityKey(getEnv, "CURRENT");
  if (!current) return null;

  const previousVersion = getEnv("COLLABORATION_CAPABILITY_PREVIOUS_VERSION");
  const previousSecret = getEnv("COLLABORATION_CAPABILITY_PREVIOUS_SECRET");
  const previousValidUntil = getEnv("COLLABORATION_CAPABILITY_PREVIOUS_VALID_UNTIL");
  if (new Set([previousVersion, previousSecret, previousValidUntil].map(Boolean)).size > 1) {
    return null;
  }

  const previous =
    previousVersion && previousSecret && previousValidUntil
      ? validatePreviousCapabilityKey(
          { version: previousVersion, secret: previousSecret, validUntil: previousValidUntil },
          now,
        )
      : undefined;
  if (previousVersion && !previous) return null;
  if (previous?.version === current.version) return null;

  return { current, ...(previous ? { previous } : {}) };
}

export function ticketConfigurationFromEnv(
  getEnv: (name: string) => string | undefined,
): TicketConfiguration | null {
  const secret = getEnv("COLLABORATION_TICKET_SECRET");
  const audience = getEnv("COLLABORATION_TICKET_AUDIENCE");
  const websocketUrl = getEnv("COLLABORATION_WEBSOCKET_URL");
  if (!secret || encodedLength(secret) < 32 || !audience || !websocketUrl) return null;

  try {
    const url = new URL(websocketUrl);
    if (url.protocol !== "wss:" || url.username || url.password || url.hash) return null;
    return { secret, audience, websocketUrl: url.href };
  } catch {
    return null;
  }
}

export async function createEditorCapability(
  pageId: string,
  pageExpiresAt: string,
  key: CapabilityKey,
): Promise<string> {
  const signature = await signCapability(pageId, pageExpiresAt, key);
  return `${key.version}.${encodeBase64Url(signature)}`;
}

export async function verifyEditorCapability(
  capability: string,
  pageId: string,
  pageExpiresAt: string,
  capabilityVersion: string,
  keys: CapabilityKeys,
  now = new Date(),
): Promise<boolean> {
  const separator = capability.indexOf(".");
  if (separator < 1 || capability.indexOf(".", separator + 1) !== -1) return false;

  const version = capability.slice(0, separator);
  const suppliedSignature = decodeBase64Url(capability.slice(separator + 1));
  if (!suppliedSignature || version !== capabilityVersion) return false;

  const key =
    keys.current.version === version
      ? keys.current
      : keys.previous?.version === version
        ? keys.previous
        : undefined;
  if (!key) return false;
  if (keys.previous?.version === version) {
    const validUntil = new Date(keys.previous.validUntil);
    if (Number.isNaN(validUntil.getTime()) || now >= validUntil) return false;
  }

  const cryptoKey = await importCapabilityKey(key.secret, ["verify"]);
  return crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    suppliedSignature,
    capabilityMessage(pageId, pageExpiresAt, key.version),
  );
}

export async function mintCollaborationTicket({
  pageId,
  role,
  pageExpiresAt,
  configuration,
  now = new Date(),
  ticketId = crypto.randomUUID(),
}: {
  pageId: string;
  role: CollaborationRole;
  pageExpiresAt: Date;
  configuration: TicketConfiguration;
  now?: Date;
  ticketId?: string;
}): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const pageExpiry = Math.floor(pageExpiresAt.getTime() / 1000);
  const expiresAt = Math.min(issuedAt + COLLABORATION_TICKET_TTL_SECONDS, pageExpiry);
  if (expiresAt <= issuedAt) throw new Error("Cannot mint a ticket for an expired page");

  return new SignJWT({
    version: 1,
    roomId: pageId,
    role,
    audience: configuration.audience,
    issuedAt,
    expiresAt,
    pageExpiresAt: pageExpiry,
    ticketId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(TICKET_ISSUER)
    .setSubject(pageId)
    .setAudience(configuration.audience)
    .setJti(ticketId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(configuration.secret));
}

export function collaborationWebSocketUrl(baseUrl: string, pageId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/rooms/${encodeURIComponent(pageId)}/websocket`;
  url.search = "";
  return url.href;
}

function readCapabilityKey(
  getEnv: (name: string) => string | undefined,
  slot: "CURRENT",
): CapabilityKey | null {
  const version = getEnv(`COLLABORATION_CAPABILITY_${slot}_VERSION`);
  const secret = getEnv(`COLLABORATION_CAPABILITY_${slot}_SECRET`);
  return version && secret ? validateCapabilityKey({ version, secret }) : null;
}

function validateCapabilityKey(key: CapabilityKey): CapabilityKey | null {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(key.version) || encodedLength(key.secret) < 32) return null;
  return key;
}

function validatePreviousCapabilityKey(
  key: CapabilityKey & { validUntil: string },
  now: Date,
): (CapabilityKey & { validUntil: string }) | null {
  const validated = validateCapabilityKey(key);
  const validUntil = new Date(key.validUntil);
  const maximum = new Date(now.getTime() + MAX_HOURS * 60 * 60 * 1_000);
  if (
    !validated ||
    Number.isNaN(validUntil.getTime()) ||
    validUntil <= now ||
    validUntil > maximum
  ) {
    return null;
  }
  return { ...validated, validUntil: validUntil.toISOString() };
}

async function signCapability(
  pageId: string,
  pageExpiresAt: string,
  key: CapabilityKey,
): Promise<ArrayBuffer> {
  const cryptoKey = await importCapabilityKey(key.secret, ["sign"]);
  return crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    capabilityMessage(pageId, pageExpiresAt, key.version),
  );
}

function importCapabilityKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function capabilityMessage(
  pageId: string,
  pageExpiresAt: string,
  version: string,
): Uint8Array<ArrayBuffer> {
  const expiry = new Date(pageExpiresAt);
  if (Number.isNaN(expiry.getTime())) throw new Error("Page expiry is invalid");
  return new TextEncoder().encode(
    `${CAPABILITY_CONTEXT}:${version}:${pageId}:${expiry.toISOString()}`,
  );
}

function encodeBase64Url(value: ArrayBuffer): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 ? new Uint8Array(decoded) : null;
  } catch {
    return null;
  }
}

function encodedLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
