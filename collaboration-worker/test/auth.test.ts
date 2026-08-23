import { describe, expect, it } from "vitest";

import type { CollaborationTicketClaims } from "../../src/collaboration/protocol.ts";
import {
  APPLICATION_PROTOCOL,
  extractTicketProtocol,
  isAllowedOrigin,
  verifyTicket,
} from "../src/auth.ts";

const SECRET = "test-secret-that-is-not-used-outside-tests";
const NOW = 1_800_000_000;

describe("collaboration ticket authorization", () => {
  it("extracts only the frozen two-protocol handshake", () => {
    expect(extractTicketProtocol(`${APPLICATION_PROTOCOL}, signed.ticket.value`)).toBe(
      "signed.ticket.value",
    );
    expect(extractTicketProtocol(`signed.ticket.value, ${APPLICATION_PROTOCOL}`)).toBeNull();
    expect(extractTicketProtocol(`${APPLICATION_PROTOCOL}, one, two`)).toBeNull();
  });

  it("accepts a valid HS256 ticket using protocol claim names", async () => {
    const token = await signTicket(validClaims());
    const result = await verifyTicket(token, SECRET, "ephemeral-pages-collaboration", NOW);
    expect(result).toEqual({ ok: true, claims: validClaims() });
  });

  it("rejects tampering, audience mismatch, expiry, and excessive lifetime", async () => {
    const token = await signTicket(validClaims());
    expect(
      await verifyTicket(`${token.slice(0, -1)}x`, SECRET, "ephemeral-pages-collaboration", NOW),
    ).toMatchObject({ ok: false });
    expect(await verifyTicket(token, SECRET, "another-audience", NOW)).toMatchObject({ ok: false });
    expect(
      await verifyTicket(
        await signTicket({ ...validClaims(), expiresAt: NOW }),
        SECRET,
        "ephemeral-pages-collaboration",
        NOW,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await verifyTicket(
        await signTicket({ ...validClaims(), expiresAt: NOW + 301 }),
        SECRET,
        "ephemeral-pages-collaboration",
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });

  it("uses exact origins and never accepts a wildcard", () => {
    expect(
      isAllowedOrigin("https://pages.example", "https://pages.example,https://preview.example"),
    ).toBe(true);
    expect(isAllowedOrigin("https://pages.example.evil", "https://pages.example")).toBe(false);
    expect(isAllowedOrigin("https://pages.example", "*")).toBe(false);
  });
});

function validClaims(): CollaborationTicketClaims {
  return {
    version: 1,
    roomId: "room_123",
    role: "edit",
    audience: "ephemeral-pages-collaboration",
    issuedAt: NOW - 1,
    expiresAt: NOW + 60,
    pageExpiresAt: NOW + 3_600,
    ticketId: "ticket_123",
  };
}

async function signTicket(claims: CollaborationTicketClaims): Promise<string> {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson(claims);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
