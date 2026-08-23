import {
  COLLABORATION_PROTOCOL_VERSION,
  type CollaborationTicketClaims,
} from "../../src/collaboration/protocol.ts";

export const APPLICATION_PROTOCOL = "ephemeral-collaboration-v1";
const MAX_TICKET_BYTES = 4_096;
const MAX_TICKET_LIFETIME_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 30;

export type TicketVerificationResult =
  | { ok: true; claims: CollaborationTicketClaims }
  | { ok: false; reason: string };

export function extractTicketProtocol(header: string | null): string | null {
  if (!header) return null;
  const protocols = header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  if (protocols[0] !== APPLICATION_PROTOCOL || protocols.length !== 2) return null;
  return protocols[1];
}

export async function verifyTicket(
  token: string,
  secret: string,
  expectedAudience: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<TicketVerificationResult> {
  if (new TextEncoder().encode(token).byteLength > MAX_TICKET_BYTES) {
    return invalidTicket("Ticket is too large");
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return invalidTicket("Ticket is not a compact JWT");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: unknown;
  let signature: Uint8Array;
  try {
    header = decodeJson(encodedHeader);
    signature = decodeBase64Url(encodedSignature);
  } catch {
    return invalidTicket("Ticket encoding is invalid");
  }
  if (
    !isRecord(header) ||
    header.alg !== "HS256" ||
    (header.typ !== undefined && header.typ !== "JWT")
  ) {
    return invalidTicket("Ticket algorithm is invalid");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!signatureValid) return invalidTicket("Ticket signature is invalid");

  let payload: unknown;
  try {
    payload = decodeJson(encodedPayload);
  } catch {
    return invalidTicket("Ticket payload is invalid");
  }
  if (!isTicketClaims(payload)) return invalidTicket("Ticket claims are invalid");
  if (payload.version !== COLLABORATION_PROTOCOL_VERSION) {
    return invalidTicket("Ticket protocol version is unsupported");
  }
  if (payload.audience !== expectedAudience) return invalidTicket("Ticket audience is invalid");
  if (payload.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) {
    return invalidTicket("Ticket was issued in the future");
  }
  if (payload.issuedAt > payload.expiresAt) {
    return invalidTicket("Ticket expires before it was issued");
  }
  if (payload.expiresAt <= nowSeconds || payload.pageExpiresAt <= nowSeconds) {
    return invalidTicket("Ticket has expired");
  }
  if (payload.expiresAt > payload.pageExpiresAt) {
    return invalidTicket("Ticket outlives its page");
  }
  if (payload.expiresAt - payload.issuedAt > MAX_TICKET_LIFETIME_SECONDS) {
    return invalidTicket("Ticket lifetime is too long");
  }

  return { ok: true, claims: payload };
}

export function isAllowedOrigin(origin: string | null, allowlist: string): boolean {
  if (!origin) return false;
  return allowlist
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .some((allowed) => allowed !== "*" && allowed === origin);
}

export async function secureEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

export function isValidRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(roomId);
}

function isTicketClaims(value: unknown): value is CollaborationTicketClaims {
  return (
    isRecord(value) &&
    value.version === COLLABORATION_PROTOCOL_VERSION &&
    typeof value.roomId === "string" &&
    isValidRoomId(value.roomId) &&
    (value.role === "view" || value.role === "edit") &&
    typeof value.audience === "string" &&
    isEpochSeconds(value.issuedAt) &&
    isEpochSeconds(value.expiresAt) &&
    isEpochSeconds(value.pageExpiresAt) &&
    typeof value.ticketId === "string" &&
    value.ticketId.length > 0 &&
    value.ticketId.length <= 128
  );
}

function isEpochSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function decodeJson(value: string): unknown {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decodeBase64Url(value)),
  );
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTicket(reason: string): TicketVerificationResult {
  return { ok: false, reason };
}
